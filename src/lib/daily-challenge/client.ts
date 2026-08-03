import { parseDailyChallengeAttemptResponse } from './payload';
import type { DailyChallengeAttemptPublicStateV1 } from './protocol';

export type { DailyChallengeAttemptPublicStateV1 };

export const DAILY_CHALLENGE_START_KEY_PREFIX = 'arcturus:daily-challenge:start:';
export const DAILY_CHALLENGE_ATTEMPT_KEY_PREFIX = 'arcturus:daily-challenge:attempt:';
const DEFAULT_TIMEOUT_MS = 10_000;

export function buildDailyChallengeStorageKeys(
	userId: string,
	periodKey: string,
): {
	startRequest: string;
	activeAttempt: string;
} {
	return {
		startRequest: `${DAILY_CHALLENGE_START_KEY_PREFIX}${userId}:${periodKey}`,
		activeAttempt: `${DAILY_CHALLENGE_ATTEMPT_KEY_PREFIX}${userId}:${periodKey}`,
	};
}

export interface StoredDailyChallengeStartIntent {
	requestId: string;
	periodKey: string;
}

export interface StoredDailyChallengeAttempt {
	attemptId: string;
	periodKey: string;
	startRequestId: string;
}

export type DailyChallengeClientCommand =
	| { command: 'start-round'; wager: number }
	| { command: 'hit' | 'stand' | 'double-down' | 'split' | 'forfeited' };

export interface DailyChallengeRenderer {
	render(response: DailyChallengeAttemptPublicStateV1 | null): void;
	setPending(pending: boolean): void;
	renderError(message: string): void;
}

export interface DailyChallengeClientDeps {
	userId: string;
	periodKey: string;
	fetch: typeof fetch;
	storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
	renderer: DailyChallengeRenderer;
	createRequestId: () => string;
	timeoutMs?: number;
}

export interface DailyChallengeClient {
	initialize(): Promise<void>;
	start(): Promise<void>;
	command(command: DailyChallengeClientCommand): Promise<void>;
}

class DailyChallengeResponseError extends Error {
	readonly uncertain: boolean;
	readonly status: number;
	readonly code: string | null;

	constructor(message: string, uncertain: boolean, status: number, code: string | null) {
		super(message);
		this.name = 'DailyChallengeResponseError';
		this.uncertain = uncertain;
		this.status = status;
		this.code = code;
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responseErrorCode(payload: unknown): string | null {
	if (isPlainObject(payload) && typeof payload.error === 'string') {
		return payload.error;
	}
	return null;
}

function responseErrorMessage(response: Response, payload: unknown): string {
	const code = responseErrorCode(payload);
	if (code) return code.replaceAll('_', ' ').toLowerCase();
	return `request failed (${response.status})`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Daily challenge request failed';
}

function parseStoredStartIntent(raw: string | null): StoredDailyChallengeStartIntent | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<StoredDailyChallengeStartIntent>;
		if (
			typeof parsed.requestId === 'string' &&
			typeof parsed.periodKey === 'string' &&
			parsed.requestId.length > 0 &&
			parsed.periodKey.length > 0
		) {
			return { requestId: parsed.requestId, periodKey: parsed.periodKey };
		}
	} catch {
		// Fall through; legacy/plain values are not accepted for daily challenge.
	}
	return null;
}

function parseStoredActiveAttempt(raw: string | null): StoredDailyChallengeAttempt | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<StoredDailyChallengeAttempt>;
		if (
			typeof parsed.attemptId === 'string' &&
			typeof parsed.periodKey === 'string' &&
			typeof parsed.startRequestId === 'string' &&
			parsed.attemptId.length > 0 &&
			parsed.periodKey.length > 0 &&
			parsed.startRequestId.length > 0
		) {
			return {
				attemptId: parsed.attemptId,
				periodKey: parsed.periodKey,
				startRequestId: parsed.startRequestId,
			};
		}
	} catch {
		// Fall through.
	}
	return null;
}

export function createDailyChallengeClient(deps: DailyChallengeClientDeps): DailyChallengeClient {
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const keys = buildDailyChallengeStorageKeys(deps.userId, deps.periodKey);

	let current: DailyChallengeAttemptPublicStateV1 | null = null;
	let pending = false;

	const setPending = (nextPending: boolean): void => {
		pending = nextPending;
		deps.renderer.setPending(nextPending);
	};

	const removeStartIntentIfMatch = (requestId: string): void => {
		const stored = parseStoredStartIntent(deps.storage.getItem(keys.startRequest));
		if (stored?.requestId === requestId) {
			deps.storage.removeItem(keys.startRequest);
		}
	};

	const removeActiveAttemptIfMatch = (attemptId: string): void => {
		const stored = parseStoredActiveAttempt(deps.storage.getItem(keys.activeAttempt));
		if (stored?.attemptId === attemptId) {
			deps.storage.removeItem(keys.activeAttempt);
		}
	};

	const accept = (response: DailyChallengeAttemptPublicStateV1): void => {
		current = response;
		deps.renderer.render(response);
		if (response.status !== 'active' && response.receipt !== null) {
			removeActiveAttemptIfMatch(response.attemptId);
			removeStartIntentIfMatch(response.startRequestId);
		}
	};

	const transport = async (
		url: string,
		init: RequestInit,
	): Promise<DailyChallengeAttemptPublicStateV1> => {
		const controller = new AbortController();
		const callerSignal = init.signal;
		const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
		if (callerSignal) {
			if (callerSignal.aborted) {
				controller.abort(callerSignal.reason);
			} else {
				callerSignal.addEventListener('abort', onCallerAbort, { once: true });
			}
		}
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let response: Response;
		let payload: unknown;
		try {
			response = await deps.fetch(url, { ...init, signal: controller.signal });
			try {
				payload = await response.json();
			} catch {
				throw new TypeError('Daily challenge response was not valid JSON');
			}
		} catch (error) {
			// Abort errors and network failures surface as uncertain TypeErrors.
			if (error instanceof DailyChallengeResponseError) throw error;
			throw new TypeError(errorMessage(error));
		} finally {
			clearTimeout(timer);
			if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
		}
		if (!response.ok) {
			throw new DailyChallengeResponseError(
				responseErrorMessage(response, payload),
				response.status >= 500,
				response.status,
				responseErrorCode(payload),
			);
		}
		return parseDailyChallengeAttemptResponse(payload);
	};

	const getAttempt = async (attemptId: string): Promise<DailyChallengeAttemptPublicStateV1> => {
		return transport(`/api/daily-challenge-attempts/${attemptId}`, { method: 'GET' });
	};

	const recoverTerminal = async (
		attemptId: string,
	): Promise<DailyChallengeAttemptPublicStateV1> => {
		const resumed = await getAttempt(attemptId);
		accept(resumed);
		return resumed;
	};

	const initialize = async (): Promise<void> => {
		if (pending) return;
		const stored = parseStoredActiveAttempt(deps.storage.getItem(keys.activeAttempt));
		if (!stored) {
			deps.renderer.render(null);
			return;
		}
		setPending(true);
		try {
			const resumed = await getAttempt(stored.attemptId);
			accept(resumed);
		} catch (error) {
			deps.renderer.renderError(errorMessage(error));
		} finally {
			setPending(false);
		}
	};

	const start = async (): Promise<void> => {
		if (pending || current?.status === 'active') return;
		const stored = parseStoredStartIntent(deps.storage.getItem(keys.startRequest));
		const requestId =
			stored && stored.periodKey === deps.periodKey ? stored.requestId : deps.createRequestId();
		deps.storage.setItem(
			keys.startRequest,
			JSON.stringify({ requestId, periodKey: deps.periodKey }),
		);
		setPending(true);
		try {
			const response = await transport('/api/daily-challenges/current/attempts', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ requestId }),
			});
			deps.storage.setItem(
				keys.activeAttempt,
				JSON.stringify({
					attemptId: response.attemptId,
					periodKey: deps.periodKey,
					startRequestId: response.startRequestId,
				}),
			);
			removeStartIntentIfMatch(requestId);
			accept(response);
		} catch (error) {
			deps.renderer.renderError(errorMessage(error));
			const uncertain = !(error instanceof DailyChallengeResponseError) || error.uncertain;
			if (!uncertain) {
				removeStartIntentIfMatch(requestId);
			}
		} finally {
			setPending(false);
		}
	};

	const isUncertain = (error: unknown): boolean =>
		!(error instanceof DailyChallengeResponseError) || error.uncertain;

	const isAttemptComplete = (error: unknown): boolean =>
		error instanceof DailyChallengeResponseError && error.code === 'ATTEMPT_COMPLETE';

	const command = async (action: DailyChallengeClientCommand): Promise<void> => {
		if (pending || !current || current.status !== 'active') return;
		const attemptId = current.attemptId;
		const body = JSON.stringify({ sequence: current.nextCommandSequence, ...action });
		const requestInit: RequestInit = {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
		};
		const commandUrl = `/api/daily-challenge-attempts/${attemptId}/commands`;
		setPending(true);
		try {
			let response: DailyChallengeAttemptPublicStateV1;
			try {
				response = await transport(commandUrl, requestInit);
			} catch (firstError) {
				if (isAttemptComplete(firstError)) {
					await recoverTerminal(attemptId);
					return;
				}
				if (!isUncertain(firstError)) throw firstError;
				try {
					response = await transport(commandUrl, requestInit);
				} catch (retryError) {
					if (isAttemptComplete(retryError)) {
						await recoverTerminal(attemptId);
						return;
					}
					if (!isUncertain(retryError)) throw retryError;
					response = await getAttempt(attemptId);
				}
			}
			accept(response);
		} catch (error) {
			deps.renderer.renderError(errorMessage(error));
		} finally {
			setPending(false);
		}
	};

	return { initialize, start, command };
}
