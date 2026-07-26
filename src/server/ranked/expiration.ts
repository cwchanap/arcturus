import { RankedServiceError } from '../../lib/ranked/protocol';
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

const EXPECTED_EXPIRATION_ERRORS = new Set(['MULTIPLAYER_CONFLICT', 'MULTIPLAYER_ESCROW_ORPHANED']);

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

	// Sessions that failed expiration in this invocation are tracked so we
	// don't retry them in the next page (they'd be returned again because
	// they remain active). If every ID in a page is skipped, the remaining
	// unprocessable sessions are left for the next cron tick.
	const skipped = new Set<string>();

	for (;;) {
		const sessionIds = await repository.listExpiredSessions(nowSeconds);
		if (sessionIds.length === 0) break;

		for (const sessionId of sessionIds) {
			if (skipped.has(sessionId)) continue;
			try {
				const result = await deps.expire(sessionId);
				if (isTerminalStatus(result)) {
					log(createRankedLogEntry('ranked_session_expired', { sessionId }));
				}
			} catch (error) {
				if (error instanceof RankedServiceError && EXPECTED_EXPIRATION_ERRORS.has(error.code)) {
					warn(`[RANKED] expiration skipped ${error.code} for session`, error);
				} else {
					log(createRankedLogEntry('ranked_invariant_violation', { sessionId }));
					warn('[RANKED] unexpected expiration failure', error);
				}
				skipped.add(sessionId);
			}
		}

		// Fewer than a full page means no more expired sessions remain.
		if (sessionIds.length < RANKED_EXPIRATION_PAGE_SIZE) break;
		// If every ID in this page was skipped, the query will keep returning
		// the same unprocessable sessions. Stop to avoid a busy loop.
		if (sessionIds.every((id) => skipped.has(id))) break;
		// Respect the wall-clock budget.
		if (nowMs() >= deadline) break;
	}
}

export async function runRankedRateLimitCleanup(db: D1Database, nowSeconds: number): Promise<void> {
	await createRankedRepository(db).deleteExpiredRateBuckets(nowSeconds);
}
