import type { APIRoute } from 'astro';

interface SettleEntry {
	userId: string;
	delta: number;
	syncId: string;
	gameType: 'poker_mp';
}

function makeReceiptBind(
	d1: D1Database,
	entry: SettleEntry,
	previousBalance: number,
	newBalance: number,
	outcome: string,
	nowSeconds: number,
) {
	return d1
		.prepare(
			`INSERT INTO chip_sync_receipt (userId, syncId, gameType, previousBalance, balance, delta, statsDelta, outcome, handCount, winsIncrement, lossesIncrement, biggestWinCandidate, overallRank, achievementPayload, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			entry.userId,
			entry.syncId,
			entry.gameType,
			previousBalance,
			newBalance,
			entry.delta,
			null, // statsDelta
			outcome,
			1, // handCount
			entry.delta > 0 ? 1 : 0, // winsIncrement
			entry.delta < 0 ? 1 : 0, // lossesIncrement
			entry.delta > 0 ? entry.delta : 0, // biggestWinCandidate
			null, // overallRank
			null, // achievementPayload
			nowSeconds,
		);
}

function isValidEntry(e: unknown): e is SettleEntry {
	if (typeof e !== 'object' || e === null) return false;
	const obj = e as Record<string, unknown>;
	return (
		typeof obj.userId === 'string' &&
		obj.userId.trim().length > 0 &&
		typeof obj.delta === 'number' &&
		Number.isFinite(obj.delta) &&
		Number.isInteger(obj.delta) &&
		typeof obj.syncId === 'string' &&
		obj.syncId.trim().length > 0 &&
		obj.gameType === 'poker_mp'
	);
}

export const POST: APIRoute = async ({ request, locals }) => {
	const mpSecret = locals.runtime.env.MP_AUTH_SECRET;
	const auth = request.headers.get('x-arcturus-auth');
	if (!mpSecret || auth !== mpSecret) return new Response('Forbidden', { status: 403 });

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return new Response('Malformed JSON', { status: 400 });
	}

	if (
		!body ||
		typeof body !== 'object' ||
		!Array.isArray((body as Record<string, unknown>).entries) ||
		!(body as Record<string, unknown>).entries.every(isValidEntry)
	) {
		return new Response('Bad payload', { status: 400 });
	}
	const entries = (body as { entries: SettleEntry[] }).entries;

	// Reject duplicate userIds — a single settle batch must contain at most
	// one entry per user.  Multiple entries for the same user would produce
	// incorrect receipts because the second entry's previousBalance is
	// computed from stale data before the first entry's UPDATE applies.
	const seenUserIds = new Set<string>();
	for (const e of entries) {
		if (seenUserIds.has(e.userId)) {
			return new Response('Duplicate userId in entries', { status: 400 });
		}
		seenUserIds.add(e.userId);
	}

	// Deduplicate within payload — multiple entries with same userId+syncId
	// would bypass the DB idempotency check (neither exists yet) and double-apply.
	const seen = new Set<string>();
	const dedupedEntries = entries.filter((e) => {
		const key = `${e.userId}:${e.syncId}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});

	const d1 = locals.runtime.env.DB;

	// Filter out already-processed entries FIRST (idempotency via composite PK userId+syncId).
	// Must run before escrow checks so retries of already-committed batches don't fail.
	const newEntries: SettleEntry[] = [];
	if (dedupedEntries.length > 0) {
		const idempotencyChecks = dedupedEntries.map((e) =>
			d1
				.prepare(`SELECT syncId FROM chip_sync_receipt WHERE userId = ? AND syncId = ?`)
				.bind(e.userId, e.syncId),
		);
		const existingResults = await d1.batch(idempotencyChecks);
		for (let i = 0; i < dedupedEntries.length; i++) {
			const rows = existingResults[i].results as { syncId: string }[] | undefined;
			if (!rows || rows.length === 0) {
				newEntries.push(dedupedEntries[i]);
			}
		}
	}

	if (newEntries.length === 0) {
		return new Response(JSON.stringify({ ok: true }), {
			headers: { 'content-type': 'application/json' },
		});
	}

	// Fetch current chipBalance + heldChips for all new entries to compute
	// previousBalance and verify escrow exists.
	//
	// NOTE: previousBalance uses the SELECT-time snapshot, not an at-UPDATE
	// read.  This is safe because the membership lock guarantees heldChips
	// only changes in this code path — no other handler mutates heldChips
	// while the user holds a membership row for a room.  Under that
	// invariant, the SELECT and UPDATE see the same chipBalance+heldChips.
	const balanceFetches = newEntries.map((e) =>
		d1.prepare(`SELECT chipBalance, heldChips FROM user WHERE id = ?`).bind(e.userId),
	);
	const balanceResults = await d1.batch(balanceFetches);
	const currentBalances = new Map<string, number>();
	const heldChipsMap = new Map<string, number>();
	for (let i = 0; i < newEntries.length; i++) {
		const row = balanceResults[i].results?.[0] as
			| { chipBalance: number; heldChips: number }
			| undefined;
		currentBalances.set(newEntries[i].userId, row?.chipBalance ?? 0);
		heldChipsMap.set(newEntries[i].userId, row?.heldChips ?? 0);
	}

	const nowSeconds = Math.trunc(Date.now() / 1000);

	// ── Settle against escrowed chips ──────────────────────────────────────
	// Chips were escrowed at snapshot time (chipBalance → heldChips).  Now we
	// release the escrow and apply the net delta in one step:
	//   chipBalance = chipBalance + heldChips + delta
	//   heldChips   = 0
	//
	// This handler does not enforce heldChips >= |delta| or otherwise prevent
	// chipBalance from going negative; it relies on upstream game-state
	// invariants (buy-in equals escrowed amount, committed <= buy-in) to make
	// settlement amounts valid.  Removing the old insufficient_balance rejection
	// avoids freezing rooms when a player spent chips elsewhere mid-hand, but
	// does not by itself guarantee a non-negative post-settlement balance.
	//
	// All entries (debits AND credits) are settled in a single atomic batch
	// so there is no window where some players are settled but others aren't.
	const settleStatements = newEntries.flatMap((entry) => {
		const chipBalance = currentBalances.get(entry.userId) ?? 0;
		const held = heldChipsMap.get(entry.userId) ?? 0;
		// The player's true pre-settlement balance includes both available chips
		// and escrowed chips. Using chipBalance alone (often 0 post-snapshot)
		// would break the receipt invariant: previousBalance + delta === balance.
		const previousBalance = chipBalance + held;
		const newBalance = previousBalance + entry.delta;
		const outcome = entry.delta > 0 ? 'win' : entry.delta < 0 ? 'loss' : 'push';
		return [
			d1
				.prepare(
					`UPDATE user SET chipBalance = chipBalance + heldChips + ?, heldChips = 0, updatedAt = ? WHERE id = ?`,
				)
				.bind(entry.delta, nowSeconds, entry.userId),
			makeReceiptBind(d1, entry, previousBalance, newBalance, outcome, nowSeconds),
		];
	});

	await d1.batch(settleStatements);

	return new Response(JSON.stringify({ ok: true }), {
		headers: { 'content-type': 'application/json' },
	});
};
