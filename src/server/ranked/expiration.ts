import { RankedServiceError } from '../../lib/ranked/protocol';
import { createRankedLogEntry, type RankedLogEntry } from './logging';
import { createRankedRepository } from './repository';

export interface RankedExpirationDeps {
	expire(sessionId: string): Promise<unknown>;
	nowSeconds?: () => number;
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

export async function runRankedExpiration(
	db: D1Database,
	deps: RankedExpirationDeps,
): Promise<void> {
	const repository = createRankedRepository(db);
	const nowSeconds = (deps.nowSeconds ?? currentEpochSeconds)();
	const sessionIds = await repository.listExpiredSessions(nowSeconds);
	const log = deps.log ?? defaultLog;
	const warn = deps.warn ?? ((message, error) => console.warn(message, error));

	for (const sessionId of sessionIds) {
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
		}
	}
}

export async function runRankedRateLimitCleanup(db: D1Database, nowSeconds: number): Promise<void> {
	await createRankedRepository(db).deleteExpiredRateBuckets(nowSeconds);
}
