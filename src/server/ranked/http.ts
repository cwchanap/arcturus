import type { APIRoute } from 'astro';
import {
	actionRequestSchema,
	RANKED_ERROR_STATUS,
	RankedServiceError,
	sessionIdSchema,
	startRequestSchema,
	type RankedStartRequest,
} from '../../lib/ranked/protocol';
import { getRankedAdapter } from '../../lib/ranked/registry';
import {
	createRankedCoordinator,
	type RankedCoordinator,
	type RankedCoordinatorResponse,
} from './coordinator';
import { createRankedRepository } from './repository';

export interface RankedHttpCoordinatorBindings {
	db: D1Database;
}

export interface RankedHttpHandlerDeps {
	createCoordinator(bindings: RankedHttpCoordinatorBindings): RankedCoordinator;
}

export interface RankedHttpHandlers {
	start: APIRoute;
	resume: APIRoute;
	action: APIRoute;
}

function jsonSuccess(body: RankedCoordinatorResponse): Response {
	return new Response(JSON.stringify(body), {
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

function invalidRequest(): never {
	throw new RankedServiceError('INVALID_REQUEST');
}

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		return invalidRequest();
	}
}

function parseStartRequest(payload: unknown): RankedStartRequest {
	const parsed = startRequestSchema.safeParse(payload);
	if (parsed.success) return parsed.data;
	const onlyWagerIssues =
		parsed.error.issues.length > 0 &&
		parsed.error.issues.every((issue) => issue.path.length === 1 && issue.path[0] === 'wager');
	const hasNumericWager =
		typeof payload === 'object' &&
		payload !== null &&
		!Array.isArray(payload) &&
		typeof (payload as Record<string, unknown>).wager === 'number';
	if (onlyWagerIssues && hasNumericWager) {
		throw new RankedServiceError('INVALID_WAGER');
	}
	return invalidRequest();
}

function requireUser(locals: App.Locals): NonNullable<App.Locals['user']> {
	if (!locals.user) throw new RankedServiceError('UNAUTHORIZED');
	return locals.user;
}

function requireSessionId(raw: string | undefined): string {
	const parsed = sessionIdSchema.safeParse(raw);
	if (!parsed.success) return invalidRequest();
	return parsed.data;
}

function coordinatorFor(deps: RankedHttpHandlerDeps, locals: App.Locals): RankedCoordinator {
	const db = locals.runtime?.env?.DB;
	if (!db) throw new RankedServiceError('INTERNAL_ERROR');
	return deps.createCoordinator({ db });
}

export function rankedJsonError(error: unknown): Response {
	if (error instanceof RankedServiceError) {
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
			{ status: RANKED_ERROR_STATUS[error.code], headers },
		);
	}
	console.error('[RANKED] unhandled request failure:', error);
	return new Response(JSON.stringify({ error: 'INTERNAL_ERROR' }), {
		status: 500,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

export function createRankedHttpHandlers(deps: RankedHttpHandlerDeps): RankedHttpHandlers {
	const start: APIRoute = async ({ locals, request }) => {
		try {
			const user = requireUser(locals);
			const body = parseStartRequest(await readJson(request));
			const coordinator = coordinatorFor(deps, locals);
			return jsonSuccess(await coordinator.start({ userId: user.id, body }));
		} catch (error) {
			return rankedJsonError(error);
		}
	};

	const resume: APIRoute = async ({ locals, params }) => {
		try {
			const user = requireUser(locals);
			const sessionId = requireSessionId(params.sessionId);
			const coordinator = coordinatorFor(deps, locals);
			return jsonSuccess(await coordinator.resume({ userId: user.id, sessionId }));
		} catch (error) {
			return rankedJsonError(error);
		}
	};

	const action: APIRoute = async ({ locals, params, request }) => {
		try {
			const user = requireUser(locals);
			const sessionId = requireSessionId(params.sessionId);
			const payload = await readJson(request);
			const parsed = actionRequestSchema.safeParse(payload);
			if (!parsed.success) invalidRequest();
			const coordinator = coordinatorFor(deps, locals);
			return jsonSuccess(
				await coordinator.act({
					userId: user.id,
					sessionId,
					body: parsed.data,
				}),
			);
		} catch (error) {
			return rankedJsonError(error);
		}
	};

	return { start, resume, action };
}

export const rankedHttpHandlers = createRankedHttpHandlers({
	createCoordinator({ db }) {
		return createRankedCoordinator({
			repository: createRankedRepository(db),
			getAdapter: getRankedAdapter,
			now: () => new Date(),
			randomBytes(length) {
				return crypto.getRandomValues(new Uint8Array(length));
			},
			log(entry) {
				console.warn('[RANKED]', entry);
			},
		});
	},
});
