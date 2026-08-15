import { fetchJsonWithTimeout } from '../fetch-with-timeout';
import {
	blackjackRunPublicStateSchema,
	type BlackjackAction,
	type BlackjackRunPublicState,
} from './protocol';

/**
 * Shared browser transport for the unified Blackjack Run APIs.
 *
 * Design rulings (HPA-553 Task 6):
 * - One request in flight at a time: every public method is guarded, so a
 *   second call while a request is pending rejects with a client error.
 * - One fresh request ID per explicit start: `startRanked`/`startDaily`
 *   generate a new nonce on every call (a retried start whose previous
 *   request committed adopts the active run via `loadCurrent`).
 * - `SEQUENCE_MISMATCH` on a command adopts the server state for the same
 *   run via `loadRun(runId)`.
 * - Timeout/network/`SETTLEMENT_CONFLICT` errors surface to the caller as
 *   `BlackjackRunClientError` (the UI shows an error state); recovery is an
 *   explicit user action (retry/load). There is NO localStorage, NO persisted
 *   queue, and NO automatic backoff/retry loop.
 *
 * The client tracks the last authoritative state it accepted and uses it to
 * stamp commands with the server-provided sequence number.
 */

export const BLACKJACK_RUN_BASE_PATH = '/api/blackjack-runs';
export const BLACKJACK_RUN_DEFAULT_TIMEOUT_MS = 10_000;

const RUN_NOT_FOUND = 'RUN_NOT_FOUND';
const ACTIVE_RUN_EXISTS = 'ACTIVE_RUN_EXISTS';
const SEQUENCE_MISMATCH = 'SEQUENCE_MISMATCH';

export type BlackjackRunClientCommand =
	| { command: 'start-round'; wager: number }
	| { command: BlackjackAction }
	| { command: 'forfeit' };

export interface BlackjackRunClientDeps {
	/** Request-id source; must return 16-128 `[A-Za-z0-9_-]` characters. */
	createRequestId?: () => string;
	timeoutMs?: number;
}

export interface BlackjackRunClient {
	loadCurrent(mode: 'ranked' | 'daily'): Promise<BlackjackRunPublicState | null>;
	loadRun(runId: string): Promise<BlackjackRunPublicState>;
	startRanked(wager: number): Promise<BlackjackRunPublicState>;
	startDaily(periodKey: string): Promise<BlackjackRunPublicState>;
	command(runId: string, command: BlackjackRunClientCommand): Promise<BlackjackRunPublicState>;
}

export class BlackjackRunClientError extends Error {
	/** Server error code (e.g. `SEQUENCE_MISMATCH`) or null for transport failures. */
	readonly code: string | null;
	readonly status: number | null;
	/** Server hint; true only for retryable conflicts (`SETTLEMENT_CONFLICT`). */
	readonly retryable: boolean;
	readonly expectedSequence: number | undefined;

	constructor(
		message: string,
		options: {
			code?: string | null;
			status?: number | null;
			retryable?: boolean;
			expectedSequence?: number;
		} = {},
	) {
		super(message);
		this.name = 'BlackjackRunClientError';
		this.code = options.code ?? null;
		this.status = options.status ?? null;
		this.retryable = options.retryable ?? false;
		this.expectedSequence = options.expectedSequence;
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
	return error instanceof Error ? error.message : 'Blackjack run request failed';
}

function defaultCreateRequestId(): string {
	if (
		typeof globalThis.crypto !== 'undefined' &&
		typeof globalThis.crypto.randomUUID === 'function'
	) {
		return globalThis.crypto.randomUUID();
	}
	// Fallback nonce; randomUUID is universal in modern browsers and Workers,
	// so this is defense in depth only. Math.random().toString(36) can yield
	// as few as zero fraction digits, so the random component is padded to at
	// least 11 characters: 8 (Date.now base-36) + 1 (hyphen) + 11 >= the
	// 16-character requestIdSchema minimum.
	const random = Math.random().toString(36).slice(2, 18).padEnd(11, '0');
	return `${Date.now().toString(36)}-${random}`;
}

export function createBlackjackRunClient(deps: BlackjackRunClientDeps = {}): BlackjackRunClient {
	const createRequestId = deps.createRequestId ?? defaultCreateRequestId;
	const timeoutMs = deps.timeoutMs ?? BLACKJACK_RUN_DEFAULT_TIMEOUT_MS;

	let current: BlackjackRunPublicState | null = null;
	let inFlight = false;

	/** One in-flight guard shared by every public method. */
	const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
		if (inFlight) {
			throw new BlackjackRunClientError('A blackjack run request is already in flight');
		}
		inFlight = true;
		try {
			return await operation();
		} finally {
			inFlight = false;
		}
	};

	/** Transport: fetchJsonWithTimeout only; every failure is a client error. */
	const request = async (
		url: string,
		init: RequestInit,
	): Promise<{ response: Response; data: unknown }> => {
		try {
			return await fetchJsonWithTimeout(url, init, timeoutMs);
		} catch (error) {
			// Timeout (AbortError) and network failures surface as uncertain
			// transport errors; no automatic retry or backoff.
			throw new BlackjackRunClientError(errorMessage(error));
		}
	};

	/** Parses a response through the shared Task 1 Zod schema (strict). */
	const parseState = (response: Response, data: unknown): BlackjackRunPublicState => {
		if (!response.ok) {
			const code = responseErrorCode(data);
			throw new BlackjackRunClientError(responseErrorMessage(response, data), {
				code,
				status: response.status,
				retryable: isPlainObject(data) && data.retryable === true,
				expectedSequence:
					isPlainObject(data) && typeof data.expectedSequence === 'number'
						? data.expectedSequence
						: undefined,
			});
		}
		const parsed = blackjackRunPublicStateSchema.safeParse(data);
		if (!parsed.success) {
			throw new BlackjackRunClientError('Blackjack run response was malformed', {
				status: response.status,
			});
		}
		return parsed.data;
	};

	const accept = (state: BlackjackRunPublicState): BlackjackRunPublicState => {
		current = state;
		return state;
	};

	const loadCurrentUnchecked = async (
		mode: 'ranked' | 'daily',
	): Promise<BlackjackRunPublicState | null> => {
		const { response, data } = await request(`${BLACKJACK_RUN_BASE_PATH}/current?mode=${mode}`, {
			method: 'GET',
		});
		// A definitive no-run answer is not an error: the page renders the
		// idle start form.
		if (response.status === 404 && responseErrorCode(data) === RUN_NOT_FOUND) {
			current = null;
			return null;
		}
		return accept(parseState(response, data));
	};

	const loadRunUnchecked = async (runId: string): Promise<BlackjackRunPublicState> => {
		const { response, data } = await request(
			`${BLACKJACK_RUN_BASE_PATH}/${encodeURIComponent(runId)}`,
			{ method: 'GET' },
		);
		return accept(parseState(response, data));
	};

	const startUnchecked = async (
		body:
			| { mode: 'ranked'; requestId: string; wager: number }
			| {
					mode: 'daily';
					requestId: string;
					periodKey: string;
			  },
		mode: 'ranked' | 'daily',
	): Promise<BlackjackRunPublicState> => {
		const { response, data } = await request(BLACKJACK_RUN_BASE_PATH, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		if (response.status === 409 && responseErrorCode(data) === ACTIVE_RUN_EXISTS) {
			// A previous explicit start committed and owns the active run;
			// adopt it so the UI resumes instead of failing.
			const adopted = await loadCurrentUnchecked(mode);
			if (adopted === null) {
				throw new BlackjackRunClientError('Active blackjack run disappeared during start recovery');
			}
			return adopted;
		}
		return accept(parseState(response, data));
	};

	const commandUnchecked = async (
		runId: string,
		command: BlackjackRunClientCommand,
	): Promise<BlackjackRunPublicState> => {
		if (!current || current.runId !== runId || current.status !== 'active') {
			throw new BlackjackRunClientError('No active blackjack run for command');
		}
		// Stamp the command with the server-provided sequence from the last
		// authoritative state (ranked: nextSequence, daily: nextCommandSequence).
		const sequence = current.mode === 'ranked' ? current.nextSequence : current.nextCommandSequence;
		const { response, data } = await request(
			`${BLACKJACK_RUN_BASE_PATH}/${encodeURIComponent(runId)}/commands`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ sequence, ...command }),
			},
		);
		if (response.status === 409 && responseErrorCode(data) === SEQUENCE_MISMATCH) {
			// Adopt the server's authoritative state for the same run.
			return loadRunUnchecked(runId);
		}
		return accept(parseState(response, data));
	};

	return {
		loadCurrent(mode) {
			return guarded(() => loadCurrentUnchecked(mode));
		},
		loadRun(runId) {
			return guarded(() => loadRunUnchecked(runId));
		},
		startRanked(wager) {
			return guarded(() =>
				startUnchecked({ mode: 'ranked', requestId: createRequestId(), wager }, 'ranked'),
			);
		},
		startDaily(periodKey) {
			return guarded(() =>
				startUnchecked({ mode: 'daily', requestId: createRequestId(), periodKey }, 'daily'),
			);
		},
		command(runId, command) {
			return guarded(() => commandUnchecked(runId, command));
		},
	};
}
