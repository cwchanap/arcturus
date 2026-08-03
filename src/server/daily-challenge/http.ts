import type { APIRoute } from 'astro';
import {
	DAILY_CHALLENGE_ERROR_STATUS,
	DailyChallengeServiceError,
	dailyChallengeAttemptIdSchema,
	dailyChallengeCommandSchema,
	dailyChallengePeriodKeySchema,
	dailyChallengeStartRequestSchema,
	type DailyChallengeCommandV1,
	type DailyChallengeStartRequest,
} from '../../lib/daily-challenge/protocol';
import {
	buildRateLimitContinuationStatement,
	consumeStandaloneRateLimit,
	getRetryAfterSeconds,
} from '../ranked/rate-limit';
import {
	createDailyChallengeCoordinator,
	type DailyChallengeCoordinator,
	type DailyChallengeCoordinatorDeps,
} from './coordinator';
import { createDailyChallengeRepository } from './repository';

export interface DailyChallengeHttpCoordinatorBindings {
	db: D1Database;
}

export interface DailyChallengeHttpHandlerDeps {
	createCoordinator(bindings: DailyChallengeHttpCoordinatorBindings): DailyChallengeCoordinator;
}

export interface DailyChallengeHttpHandlers {
	current: APIRoute;
	detail: APIRoute;
	start: APIRoute;
	resume: APIRoute;
	command: APIRoute;
	leaderboard: APIRoute;
	history: APIRoute;
}

const PRIVATE_NO_STORE = 'private, no-store';
const LEADERBOARD_DEFAULT_LIMIT = 50;
const LEADERBOARD_MIN_LIMIT = 1;
const LEADERBOARD_MAX_LIMIT = 50;
const HISTORY_DEFAULT_LIMIT = 7;
const HISTORY_MIN_LIMIT = 1;
const HISTORY_MAX_LIMIT = 7;

type PublicCacheKind = 'live-detail' | 'closed-detail' | 'history' | 'leaderboard';

function publicCacheControl(kind: PublicCacheKind): string {
	switch (kind) {
		case 'live-detail':
		case 'history':
			return 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';
		case 'closed-detail':
			return 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800';
		case 'leaderboard':
			return 'public, max-age=0, s-maxage=15, stale-while-revalidate=60';
	}
}

interface JsonResponseOptions {
	status?: number;
	cacheControl: string;
	varyCookie?: boolean;
	retryAfter?: number;
}

function jsonResponse(body: unknown, options: JsonResponseOptions): Response {
	const headers = new Headers({
		'content-type': 'application/json',
		'cache-control': options.cacheControl,
	});
	if (options.varyCookie) headers.set('Vary', 'Cookie');
	if (options.retryAfter !== undefined) {
		headers.set('Retry-After', String(options.retryAfter));
	}
	return new Response(JSON.stringify(body), {
		status: options.status ?? 200,
		headers,
	});
}

export function dailyChallengeJsonError(error: unknown): Response {
	if (error instanceof DailyChallengeServiceError) {
		const headers = new Headers({
			'content-type': 'application/json',
			'cache-control': 'no-store',
		});
		if (error.retryAfter !== undefined) {
			headers.set('Retry-After', String(error.retryAfter));
		}
		return new Response(
			JSON.stringify({
				error: error.code,
				...(error.expectedSequence === undefined
					? {}
					: { expectedSequence: error.expectedSequence }),
			}),
			{ status: DAILY_CHALLENGE_ERROR_STATUS[error.code], headers },
		);
	}
	console.error('[DAILY_CHALLENGE] unhandled request failure:', error);
	return new Response(JSON.stringify({ error: 'INTERNAL_ERROR' }), {
		status: 500,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw new DailyChallengeServiceError('INVALID_REQUEST');
	}
}

function requireUser(locals: App.Locals): NonNullable<App.Locals['user']> {
	if (!locals.user) throw new DailyChallengeServiceError('UNAUTHORIZED');
	return locals.user;
}

function optionalUserId(locals: App.Locals): string | null {
	return locals.user?.id ?? null;
}

function parsePeriodKey(raw: string | undefined): string {
	const parsed = dailyChallengePeriodKeySchema.safeParse(raw);
	if (!parsed.success) throw new DailyChallengeServiceError('INVALID_REQUEST');
	const candidate = parsed.data;
	const epochMs = Date.parse(`${candidate}T00:00:00.000Z`);
	if (Number.isNaN(epochMs)) throw new DailyChallengeServiceError('INVALID_REQUEST');
	if (new Date(epochMs).toISOString().slice(0, 10) !== candidate) {
		throw new DailyChallengeServiceError('INVALID_REQUEST');
	}
	return candidate;
}

function parseAttemptId(raw: string | undefined): string {
	const parsed = dailyChallengeAttemptIdSchema.safeParse(raw);
	if (!parsed.success) throw new DailyChallengeServiceError('INVALID_REQUEST');
	return parsed.data;
}

function parseStartRequest(payload: unknown): DailyChallengeStartRequest {
	const parsed = dailyChallengeStartRequestSchema.safeParse(payload);
	if (parsed.success) return parsed.data;
	throw new DailyChallengeServiceError('INVALID_REQUEST');
}

function parseCommandBody(payload: unknown): DailyChallengeCommandV1 {
	const parsed = dailyChallengeCommandSchema.safeParse(payload);
	if (parsed.success) return parsed.data;
	const onlyWagerIssues =
		parsed.error.issues.length > 0 &&
		parsed.error.issues.every((issue) => issue.path[issue.path.length - 1] === 'wager');
	const hasNumericWager =
		typeof payload === 'object' &&
		payload !== null &&
		!Array.isArray(payload) &&
		typeof (payload as Record<string, unknown>).wager === 'number';
	if (onlyWagerIssues && hasNumericWager) {
		throw new DailyChallengeServiceError('INVALID_WAGER');
	}
	throw new DailyChallengeServiceError('INVALID_COMMAND');
}

function parseLimit(raw: string | null, min: number, max: number, defaultValue: number): number {
	if (raw === null) return defaultValue;
	if (!/^[0-9]+$/.test(raw)) throw new DailyChallengeServiceError('INVALID_REQUEST');
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new DailyChallengeServiceError('INVALID_REQUEST');
	}
	return value;
}

function coordinatorFor(
	deps: DailyChallengeHttpHandlerDeps,
	locals: App.Locals,
): DailyChallengeCoordinator {
	const db = locals.runtime?.env?.DB;
	if (!db) throw new DailyChallengeServiceError('INTERNAL_ERROR');
	return deps.createCoordinator({ db });
}

function renderReadResponse(body: unknown, kind: PublicCacheKind, userId: string | null): Response {
	const personalized = userId !== null;
	return jsonResponse(body, {
		cacheControl: personalized ? PRIVATE_NO_STORE : publicCacheControl(kind),
		varyCookie: true,
	});
}

export function createDailyChallengeHttpHandlers(
	deps: DailyChallengeHttpHandlerDeps,
): DailyChallengeHttpHandlers {
	const current: APIRoute = async ({ locals }) => {
		try {
			const userId = optionalUserId(locals);
			const coordinator = coordinatorFor(deps, locals);
			const response = await coordinator.getCurrent({ userId });
			return renderReadResponse(response, 'live-detail', userId);
		} catch (error) {
			return dailyChallengeJsonError(error);
		}
	};

	const detail: APIRoute = async ({ locals, params }) => {
		try {
			const userId = optionalUserId(locals);
			const periodKey = parsePeriodKey(params?.periodKey);
			const coordinator = coordinatorFor(deps, locals);
			const response = await coordinator.getByPeriod({ periodKey, userId });
			const closed = response.revealedRankedSeed !== null;
			return renderReadResponse(response, closed ? 'closed-detail' : 'live-detail', userId);
		} catch (error) {
			return dailyChallengeJsonError(error);
		}
	};

	const start: APIRoute = async ({ locals, request }) => {
		try {
			const user = requireUser(locals);
			const body = parseStartRequest(await readJson(request));
			const coordinator = coordinatorFor(deps, locals);
			const response = await coordinator.start({ userId: user.id, body });
			return jsonResponse(response, { cacheControl: PRIVATE_NO_STORE });
		} catch (error) {
			return dailyChallengeJsonError(error);
		}
	};

	const resume: APIRoute = async ({ locals, params }) => {
		try {
			const user = requireUser(locals);
			const attemptId = parseAttemptId(params?.attemptId);
			const coordinator = coordinatorFor(deps, locals);
			const response = await coordinator.resume({ userId: user.id, attemptId });
			return jsonResponse(response, { cacheControl: PRIVATE_NO_STORE });
		} catch (error) {
			return dailyChallengeJsonError(error);
		}
	};

	const command: APIRoute = async ({ locals, params, request }) => {
		try {
			const user = requireUser(locals);
			const attemptId = parseAttemptId(params?.attemptId);
			const body = parseCommandBody(await readJson(request));
			const coordinator = coordinatorFor(deps, locals);
			const response = await coordinator.command({ userId: user.id, attemptId, body });
			return jsonResponse(response, { cacheControl: PRIVATE_NO_STORE });
		} catch (error) {
			return dailyChallengeJsonError(error);
		}
	};

	const leaderboard: APIRoute = async ({ locals, params, url }) => {
		try {
			const userId = optionalUserId(locals);
			const periodKey = parsePeriodKey(params?.periodKey);
			const limit = parseLimit(
				url.searchParams.get('limit'),
				LEADERBOARD_MIN_LIMIT,
				LEADERBOARD_MAX_LIMIT,
				LEADERBOARD_DEFAULT_LIMIT,
			);
			const coordinator = coordinatorFor(deps, locals);
			const response = await coordinator.leaderboard({ periodKey, userId, limit });
			return renderReadResponse(response, 'leaderboard', userId);
		} catch (error) {
			return dailyChallengeJsonError(error);
		}
	};

	const history: APIRoute = async ({ locals, url }) => {
		try {
			const userId = optionalUserId(locals);
			const limit = parseLimit(
				url.searchParams.get('limit'),
				HISTORY_MIN_LIMIT,
				HISTORY_MAX_LIMIT,
				HISTORY_DEFAULT_LIMIT,
			);
			const coordinator = coordinatorFor(deps, locals);
			const response = await coordinator.history({ userId, limit });
			return renderReadResponse(response, 'history', userId);
		} catch (error) {
			return dailyChallengeJsonError(error);
		}
	};

	return { current, detail, start, resume, command, leaderboard, history };
}

export function createDailyChallengeStartRateLimiter(
	db: D1Database,
): DailyChallengeCoordinatorDeps['consumeStartRateLimit'] {
	return createDailyChallengeRateLimiter(db, 'daily_challenge_start', true);
}

export function createDailyChallengeCommandRateLimiter(
	db: D1Database,
): DailyChallengeCoordinatorDeps['consumeCommandRateLimit'] {
	return createDailyChallengeRateLimiter(db, 'daily_challenge_command', true);
}

export function createDailyChallengeResumeRateLimiter(
	db: D1Database,
): DailyChallengeCoordinatorDeps['consumeResumeRateLimit'] {
	return createDailyChallengeRateLimiter(db, 'daily_challenge_resume', false);
}

function createDailyChallengeRateLimiter(
	db: D1Database,
	operation: 'daily_challenge_start' | 'daily_challenge_command' | 'daily_challenge_resume',
	includeContinuation: boolean,
):
	| DailyChallengeCoordinatorDeps['consumeStartRateLimit']
	| DailyChallengeCoordinatorDeps['consumeCommandRateLimit']
	| DailyChallengeCoordinatorDeps['consumeResumeRateLimit'] {
	return async (userId, nowSeconds) => {
		const result = await consumeStandaloneRateLimit(db, userId, operation, nowSeconds);
		if (result.kind === 'rate-limited') {
			return { kind: 'rate-limited', retryAfter: result.retryAfter };
		}
		if (includeContinuation) {
			return {
				kind: 'allowed',
				statement: buildRateLimitContinuationStatement(db, {
					userId,
					operation,
					nowSeconds,
				}),
				retryAfter: getRetryAfterSeconds(operation, nowSeconds),
			};
		}
		return { kind: 'allowed' };
	};
}

export const dailyChallengeHttpHandlers = createDailyChallengeHttpHandlers({
	createCoordinator({ db }) {
		return createDailyChallengeCoordinator({
			repository: createDailyChallengeRepository(db),
			now: () => new Date(),
			randomBytes(length) {
				return crypto.getRandomValues(new Uint8Array(length));
			},
			log(entry) {
				console.warn('[DAILY_CHALLENGE]', entry);
			},
			consumeStartRateLimit: createDailyChallengeStartRateLimiter(db),
			consumeCommandRateLimit: createDailyChallengeCommandRateLimiter(db),
			consumeResumeRateLimit: createDailyChallengeResumeRateLimiter(db),
		});
	},
});
