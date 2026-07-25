import {
	rankedBalanceSchema,
	type RankedBlackjackAction,
	type RankedPublicStateV1,
	type RankedReceiptV1,
} from '../protocol';
import { createRankedBlackjackRenderer } from './ui';

export const START_REQUEST_KEY = 'arcturus:ranked-blackjack:start-request';
export const ACTIVE_SESSION_KEY = 'arcturus:ranked-blackjack:session';

export interface RankedBlackjackPublicCardV1 {
	readonly rank: 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K';
	readonly suit: 'hearts' | 'diamonds' | 'clubs' | 'spades';
}

export interface RankedBlackjackPublicHandValueV1 {
	readonly value: number;
	readonly isSoft: boolean;
	readonly isBust: boolean;
}

export interface RankedBlackjackPublicHandV1 {
	readonly cards: readonly RankedBlackjackPublicCardV1[];
	readonly wager: number;
	readonly value: RankedBlackjackPublicHandValueV1;
}

export interface RankedBlackjackPublicOutcomeV1 {
	readonly result: 'win' | 'loss' | 'push';
	readonly hands: readonly {
		readonly handIndex: number;
		readonly result: 'win' | 'loss' | 'push' | 'blackjack';
		readonly wager: number;
		readonly payout: number;
	}[];
	readonly committedWager: number;
	readonly payout: number;
	readonly gameNetDelta: number;
}

export interface RankedBlackjackBrowserStateV1 {
	readonly phase: 'player-turn' | 'complete';
	readonly playerHands: readonly RankedBlackjackPublicHandV1[];
	readonly activeHandIndex: number;
	readonly dealer: {
		readonly cards: readonly RankedBlackjackPublicCardV1[];
		readonly value: RankedBlackjackPublicHandValueV1;
	};
	readonly committedWager: number;
	readonly nextSequence: number;
	readonly availableActions: readonly RankedBlackjackAction[];
	readonly outcome: RankedBlackjackPublicOutcomeV1 | null;
}

export type RankedBlackjackReceiptV1 = RankedReceiptV1<RankedBlackjackPublicOutcomeV1>;

export interface RankedBlackjackResponseV1
	extends RankedPublicStateV1<RankedBlackjackBrowserStateV1> {
	readonly receipt: RankedBlackjackReceiptV1 | null;
}

export interface RankedBlackjackRendererHandlers {
	onStart: (wager: number) => void | Promise<void>;
	onAction: (action: RankedBlackjackAction) => void | Promise<void>;
}

export interface RankedBlackjackRenderer {
	bind(handlers: RankedBlackjackRendererHandlers): void;
	getWager(): number;
	render(response: RankedBlackjackResponseV1 | null): void;
	setPending(pending: boolean): void;
	renderCountdown(secondsRemaining: number): void;
	renderError(message: string): void;
}

type TimerHandle = unknown;

export interface RankedBlackjackClientDeps {
	fetch: typeof fetch;
	storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
	renderer: RankedBlackjackRenderer;
	createRequestId: () => string;
	now?: () => number;
	setInterval?: (callback: () => void, delayMs: number) => TimerHandle;
	clearInterval?: (handle: TimerHandle) => void;
}

export interface RankedBlackjackClient {
	initialize(): Promise<void>;
	start(wager: number): Promise<void>;
	act(action: RankedBlackjackAction): Promise<void>;
}

interface StoredStartRequest {
	requestId: string;
	wager: number;
}

interface PendingActionRecovery {
	sessionId: string;
	action: RankedBlackjackAction;
	body: string;
}

class RankedHttpResponseError extends Error {
	readonly uncertain: boolean;
	readonly status: number;
	readonly code: string | null;

	constructor(message: string, uncertain: boolean, status: number, code: string | null) {
		super(message);
		this.name = 'RankedHttpResponseError';
		this.uncertain = uncertain;
		this.status = status;
		this.code = code;
	}
}

function parseStoredStartRequest(raw: string | null): StoredStartRequest | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<StoredStartRequest>;
		if (
			typeof parsed.requestId === 'string' &&
			typeof parsed.wager === 'number' &&
			Number.isSafeInteger(parsed.wager)
		) {
			return { requestId: parsed.requestId, wager: parsed.wager };
		}
	} catch {
		// Legacy/plain request IDs still retain their idempotency value.
		if (/^[A-Za-z0-9_-]{16,128}$/.test(raw)) return { requestId: raw, wager: 0 };
	}
	return null;
}

function responseErrorCode(payload: unknown): string | null {
	if (
		typeof payload === 'object' &&
		payload !== null &&
		'error' in payload &&
		typeof payload.error === 'string'
	) {
		return payload.error;
	}
	return null;
}

function responseErrorMessage(response: Response, payload: unknown): string {
	const code = responseErrorCode(payload);
	if (code) return code.replaceAll('_', ' ').toLowerCase();
	return `request failed (${response.status})`;
}

async function readResponse(response: Response): Promise<RankedBlackjackResponseV1> {
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new TypeError('Ranked response was not valid JSON');
	}
	if (!response.ok) {
		throw new RankedHttpResponseError(
			responseErrorMessage(response, payload),
			response.status >= 500,
			response.status,
			responseErrorCode(payload),
		);
	}
	if (
		typeof payload !== 'object' ||
		payload === null ||
		!('sessionId' in payload) ||
		typeof payload.sessionId !== 'string' ||
		!('balance' in payload) ||
		!rankedBalanceSchema.safeParse(payload.balance).success
	) {
		throw new TypeError('Ranked response was malformed');
	}
	return payload as RankedBlackjackResponseV1;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Ranked request failed';
}

function isUncertainResponse(error: unknown): boolean {
	return !(error instanceof RankedHttpResponseError) || error.uncertain;
}

function isDefinitiveMissingSession(error: unknown): boolean {
	return (
		error instanceof RankedHttpResponseError &&
		error.status === 404 &&
		error.code === 'SESSION_NOT_FOUND'
	);
}

export function createRankedBlackjackClient(
	deps: RankedBlackjackClientDeps,
): RankedBlackjackClient {
	const now = deps.now ?? Date.now;
	const scheduleInterval =
		deps.setInterval ??
		((callback: () => void, delayMs: number): TimerHandle =>
			globalThis.setInterval(callback, delayMs));
	const cancelInterval =
		deps.clearInterval ??
		((handle: TimerHandle): void =>
			globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>));

	let current: RankedBlackjackResponseV1 | null = null;
	let pending = false;
	let countdownHandle: TimerHandle | null = null;
	let actionRecovery: PendingActionRecovery | null = null;

	const stopCountdown = (): void => {
		if (countdownHandle === null) return;
		cancelInterval(countdownHandle);
		countdownHandle = null;
	};

	const updateCountdown = (): void => {
		if (!current || current.status !== 'active') return;
		const secondsRemaining = Math.max(0, Math.ceil((current.expiresAt * 1000 - now()) / 1000));
		deps.renderer.renderCountdown(secondsRemaining);
	};

	const startCountdown = (): void => {
		stopCountdown();
		if (!current || current.status !== 'active') return;
		updateCountdown();
		countdownHandle = scheduleInterval(updateCountdown, 1000);
	};

	const setPending = (nextPending: boolean): void => {
		pending = nextPending;
		deps.renderer.setPending(nextPending);
	};

	const accept = (response: RankedBlackjackResponseV1): void => {
		current = response;
		actionRecovery = null;
		deps.renderer.render(response);
		startCountdown();
		if (response.receipt && response.status !== 'active') {
			deps.storage.removeItem(START_REQUEST_KEY);
			deps.storage.removeItem(ACTIVE_SESSION_KEY);
		}
	};

	const get = async (sessionId: string): Promise<RankedBlackjackResponseV1> => {
		const response = await deps.fetch(`/api/ranked/sessions/${sessionId}`);
		return readResponse(response);
	};

	const resume = async (sessionId: string): Promise<void> => {
		accept(await get(sessionId));
	};

	const initialize = async (): Promise<void> => {
		if (pending) return;
		const sessionId = deps.storage.getItem(ACTIVE_SESSION_KEY);
		if (!sessionId) {
			deps.renderer.render(null);
			return;
		}
		setPending(true);
		try {
			await resume(sessionId);
			setPending(false);
		} catch (error) {
			deps.renderer.renderError(errorMessage(error));
			if (isDefinitiveMissingSession(error)) {
				deps.storage.removeItem(ACTIVE_SESSION_KEY);
				current = null;
				deps.renderer.render(null);
				setPending(false);
			}
		}
	};

	const start = async (wager: number): Promise<void> => {
		if (pending || current?.status === 'active') return;
		const stored = parseStoredStartRequest(deps.storage.getItem(START_REQUEST_KEY));
		const startRequest = stored
			? { requestId: stored.requestId, wager: stored.wager === 0 ? wager : stored.wager }
			: { requestId: deps.createRequestId(), wager };
		deps.storage.setItem(START_REQUEST_KEY, JSON.stringify(startRequest));
		const body = JSON.stringify({
			requestId: startRequest.requestId,
			gameType: 'blackjack',
			rulesetVersion: 'blackjack-ranked-v1',
			wager: startRequest.wager,
		});
		setPending(true);
		try {
			const response = await readResponse(
				await deps.fetch('/api/ranked/sessions', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body,
				}),
			);
			deps.storage.setItem(ACTIVE_SESSION_KEY, response.sessionId);
			accept(response);
		} catch (error) {
			deps.renderer.renderError(errorMessage(error));
			if (!isUncertainResponse(error)) {
				deps.storage.removeItem(START_REQUEST_KEY);
			}
		} finally {
			setPending(false);
		}
	};

	const act = async (action: RankedBlackjackAction): Promise<void> => {
		if (pending || !current || current.status !== 'active') return;
		if (actionRecovery && actionRecovery.action !== action) return;
		const isRecoveryAttempt = actionRecovery !== null;
		const sessionId = actionRecovery?.sessionId ?? current.sessionId;
		const body = actionRecovery?.body ?? JSON.stringify({ sequence: current.nextSequence, action });
		const actionUrl = `/api/ranked/sessions/${sessionId}/actions`;
		const requestInit: RequestInit = {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
		};
		setPending(true);
		let authoritativeRecoveryAttempted = false;
		try {
			let response: RankedBlackjackResponseV1;
			try {
				response = await readResponse(await deps.fetch(actionUrl, requestInit));
			} catch (firstError) {
				if (!isUncertainResponse(firstError)) throw firstError;
				try {
					response = await readResponse(await deps.fetch(actionUrl, requestInit));
				} catch (retryError) {
					if (!isUncertainResponse(retryError)) throw retryError;
					authoritativeRecoveryAttempted = true;
					response = await get(sessionId);
				}
			}
			accept(response);
			setPending(false);
		} catch (error) {
			deps.renderer.renderError(errorMessage(error));
			if (isRecoveryAttempt || authoritativeRecoveryAttempted) {
				actionRecovery = { sessionId, action, body };
				pending = false;
				return;
			}
			actionRecovery = null;
			setPending(false);
		}
	};

	return { initialize, start, act };
}

export function initRankedBlackjackClient(): RankedBlackjackClient | null {
	const root = document.getElementById('ranked-blackjack-root');
	if (!root) return null;
	const renderer = createRankedBlackjackRenderer(root);
	const client = createRankedBlackjackClient({
		fetch: window.fetch.bind(window),
		storage: window.localStorage,
		renderer,
		createRequestId: () => crypto.randomUUID().replaceAll('-', ''),
	});
	renderer.bind({
		onStart: (wager) => client.start(wager),
		onAction: (action) => client.act(action),
	});
	void client.initialize();
	return client;
}
