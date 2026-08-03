import { decodeCanonicalBase64Url } from '../ranked/canonical';
import { BLACKJACK_DAILY_V1_CONFIG } from './config';
import {
	parseDailyChallengeAttemptResponse,
	parseDailyChallengeChallengeResponse,
	parseDailyChallengeHistoryResponse,
	parseDailyChallengeLeaderboardResponse,
} from './payload';
import type {
	DailyChallengeAttemptPublicStateV1,
	DailyChallengeCommandV1,
	DailyChallengePublicResponse,
} from './protocol';
import { createDailyChallengeSeedCommitment } from './random';
import type { DailyChallengeReplayV1 } from './replay';
import { createDailyChallengeRenderer } from './ui';
import type {
	DailyChallengeAction,
	DailyChallengeMode,
	DailyChallengeReplayScenario,
	DailyChallengeRenderer,
} from './ui';

export type { DailyChallengeAttemptPublicStateV1, DailyChallengeRenderer };

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
	| { command: 'hit' | 'stand' | 'double-down' | 'split' | 'forfeit' };

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
		deps.renderer.renderAttempt(response);
		if (response.status !== 'active' && response.receipt !== null) {
			removeActiveAttemptIfMatch(response.attemptId);
			removeStartIntentIfMatch(response.startRequestId);
		}
	};

	const transport = async (
		url: string,
		init: RequestInit,
	): Promise<DailyChallengeAttemptPublicStateV1> => {
		// Call fetch bare: `deps.fetch(...)` is a member call whose receiver
		// would be the deps object, and the DOM `fetch` throws "Illegal
		// invocation" when invoked on a non-Window receiver in strict modules.
		const { fetch: fetchImpl } = deps;
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
			response = await fetchImpl(url, { ...init, signal: controller.signal });
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
			deps.renderer.renderAttempt(null);
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

export interface DailyChallengeLocalReplayControllerDeps {
	challenge: DailyChallengePublicResponse;
	renderer: DailyChallengeRenderer;
	loadReplay?: () => Promise<typeof import('./replay')>;
}

export interface DailyChallengeLocalReplayController {
	selectScenario(scenario: DailyChallengeReplayScenario): Promise<void>;
	startRound(wager: number): Promise<void>;
	action(action: DailyChallengeAction): Promise<void>;
	forfeit(): Promise<void>;
	restart(): Promise<void>;
}

export function createDailyChallengeLocalReplayController(
	deps: DailyChallengeLocalReplayControllerDeps,
): DailyChallengeLocalReplayController {
	const loadReplay = deps.loadReplay ?? (async () => import('./replay'));

	let masterSeed: Uint8Array | null = null;
	let commands: DailyChallengeCommandV1[] = [];

	const applyCommand = async (command: DailyChallengeCommandV1): Promise<void> => {
		if (masterSeed === null) {
			deps.renderer.renderError('Select a practice scenario first.');
			return;
		}
		// Flip pending synchronously (before the dynamic replay import) so
		// controls disable on click and the UI never exposes the stale
		// pre-command state as a settled round.
		deps.renderer.setPending(true);
		try {
			const module = await loadReplay();
			const candidate = [...commands, command];
			try {
				const replay: DailyChallengeReplayV1 = module.replayDailyChallenge(
					BLACKJACK_DAILY_V1_CONFIG,
					masterSeed,
					candidate,
				);
				commands = candidate;
				deps.renderer.renderLocalReplay(replay);
			} catch (error) {
				deps.renderer.renderError(errorMessage(error));
			}
		} finally {
			deps.renderer.setPending(false);
		}
	};

	return {
		async selectScenario(nextScenario: DailyChallengeReplayScenario): Promise<void> {
			let seed: string;
			if (nextScenario === 'practice-scenario') {
				seed = deps.challenge.practiceSeed;
			} else {
				const revealed = deps.challenge.revealedRankedSeed;
				if (revealed === null) {
					deps.renderer.renderError('The ranked replay seed is not available yet.');
					return;
				}
				seed = revealed;
			}
			try {
				masterSeed = decodeCanonicalBase64Url(seed);
			} catch {
				deps.renderer.renderError('The daily challenge seed is not canonical.');
				return;
			}
			commands = [];
			deps.renderer.renderLocalReplay(null);
		},

		async startRound(wager: number): Promise<void> {
			await applyCommand({ sequence: commands.length, command: 'start-round', wager });
		},

		async action(action: DailyChallengeAction): Promise<void> {
			await applyCommand({ sequence: commands.length, command: action });
		},

		async forfeit(): Promise<void> {
			await applyCommand({ sequence: commands.length, command: 'forfeit' });
		},

		async restart(): Promise<void> {
			commands = [];
			deps.renderer.renderLocalReplay(null);
		},
	};
}

export interface DailyChallengePageBootstrapDeps {
	fetch?: typeof fetch;
	storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
	createRequestId?: () => string;
	createRenderer?: (root: HTMLElement) => DailyChallengeRenderer;
	createClient?: (deps: DailyChallengeClientDeps) => DailyChallengeClient;
	createLocalReplayController?: (
		deps: DailyChallengeLocalReplayControllerDeps,
	) => DailyChallengeLocalReplayController;
}

function createBrowserRequestId(): string {
	if (
		typeof globalThis.crypto !== 'undefined' &&
		typeof globalThis.crypto.randomUUID === 'function'
	) {
		return globalThis.crypto.randomUUID();
	}
	return `dc-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

async function fetchDailyChallengeJson<T>(
	fetchImpl: typeof fetch,
	url: string,
	parse: (value: unknown) => T,
): Promise<T> {
	let response: Response;
	try {
		response = await fetchImpl(url);
	} catch (error) {
		throw new TypeError(errorMessage(error));
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new TypeError('Daily challenge response was not valid JSON');
	}
	if (!response.ok) {
		throw new DailyChallengeResponseError(
			responseErrorMessage(response, payload),
			response.status >= 500,
			response.status,
			responseErrorCode(payload),
		);
	}
	return parse(payload);
}

function pageFetch(fetchImpl: typeof fetch | undefined): typeof fetch {
	return fetchImpl ?? (globalThis.fetch as typeof fetch);
}

function pageStorage(
	storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined,
): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
	if (storage) return storage;
	return globalThis.localStorage as Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

function pageRenderer(
	root: HTMLElement,
	createRenderer: ((root: HTMLElement) => DailyChallengeRenderer) | undefined,
): DailyChallengeRenderer {
	return createRenderer ? createRenderer(root) : createDailyChallengeRenderer(root);
}

export async function initDailyChallengePage(
	root: HTMLElement,
	deps: DailyChallengePageBootstrapDeps = {},
): Promise<void> {
	const fetchImpl = pageFetch(deps.fetch);
	const renderer = pageRenderer(root, deps.createRenderer);
	const createClient = deps.createClient ?? createDailyChallengeClient;
	const createReplay =
		deps.createLocalReplayController ?? createDailyChallengeLocalReplayController;

	let mode: DailyChallengeMode = 'practice';
	let rankedClient: DailyChallengeClient | null = null;

	const challenge = await fetchDailyChallengeJson(
		fetchImpl,
		'/api/daily-challenges/current',
		parseDailyChallengeChallengeResponse,
	).catch((error: unknown) => {
		renderer.renderError(errorMessage(error));
		return null;
	});
	if (challenge === null) return;

	renderer.renderChallenge(challenge);

	const userId = root.dataset.userId;
	if (userId !== undefined) {
		rankedClient = createClient({
			userId,
			periodKey: challenge.periodKey,
			fetch: fetchImpl,
			storage: pageStorage(deps.storage),
			renderer,
			createRequestId: deps.createRequestId ?? createBrowserRequestId,
		});
	}
	const replayController = createReplay({ challenge, renderer });

	renderer.bind({
		onSelectMode(nextMode) {
			mode = nextMode;
		},
		onStartRanked() {
			void rankedClient?.start();
		},
		onStartRound(wager) {
			if (mode === 'ranked') {
				void rankedClient?.command({ command: 'start-round', wager });
			} else {
				void replayController.startRound(wager);
			}
		},
		onAction(action) {
			if (mode === 'ranked') {
				void rankedClient?.command({ command: action });
			} else {
				void replayController.action(action);
			}
		},
		onForfeit() {
			if (mode === 'ranked') {
				void rankedClient?.command({ command: 'forfeit' });
			} else {
				void replayController.forfeit();
			}
		},
		onRestartPractice() {
			void replayController.restart();
		},
		onSelectReplayScenario(scenario) {
			void replayController.selectScenario(scenario);
		},
	});

	if (rankedClient !== null) {
		await rankedClient.initialize();
	}

	await Promise.all([
		fetchDailyChallengeJson(
			fetchImpl,
			`/api/daily-challenges/${challenge.periodKey}/leaderboard`,
			parseDailyChallengeLeaderboardResponse,
		)
			.then((leaderboard) => renderer.renderLeaderboard(leaderboard))
			.catch(() => {}),
		fetchDailyChallengeJson(
			fetchImpl,
			'/api/daily-challenges/history?limit=7',
			parseDailyChallengeHistoryResponse,
		)
			.then((history) => renderer.renderHistory(history))
			.catch(() => {}),
	]);
}

function renderRevealMetadata(root: HTMLElement, challenge: DailyChallengePublicResponse): void {
	const commitmentEl = root.querySelector<HTMLElement>(
		'[data-testid="daily-challenge-commitment"]',
	);
	if (commitmentEl) {
		commitmentEl.textContent = challenge.rankedSeedCommitment;
	}
	const statusEl = root.querySelector<HTMLElement>('[data-testid="daily-challenge-reveal-status"]');
	if (!statusEl) return;
	const revealed = challenge.revealedRankedSeed;
	if (revealed === null) {
		statusEl.textContent = 'Ranked seed not yet revealed';
		return;
	}
	let verified = false;
	try {
		const seed = decodeCanonicalBase64Url(revealed);
		const recomputed = createDailyChallengeSeedCommitment(challenge.challengeRulesetVersion, seed);
		verified = recomputed === challenge.rankedSeedCommitment;
	} catch {
		// A non-canonical revealed seed fails verification below.
	}
	statusEl.textContent = verified ? 'Commitment verified' : 'Commitment mismatch';
}

export async function initDailyChallengeHistoryPage(
	root: HTMLElement,
	deps: DailyChallengePageBootstrapDeps = {},
): Promise<void> {
	const periodKey = root.dataset.periodKey;
	if (periodKey === undefined) return;

	const fetchImpl = pageFetch(deps.fetch);
	const renderer = pageRenderer(root, deps.createRenderer);
	const createReplay =
		deps.createLocalReplayController ?? createDailyChallengeLocalReplayController;

	const challenge = await fetchDailyChallengeJson(
		fetchImpl,
		`/api/daily-challenges/${encodeURIComponent(periodKey)}`,
		parseDailyChallengeChallengeResponse,
	).catch((error: unknown) => {
		renderer.renderError(errorMessage(error));
		return null;
	});
	if (challenge === null) return;

	renderer.renderChallenge(challenge);

	const replayController = createReplay({ challenge, renderer });

	renderer.bind({
		onSelectMode() {},
		onStartRanked() {},
		onStartRound(wager) {
			void replayController.startRound(wager);
		},
		onAction(action) {
			void replayController.action(action);
		},
		onForfeit() {
			void replayController.forfeit();
		},
		onRestartPractice() {
			void replayController.restart();
		},
		onSelectReplayScenario(scenario) {
			void replayController.selectScenario(scenario);
		},
	});

	renderRevealMetadata(root, challenge);

	await fetchDailyChallengeJson(
		fetchImpl,
		`/api/daily-challenges/${encodeURIComponent(periodKey)}/leaderboard`,
		parseDailyChallengeLeaderboardResponse,
	)
		.then((leaderboard) => renderer.renderLeaderboard(leaderboard))
		.catch(() => {});
}
