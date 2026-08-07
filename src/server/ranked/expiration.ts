import { RankedServiceError, type RankedErrorCode } from '../../lib/ranked/protocol';
import { createRankedLogEntry, type RankedLogEntry } from './logging';
import { createRankedRepository, RANKED_EXPIRATION_PAGE_SIZE } from './repository';

export interface RankedExpirationDeps {
	expire(sessionId: string): Promise<unknown>;
	nowSeconds?: () => number;
	/** Wall-clock budget in milliseconds for a single invocation. Defaults to 25s. */
	timeBudgetMs?: number;
	/** Wall-clock provider for budget enforcement. Defaults to Date.now. */
	nowMs?: () => number;
	log?: (entry: RankedLogEntry) => void;
	warn?: (message: string, error?: unknown) => void;
}

function currentEpochSeconds(): number {
	return Math.trunc(Date.now() / 1000);
}

function defaultLog(entry: RankedLogEntry): void {
	console.warn('[RANKED]', entry);
}

function isTerminalStatus(result: unknown): boolean {
	if (typeof result !== 'object' || result === null) return true;
	const status = (result as { status?: unknown }).status;
	return status === 'expired' || status === 'settled';
}

// ACCOUNT_BALANCE_CHANGED is expected during scheduled expiration because
// concurrent casual play can change the user's chipBalance between the
// expiration retry snapshots. The expireOwned retry loop throws it only
// after SNAPSHOT_ATTEMPTS retries are exhausted, which is a benign balance
// race on the money path — not an invariant violation that should noise up
// alerting. The session remains active and the next cron tick retries.
const EXPECTED_EXPIRATION_ERRORS: Set<RankedErrorCode> = new Set<RankedErrorCode>([
	'ACCOUNT_BALANCE_CHANGED',
]);

// Cloudflare Workers scheduled handler CPU time is limited; use a conservative
// wall-clock budget so a single cron invocation drains as many expired
// sessions as possible without risking a platform-enforced timeout.
const DEFAULT_TIME_BUDGET_MS = 25_000;

export async function runRankedExpiration(
	db: D1Database,
	deps: RankedExpirationDeps,
): Promise<void> {
	const repository = createRankedRepository(db);
	const nowSeconds = (deps.nowSeconds ?? currentEpochSeconds)();
	const log = deps.log ?? defaultLog;
	const warn = deps.warn ?? ((message, error) => console.warn(message, error));
	const nowMs = deps.nowMs ?? Date.now;
	const deadline = nowMs() + (deps.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);

	// Stable cursor pagination: after each page, advance the cursor past
	// every row that was attempted (whether the attempt succeeded or
	// failed). This prevents unprocessable "poison" rows that remain active
	// from being returned by every subsequent page query and permanently
	// blocking later sessions (head-of-line blocking). The cursor is scoped
	// to a single invocation; the next cron tick starts fresh so transient
	// transient balance races get retried.
	let cursor: { expiresAt: number; id: string } | null = null;

	for (;;) {
		const rows = await repository.listExpiredSessions(nowSeconds, cursor);
		if (rows.length === 0) break;

		let hitDeadline = false;
		for (const row of rows) {
			// Check the deadline before each expiration so a slow page cannot
			// blow the entire budget before the guard runs.
			if (nowMs() >= deadline) {
				hitDeadline = true;
				break;
			}
			try {
				const result = await deps.expire(row.id);
				if (isTerminalStatus(result)) {
					log(createRankedLogEntry('ranked_session_expired', { sessionId: row.id }));
				}
			} catch (error) {
				if (error instanceof RankedServiceError && EXPECTED_EXPIRATION_ERRORS.has(error.code)) {
					warn(`[RANKED] expiration skipped ${error.code} for session`, error);
				} else {
					log(createRankedLogEntry('ranked_invariant_violation', { sessionId: row.id }));
					warn('[RANKED] unexpected expiration failure', error);
				}
			}
			// Advance past every attempted row regardless of outcome so
			// poison rows cannot starve later expirations.
			cursor = { expiresAt: row.expiresAt, id: row.id };
		}

		// Fewer than a full page means no more expired sessions remain.
		if (rows.length < RANKED_EXPIRATION_PAGE_SIZE) break;
		// Respect the wall-clock budget.
		if (hitDeadline) break;
	}
}

export async function runRankedRateLimitCleanup(db: D1Database, nowSeconds: number): Promise<void> {
	await createRankedRepository(db).deleteExpiredRateBuckets(nowSeconds);
}
