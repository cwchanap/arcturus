import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { createDb } from '../../../lib/db';
import { user, chipSyncReceipt } from '../../../db/schema';

interface SettleEntry {
	userId: string;
	delta: number;
	syncId: string;
	gameType: 'poker_mp';
}

export const POST: APIRoute = async ({ request, locals }) => {
	const mpSecret = locals.runtime.env.MP_AUTH_SECRET;
	const auth = request.headers.get('x-arcturus-auth');
	if (!mpSecret || auth !== mpSecret) return new Response('Forbidden', { status: 403 });
	const body = (await request.json()) as { entries: SettleEntry[] };
	if (!Array.isArray(body.entries)) return new Response('Bad payload', { status: 400 });
	const db = createDb(locals.runtime.env.DB);

	for (const entry of body.entries) {
		const existing = await db
			.select({ syncId: chipSyncReceipt.syncId })
			.from(chipSyncReceipt)
			.where(eq(chipSyncReceipt.syncId, entry.syncId))
			.get();
		if (existing) continue;

		const row = await db.select().from(user).where(eq(user.id, entry.userId)).get();
		if (!row) continue;
		const previous = row.chipBalance;
		// Do NOT clamp to zero — the delta is derived from committed amounts
		// captured at hand start. Clamping would forgive losses and break
		// zero-sum settlement (winners credited full pot, losers pay less).
		const next = previous + entry.delta;

		await db
			.update(user)
			.set({ chipBalance: next, updatedAt: new Date() })
			.where(eq(user.id, entry.userId))
			.run();

		await db
			.insert(chipSyncReceipt)
			.values({
				userId: entry.userId,
				syncId: entry.syncId,
				gameType: entry.gameType,
				previousBalance: previous,
				balance: next,
				delta: entry.delta,
				statsDelta: null,
				outcome: entry.delta > 0 ? 'win' : entry.delta < 0 ? 'loss' : 'push',
				handCount: 1,
				winsIncrement: entry.delta > 0 ? 1 : 0,
				lossesIncrement: entry.delta < 0 ? 1 : 0,
				biggestWinCandidate: entry.delta > 0 ? entry.delta : 0,
				overallRank: null,
				achievementPayload: null,
				createdAt: new Date(),
			})
			.run();
	}

	return new Response(JSON.stringify({ ok: true }), {
		headers: { 'content-type': 'application/json' },
	});
};
