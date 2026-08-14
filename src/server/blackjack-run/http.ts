import type { APIRoute } from 'astro';
import {
	BlackjackRunError,
	blackjackRunCommandSchema,
	blackjackRunStartSchema,
	periodKeySchema,
	runIdSchema,
	type BlackjackRunErrorCode,
	type BlackjackRunStart,
} from '../../lib/blackjack-run/protocol';
import { createBlackjackRunRepository } from './repository';
import {
	BlackjackRunServiceError,
	createBlackjackRunService,
	type BlackjackRunService,
	type BlackjackRunServiceErrorCode,
} from './service';

export interface BlackjackRunHttpBindings {
	db: D1Database;
}

export interface BlackjackRunHttpHandlerDeps {
	createService(bindings: BlackjackRunHttpBindings): BlackjackRunService;
}

export interface BlackjackRunHttpHandlers {
	start: APIRoute;
	current: APIRoute;
	get: APIRoute;
	command: APIRoute;
	currentDaily: APIRoute;
	leaderboard: APIRoute;
}

export type BlackjackRunHttpErrorCode = BlackjackRunServiceErrorCode | BlackjackRunErrorCode;

export const BLACKJACK_RUN_ERROR_STATUS: Record<BlackjackRunHttpErrorCode, number> = {
	// Service errors.
	RUN_NOT_FOUND: 404,
	ACTIVE_RUN_EXISTS: 409,
	IDENTIFIER_REUSE_MISMATCH: 409,
	INSUFFICIENT_BALANCE: 409,
	INVALID_REQUEST: 400,
	SETTLEMENT_CONFLICT: 409,
	INTERNAL_ERROR: 500,
	UNAUTHORIZED: 401,
	// Pure-core domain errors surfaced by the service.
	INVALID_ACTION: 400,
	SEQUENCE_MISMATCH: 409,
	ATTEMPT_COMPLETE: 409,
	INVALID_COMMAND: 400,
	INVALID_WAGER: 400,
	INSUFFICIENT_CHALLENGE_BANKROLL: 409,
};

const LEADERBOARD_DEFAULT_LIMIT = 50;
const LEADERBOARD_MIN_LIMIT = 1;
const LEADERBOARD_MAX_LIMIT = 50;

function jsonSuccess(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw new BlackjackRunServiceError('INVALID_REQUEST');
	}
}

function requireUser(locals: App.Locals): NonNullable<App.Locals['user']> {
	if (!locals.user) throw new BlackjackRunServiceError('UNAUTHORIZED');
	return locals.user;
}

function optionalUserId(locals: App.Locals): string | null {
	return locals.user?.id ?? null;
}

// Parse through the closed Task 1 start schema at the HTTP boundary: unknown
// fields are rejected by the strict union before the service is reached.
function parseStartRequest(payload: unknown): BlackjackRunStart {
	const parsed = blackjackRunStartSchema.safeParse(payload);
	if (parsed.success) return parsed.data;
	const wagerIssue = parsed.error.issues.some((issue) => issue.path[0] === 'wager');
	if (wagerIssue) throw new BlackjackRunError('INVALID_WAGER');
	throw new BlackjackRunServiceError('INVALID_REQUEST');
}

// Parse through the closed Task 1 command schema at the HTTP boundary; the
// strict members reject unknown fields as INVALID_COMMAND.
function parseCommandBody(payload: unknown): ReturnType<typeof blackjackRunCommandSchema.parse> {
	const parsed = blackjackRunCommandSchema.safeParse(payload);
	if (!parsed.success) throw new BlackjackRunError('INVALID_COMMAND');
	return parsed.data;
}

function parseMode(raw: string | null): 'ranked' | 'daily' {
	if (raw === 'ranked' || raw === 'daily') return raw;
	throw new BlackjackRunServiceError('INVALID_REQUEST');
}

function parseRunId(raw: string | undefined): string {
	const parsed = runIdSchema.safeParse(raw);
	if (!parsed.success) throw new BlackjackRunServiceError('INVALID_REQUEST');
	return parsed.data;
}

function parsePeriodKey(raw: string | undefined): string {
	const parsed = periodKeySchema.safeParse(raw);
	if (!parsed.success) throw new BlackjackRunServiceError('INVALID_REQUEST');
	const candidate = parsed.data;
	// Reject syntactically-valid-but-impossible keys (e.g. 2027-13-99),
	// matching the legacy daily-challenge leaderboard route.
	const epochMs = Date.parse(`${candidate}T00:00:00.000Z`);
	if (Number.isNaN(epochMs)) throw new BlackjackRunServiceError('INVALID_REQUEST');
	if (new Date(epochMs).toISOString().slice(0, 10) !== candidate) {
		throw new BlackjackRunServiceError('INVALID_REQUEST');
	}
	return candidate;
}

function parseLimit(raw: string | null, min: number, max: number, defaultValue: number): number {
	if (raw === null) return defaultValue;
	if (!/^[0-9]+$/.test(raw)) throw new BlackjackRunServiceError('INVALID_REQUEST');
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new BlackjackRunServiceError('INVALID_REQUEST');
	}
	return value;
}

function serviceFor(deps: BlackjackRunHttpHandlerDeps, locals: App.Locals): BlackjackRunService {
	const db = locals.runtime?.env?.DB;
	if (!db) throw new BlackjackRunServiceError('INTERNAL_ERROR');
	return deps.createService({ db });
}

export function blackjackRunJsonError(error: unknown): Response {
	if (error instanceof BlackjackRunServiceError) {
		const body: Record<string, unknown> = { error: error.code };
		if (error.retryable) body.retryable = true;
		return new Response(JSON.stringify(body), {
			status: BLACKJACK_RUN_ERROR_STATUS[error.code],
			headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
		});
	}
	if (error instanceof BlackjackRunError) {
		const body: Record<string, unknown> = { error: error.code };
		if (error.expectedSequence !== undefined) body.expectedSequence = error.expectedSequence;
		return new Response(JSON.stringify(body), {
			status: BLACKJACK_RUN_ERROR_STATUS[error.code],
			headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
		});
	}
	console.error('[BLACKJACK_RUN] unhandled request failure:', error);
	return new Response(JSON.stringify({ error: 'INTERNAL_ERROR' }), {
		status: 500,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

export function createBlackjackRunHttpHandlers(
	deps: BlackjackRunHttpHandlerDeps,
): BlackjackRunHttpHandlers {
	const start: APIRoute = async ({ locals, request }) => {
		try {
			const user = requireUser(locals);
			const body = parseStartRequest(await readJson(request));
			const service = serviceFor(deps, locals);
			return jsonSuccess(await service.start(user.id, body));
		} catch (error) {
			return blackjackRunJsonError(error);
		}
	};

	const current: APIRoute = async ({ locals, url }) => {
		try {
			const user = requireUser(locals);
			const mode = parseMode(url.searchParams.get('mode'));
			const service = serviceFor(deps, locals);
			return jsonSuccess(await service.current(user.id, mode));
		} catch (error) {
			return blackjackRunJsonError(error);
		}
	};

	const get: APIRoute = async ({ locals, params }) => {
		try {
			const user = requireUser(locals);
			const runId = parseRunId(params.runId);
			const service = serviceFor(deps, locals);
			return jsonSuccess(await service.get(user.id, runId));
		} catch (error) {
			return blackjackRunJsonError(error);
		}
	};

	const command: APIRoute = async ({ locals, params, request }) => {
		try {
			const user = requireUser(locals);
			const runId = parseRunId(params.runId);
			const body = parseCommandBody(await readJson(request));
			const service = serviceFor(deps, locals);
			return jsonSuccess(await service.command(user.id, runId, body));
		} catch (error) {
			return blackjackRunJsonError(error);
		}
	};

	const currentDaily: APIRoute = async ({ locals }) => {
		try {
			// Guests are allowed: currentDaily(null) throws RUN_NOT_FOUND in
			// the service, and the HTTP layer surfaces that as the guest
			// "no active attempt" surface (404 { error: 'RUN_NOT_FOUND' })
			// the Daily UI renders its Practice/sign-in CTA from.
			const userId = optionalUserId(locals);
			const service = serviceFor(deps, locals);
			return jsonSuccess(await service.currentDaily(userId));
		} catch (error) {
			return blackjackRunJsonError(error);
		}
	};

	const leaderboard: APIRoute = async ({ locals, params, url }) => {
		try {
			const userId = optionalUserId(locals);
			const periodKey = parsePeriodKey(params.periodKey);
			const limit = parseLimit(
				url.searchParams.get('limit'),
				LEADERBOARD_MIN_LIMIT,
				LEADERBOARD_MAX_LIMIT,
				LEADERBOARD_DEFAULT_LIMIT,
			);
			const service = serviceFor(deps, locals);
			return jsonSuccess(await service.leaderboard(periodKey, userId, limit));
		} catch (error) {
			return blackjackRunJsonError(error);
		}
	};

	return { start, current, get, command, currentDaily, leaderboard };
}

export const blackjackRunHttpHandlers = createBlackjackRunHttpHandlers({
	createService({ db }) {
		return createBlackjackRunService({
			repository: createBlackjackRunRepository(db),
			db,
			now: () => Math.trunc(Date.now() / 1000),
			randomBytes(length) {
				return crypto.getRandomValues(new Uint8Array(length));
			},
		});
	},
});
