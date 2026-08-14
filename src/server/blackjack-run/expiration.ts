import {
	BLACKJACK_RUN_EXPIRATION_PAGE_SIZE,
	createBlackjackRunRepository,
	type BlackjackRunExpirationCursor,
} from './repository';
import { BlackjackRunServiceError } from './service';

export interface BlackjackRunExpirationDeps {
	expire(runId: string): Promise<unknown>;
	nowSeconds?: () => number;
	/** Wall-clock budget in milliseconds for a single invocation. Defaults to 25s. */
	timeBudgetMs?: number;
	/** Wall-clock provider for budget enforcement. Defaults to Date.now. */
	nowMs?: () => number;
	/** Terminal-result and failure event hook (runId is safe to log). */
	log?: (event: string, runId: string) => void;
	warn?: (message: string, error?: unknown) => void;
}

function currentEpochSeconds(): number {
	return Math.trunc(Date.now() / 1000);
}

function defaultLog(_event: string, _runId: string): void {
	// Quiet by default; the worker wires a warning-level logger.
}

function defaultWarn(message: string, error?: unknown): void {
	console.warn(message, error);
}

function isTerminalStatus(result: unknown): boolean {
	if (typeof result !== 'object' || result === null) return true;
	return (result as { status?: unknown }).status !== 'active';
}

// Cloudflare Workers scheduled handler CPU time is limited; use a conservative
// wall-clock budget so a single cron invocation drains as many expired runs
// as possible without risking a platform-enforced timeout.
const DEFAULT_TIME_BUDGET_MS = 25_000;

/**
 * Expire active blackjack runs whose expiresAt has passed. Stable
 * (expiresAt, id) cursor pagination: after each page, advance the cursor
 * past every row that was attempted (whether the attempt succeeded or
 * failed). This prevents unprocessable "poison" rows that remain active
 * from being returned by every subsequent page query and permanently
 * blocking later runs (head-of-line blocking). The cursor is scoped to a
 * single invocation; the next cron tick starts fresh so transient
 * settlement conflicts (the run stays active) get retried.
 */
export async function runBlackjackRunExpiration(
	db: D1Database,
	deps: BlackjackRunExpirationDeps,
): Promise<void> {
	const repository = createBlackjackRunRepository(db);
	const nowSeconds = (deps.nowSeconds ?? currentEpochSeconds)();
	const log = deps.log ?? defaultLog;
	const warn = deps.warn ?? defaultWarn;
	const nowMs = deps.nowMs ?? Date.now;
	const deadline = nowMs() + (deps.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
	const pageSize = BLACKJACK_RUN_EXPIRATION_PAGE_SIZE;

	let cursor: BlackjackRunExpirationCursor | null = null;

	for (;;) {
		const rows = await repository.listExpiredPage(nowSeconds, cursor, pageSize);
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
					log('blackjack_run_expired', row.id);
				}
			} catch (error) {
				if (error instanceof BlackjackRunServiceError && error.retryable) {
					// Transient settlement conflict: the run stays active and
					// the next invocation retries it. Warn, don't alert.
					warn(`[BLACKJACK_RUN] expiration skipped ${error.code} for run`, error);
				} else {
					log('blackjack_run_expiration_failed', row.id);
					warn('[BLACKJACK_RUN] unexpected expiration failure', error);
				}
			}
			// Advance past every attempted row regardless of outcome so
			// poison rows cannot starve later expirations.
			cursor = { expiresAt: row.expiresAt, id: row.id };
		}

		// Fewer than a full page means no more expired runs remain.
		if (rows.length < pageSize) break;
		// Respect the wall-clock budget.
		if (hitDeadline) break;
	}
}
