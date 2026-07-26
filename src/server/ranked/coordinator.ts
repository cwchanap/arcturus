import type { RankedBlackjackPublicStateV1 } from '../../lib/ranked/blackjack/adapter';
import type { RankedBlackjackOutcomeV1 } from '../../lib/ranked/blackjack/types';
import {
	canonicalizeRanked,
	decodeCanonicalBase64Url,
	encodeBase64Url,
	hashCanonical,
} from '../../lib/ranked/canonical';
import {
	actionRequestSchema,
	rankedBalanceSchema,
	RankedServiceError,
	type RankedBlackjackActionLogEntryV1,
	type RankedPublicStateV1,
	type RankedReceiptV1,
	type RankedStartRequest,
} from '../../lib/ranked/protocol';
import { createSeedCommitment } from '../../lib/ranked/random';
import { getRankedAdapter } from '../../lib/ranked/registry';
import { reconcileMultiplayerMembership, type MembershipResolution } from '../mp/membership';
import { createRankedLogEntry, type RankedLogEntry } from './logging';
import type {
	ActionTransitionInput,
	NewRankedSessionRecord,
	RankedRepository,
	RankedResultRecord,
	RankedSessionRecord,
	TerminalTransitionInput,
} from './repository';

const SESSION_TTL_SECONDS = 15 * 60;
const SNAPSHOT_ATTEMPTS = 3;

export type RankedCoordinatorResponse = RankedPublicStateV1<RankedBlackjackPublicStateV1>;

export interface RankedCoordinator {
	start(input: { userId: string; body: RankedStartRequest }): Promise<RankedCoordinatorResponse>;
	resume(input: { userId: string; sessionId: string }): Promise<RankedCoordinatorResponse>;
	act(input: {
		userId: string;
		sessionId: string;
		body: RankedBlackjackActionLogEntryV1;
	}): Promise<RankedCoordinatorResponse>;
	expire(sessionId: string): Promise<RankedCoordinatorResponse>;
}

export interface RankedCoordinatorDeps {
	repository: RankedRepository;
	getAdapter: typeof getRankedAdapter;
	reconcileMembership: typeof reconcileMultiplayerMembership;
	membershipDb: D1Database;
	membershipNamespace?: DurableObjectNamespace;
	now: () => Date;
	randomBytes: (length: number) => Uint8Array;
	log?: (entry: RankedLogEntry) => void;
}

interface ReceiptContext {
	sessionId: string;
	gameType: 'blackjack';
	rulesetVersion: 'blackjack-ranked-v1';
	seedCommitment: string;
	configHash: string;
	actionLogHash: string;
	initialWager: number;
	committedWager: number;
}

function asNowSeconds(now: Date): number {
	const seconds = Math.trunc(now.getTime() / 1000);
	if (!Number.isSafeInteger(seconds) || seconds < 0) {
		throw new Error('Invalid ranked coordinator clock');
	}
	return seconds;
}

function internalError(message: string): never {
	throw new RankedServiceError('INTERNAL_ERROR', { message });
}

function resultReceipt(result: RankedResultRecord): RankedReceiptV1<RankedBlackjackOutcomeV1> {
	return {
		sessionId: result.sessionId,
		gameType: result.gameType,
		rulesetVersion: result.rulesetVersion,
		seedCommitment: result.seedCommitment,
		configHash: result.configHash,
		actionLogHash: result.actionLogHash,
		outcome: result.outcome,
		initialWager: result.initialWager,
		committedWager: result.committedWager,
		payout: result.payout,
		gameNetDelta: result.gameNetDelta,
		rewardDelta: result.rewardDelta,
		balanceAfter: result.balanceAfter,
		statsEffects: result.statsEffects,
		achievementEffects: result.achievementEffects,
		rewardEffects: result.rewardEffects,
		settledAt: result.settledAt,
		receiptHash: result.receiptHash,
	};
}

function terminalInput(
	context: ReceiptContext,
	outcome: RankedBlackjackOutcomeV1,
	expectedWalletBalance: number,
	finalAdditionalWager: number,
	settledAt: number,
	rewardDelta: 0 | 100,
	forfeit = false,
): TerminalTransitionInput {
	const statsEffects = {
		sessionsPlayed: 1 as const,
		totalWins: (forfeit ? 0 : outcome.result === 'win' ? 1 : 0) as 0 | 1,
		totalLosses: (forfeit || outcome.result === 'loss' ? 1 : 0) as 0 | 1,
		totalPushes: (forfeit ? 0 : outcome.result === 'push' ? 1 : 0) as 0 | 1,
		totalForfeits: (forfeit ? 1 : 0) as 0 | 1,
		netProfit: outcome.gameNetDelta,
		biggestWin: forfeit ? 0 : Math.max(outcome.gameNetDelta, 0),
	};
	const achievementEffects = rewardDelta === 100 ? (['ranked_debut'] as const) : [];
	const rewardEffects =
		rewardDelta === 100 ? ([{ rewardId: 'ranked_debut_100', chipAmount: 100 }] as const) : [];
	const balanceAfter = expectedWalletBalance - finalAdditionalWager + outcome.payout + rewardDelta;
	const receiptWithoutHash = {
		...context,
		outcome,
		payout: outcome.payout,
		gameNetDelta: outcome.gameNetDelta,
		rewardDelta,
		balanceAfter,
		statsEffects,
		achievementEffects,
		rewardEffects,
		settledAt,
	};
	return {
		expectedWalletBalance,
		finalAdditionalWager,
		payout: outcome.payout,
		gameNetDelta: outcome.gameNetDelta,
		rewardDelta,
		balanceAfter,
		outcomeJson: canonicalizeRanked(outcome),
		statsEffectsJson: canonicalizeRanked(statsEffects),
		achievementEffectsJson: canonicalizeRanked(achievementEffects),
		rewardEffectsJson: canonicalizeRanked(rewardEffects),
		receiptHash: hashCanonical(receiptWithoutHash),
		settledAt,
	};
}

function expirationOutcome(
	session: RankedSessionRecord,
	playerWagers: readonly number[],
): RankedBlackjackOutcomeV1 {
	const wagers =
		playerWagers.length > 0 ? playerWagers : ([session.committedWager] as readonly number[]);
	return {
		result: 'loss',
		hands: wagers.map((wager, handIndex) => ({
			handIndex,
			result: 'loss',
			wager,
			payout: 0,
		})),
		committedWager: session.committedWager,
		payout: 0,
		gameNetDelta: -session.committedWager,
	};
}

function requireRandomBytes(
	randomBytes: RankedCoordinatorDeps['randomBytes'],
	length: number,
): Uint8Array {
	const bytes = randomBytes(length);
	if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
		return internalError('Ranked secure random source returned an invalid byte count');
	}
	return bytes.slice();
}

export function createRankedCoordinator(deps: RankedCoordinatorDeps): RankedCoordinator {
	const log = (
		event: Parameters<typeof createRankedLogEntry>[0],
		identifiers: Parameters<typeof createRankedLogEntry>[1],
	): void => {
		deps.log?.(createRankedLogEntry(event, identifiers));
	};

	const consumeRate = async (
		userId: string,
		operation: 'ranked_start' | 'ranked_action' | 'ranked_resume' | 'ranked_replay',
		nowSeconds: number,
	): Promise<void> => {
		const result = await deps.repository.consumeStandaloneRateLimit(userId, operation, nowSeconds);
		if (result.kind === 'rate-limited') {
			log('ranked_rate_limited', { userId });
			throw new RankedServiceError('RATE_LIMITED', { retryAfter: result.retryAfter });
		}
	};

	const classifyMembership = (resolution: MembershipResolution, userId: string): void => {
		if (resolution.kind === 'orphaned') {
			log('ranked_mp_escrow_orphaned', { userId });
			throw new RankedServiceError('MULTIPLAYER_ESCROW_ORPHANED');
		}
		if (resolution.kind !== 'clear') {
			throw new RankedServiceError('MULTIPLAYER_CONFLICT');
		}
	};

	const resolveMembership = (userId: string, nowMs: number): Promise<MembershipResolution> =>
		deps.reconcileMembership({
			db: deps.membershipDb,
			namespace: deps.membershipNamespace,
			userId,
			nowMs,
		});

	const reconcileMembership = async (userId: string, nowMs: number): Promise<void> => {
		classifyMembership(await resolveMembership(userId, nowMs), userId);
	};

	const reconcileCurrentActionMembership = async (userId: string, nowMs: number): Promise<void> => {
		const resolution = await resolveMembership(userId, nowMs);
		if (resolution.kind === 'clear') return;
		classifyMembership(resolution, userId);
	};

	const replay = async (session: RankedSessionRecord) => {
		const adapter = deps.getAdapter(session.gameType, session.rulesetVersion);
		const seed = decodeCanonicalBase64Url(session.seed);
		return {
			adapter,
			replay: await adapter.replay(seed, session.config, session.actionLog),
		};
	};

	const render = async (
		session: RankedSessionRecord,
		storedResult?: RankedResultRecord | null,
	): Promise<RankedCoordinatorResponse> => {
		const account = await deps.repository.readAccount(session.userId);
		if (!account) return internalError('Ranked account disappeared');
		const replayed = await replay(session);
		const result =
			storedResult === undefined
				? session.status === 'active'
					? null
					: await deps.repository.findResult(session.id)
				: storedResult;
		if (session.status !== 'active' && !result) {
			return internalError('Ranked terminal session has no stored result');
		}
		const balance = result ? result.balanceAfter : account.chipBalance;
		if (!rankedBalanceSchema.safeParse(balance).success) {
			return internalError('Ranked response balance is invalid');
		}
		const projected = replayed.adapter.project(replayed.replay, account.chipBalance);
		const state =
			session.status === 'expired' && result
				? {
						...replayed.adapter.projectTerminal(replayed.replay, account.chipBalance),
						availableActions: [],
						outcome: result.outcome,
					}
				: projected;
		return {
			sessionId: session.id,
			status: session.status,
			gameType: session.gameType,
			rulesetVersion: session.rulesetVersion,
			seedCommitment: session.seedCommitment,
			expiresAt: session.expiresAt,
			nextSequence: session.nextSequence,
			balance,
			state,
			receipt: result ? resultReceipt(result) : null,
		};
	};

	const readAndRender = async (
		userId: string,
		sessionId: string,
		result?: RankedResultRecord | null,
	): Promise<RankedCoordinatorResponse> => {
		const current = await deps.repository.findOwnedSession(userId, sessionId);
		if (!current) return internalError('Ranked transition did not store its session');
		return render(current, result);
	};

	const expireOwned = async (
		userId: string,
		sessionId: string,
	): Promise<RankedCoordinatorResponse> => {
		const nowSeconds = asNowSeconds(deps.now());
		for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
			const session = await deps.repository.findOwnedSession(userId, sessionId);
			if (!session) throw new RankedServiceError('SESSION_NOT_FOUND');
			if (session.status !== 'active') return render(session);
			if (nowSeconds < session.expiresAt) return render(session);

			await reconcileMembership(userId, deps.now().getTime());
			const account = await deps.repository.readAccount(userId);
			if (!account) return internalError('Ranked account disappeared during expiration');
			const replayed = await replay(session);
			const outcome = expirationOutcome(
				session,
				replayed.replay.state.playerHands.map(({ wager }) => wager),
			);
			const terminal = terminalInput(
				{
					sessionId: session.id,
					gameType: session.gameType,
					rulesetVersion: session.rulesetVersion,
					seedCommitment: session.seedCommitment,
					configHash: session.configHash,
					actionLogHash: session.actionLogHash,
					initialWager: session.initialWager,
					committedWager: session.committedWager,
				},
				outcome,
				account.chipBalance,
				0,
				nowSeconds,
				0,
				true,
			);
			const result = await deps.repository.runExpirationTransition({
				userId,
				sessionId,
				nowSeconds,
				terminal,
			});
			if (result.kind === 'applied') {
				log('ranked_session_expired', { userId, sessionId });
				return readAndRender(userId, sessionId, result.result);
			}
			const current = await deps.repository.findOwnedSession(userId, sessionId);
			if (!current) throw new RankedServiceError('SESSION_NOT_FOUND');
			if (current.status !== 'active') return render(current);
			await reconcileMembership(userId, deps.now().getTime());
		}
		throw new RankedServiceError('ACCOUNT_BALANCE_CHANGED');
	};

	const expire = async (sessionId: string): Promise<RankedCoordinatorResponse> => {
		const userId = await deps.repository.findSessionOwner(sessionId);
		if (!userId) throw new RankedServiceError('SESSION_NOT_FOUND');
		return expireOwned(userId, sessionId);
	};

	const start = async ({
		userId,
		body,
	}: {
		userId: string;
		body: RankedStartRequest;
	}): Promise<RankedCoordinatorResponse> => {
		const now = deps.now();
		const nowSeconds = asNowSeconds(now);
		const startPayloadHash = hashCanonical(body);
		const existing = await deps.repository.findByStartRequest(userId, body.requestId);
		if (existing) {
			if (existing.startPayloadHash !== startPayloadHash) {
				await consumeRate(userId, 'ranked_start', nowSeconds);
				throw new RankedServiceError('IDENTIFIER_REUSE_MISMATCH');
			}
			await consumeRate(userId, 'ranked_replay', nowSeconds);
			log('ranked_session_replayed', { userId, sessionId: existing.id });
			if (existing.status === 'active' && nowSeconds >= existing.expiresAt) {
				return expireOwned(userId, existing.id);
			}
			return render(existing);
		}

		let active = await deps.repository.findActiveSession(userId);
		if (active?.status === 'active' && nowSeconds >= active.expiresAt) {
			await expireOwned(userId, active.id);
			active = await deps.repository.findActiveSession(userId);
		}
		if (active) {
			await consumeRate(userId, 'ranked_start', nowSeconds);
			throw new RankedServiceError('ACTIVE_SESSION_EXISTS');
		}

		await consumeRate(userId, 'ranked_start', nowSeconds);
		await reconcileMembership(userId, now.getTime());
		let accountAtStart = await deps.repository.readAccount(userId);
		if (!accountAtStart) return internalError('Ranked account does not exist');
		if (accountAtStart.heldChips > 0) {
			await reconcileMembership(userId, now.getTime());
			accountAtStart = await deps.repository.readAccount(userId);
			if (!accountAtStart) return internalError('Ranked account does not exist');
			if (accountAtStart.heldChips > 0) {
				log('ranked_mp_escrow_orphaned', { userId });
				throw new RankedServiceError('MULTIPLAYER_ESCROW_ORPHANED');
			}
		}
		if (accountAtStart.chipBalance < body.wager) {
			throw new RankedServiceError('INSUFFICIENT_BALANCE');
		}

		const adapter = deps.getAdapter(body.gameType, body.rulesetVersion);
		let issued;
		try {
			issued = await adapter.issue({
				wager: body.wager,
			});
		} catch (error) {
			if (error instanceof RankedServiceError) throw error;
			if (error instanceof RangeError) throw new RankedServiceError('INVALID_WAGER');
			throw error;
		}
		const sessionId = encodeBase64Url(requireRandomBytes(deps.randomBytes, 16));
		const seed = requireRandomBytes(deps.randomBytes, 32);
		const actionLog: readonly RankedBlackjackActionLogEntryV1[] = [];
		const actionLogJson = canonicalizeRanked(actionLog);
		const newSession: NewRankedSessionRecord = {
			id: sessionId,
			startRequestId: body.requestId,
			startPayloadHash,
			gameType: body.gameType,
			rulesetVersion: body.rulesetVersion,
			configJson: issued.configJson,
			configHash: issued.configHash,
			seed: encodeBase64Url(seed),
			seedCommitment: createSeedCommitment(seed),
			actionLogJson,
			actionLogHash: hashCanonical(actionLog),
			initialWager: body.wager,
			committedWager: body.wager,
			expiresAt: nowSeconds + SESSION_TTL_SECONDS,
			createdAt: nowSeconds,
			updatedAt: nowSeconds,
		};
		const openingReplay = await adapter.replay(seed, issued.config, actionLog);
		const openingOutcome = adapter.terminalOutcome(openingReplay);
		let account = accountAtStart;

		for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
			if (account.heldChips > 0) {
				await reconcileMembership(userId, now.getTime());
				throw new RankedServiceError('MULTIPLAYER_ESCROW_ORPHANED');
			}
			if (account.chipBalance < body.wager) {
				throw new RankedServiceError('INSUFFICIENT_BALANCE');
			}
			const receiptContext: ReceiptContext = {
				sessionId,
				gameType: body.gameType,
				rulesetVersion: body.rulesetVersion,
				seedCommitment: newSession.seedCommitment,
				configHash: newSession.configHash,
				actionLogHash: newSession.actionLogHash,
				initialWager: body.wager,
				committedWager: body.wager,
			};
			const expectedWalletBalance = account.chipBalance - body.wager;
			const openingTerminal = openingOutcome
				? terminalInput(receiptContext, openingOutcome, expectedWalletBalance, 0, nowSeconds, 100)
				: undefined;
			const openingNonRewardTerminal = openingOutcome
				? terminalInput(receiptContext, openingOutcome, expectedWalletBalance, 0, nowSeconds, 0)
				: undefined;
			const transition = await deps.repository.runStartTransition({
				userId,
				expectedBalance: account.chipBalance,
				session: newSession,
				rateLimit: { userId, operation: 'ranked_start', nowSeconds },
				rateLimitMode: 'already-consumed',
				openingTerminal,
				openingNonRewardTerminal,
			});
			if (transition.kind === 'created') {
				log(transition.result ? 'ranked_session_settled' : 'ranked_session_started', {
					userId,
					sessionId,
				});
				return readAndRender(userId, sessionId, transition.result);
			}
			if (transition.kind === 'rate-limited') {
				log('ranked_rate_limited', { userId, sessionId });
				throw new RankedServiceError('RATE_LIMITED', {
					retryAfter: transition.retryAfter,
				});
			}

			const winner = await deps.repository.findByStartRequest(userId, body.requestId);
			if (winner) {
				if (winner.startPayloadHash !== startPayloadHash) {
					throw new RankedServiceError('IDENTIFIER_REUSE_MISMATCH');
				}
				return render(winner);
			}
			const blocking = await deps.repository.findActiveSession(userId);
			if (blocking) {
				if (blocking.status === 'active' && nowSeconds >= blocking.expiresAt) {
					await expireOwned(userId, blocking.id);
					account =
						(await deps.repository.readAccount(userId)) ??
						internalError('Ranked account disappeared after expiration');
					continue;
				}
				throw new RankedServiceError('ACTIVE_SESSION_EXISTS');
			}
			if (transition.kind === 'not-created') {
				return internalError('Ranked start conflict could not be classified');
			}
			await reconcileMembership(userId, now.getTime());
			account =
				(await deps.repository.readAccount(userId)) ??
				internalError('Ranked account disappeared during start retry');
			if (account.heldChips > 0) {
				log('ranked_mp_escrow_orphaned', { userId });
				throw new RankedServiceError('MULTIPLAYER_ESCROW_ORPHANED');
			}
			if (account.chipBalance < body.wager) {
				throw new RankedServiceError('INSUFFICIENT_BALANCE');
			}
		}
		throw new RankedServiceError('ACCOUNT_BALANCE_CHANGED');
	};

	const resume = async ({
		userId,
		sessionId,
	}: {
		userId: string;
		sessionId: string;
	}): Promise<RankedCoordinatorResponse> => {
		const nowSeconds = asNowSeconds(deps.now());
		await consumeRate(userId, 'ranked_resume', nowSeconds);
		const session = await deps.repository.findOwnedSession(userId, sessionId);
		if (!session) throw new RankedServiceError('SESSION_NOT_FOUND');
		if (session.status === 'active' && nowSeconds >= session.expiresAt) {
			return expireOwned(userId, sessionId);
		}
		return render(session);
	};

	const act = async ({
		userId,
		sessionId,
		body,
	}: {
		userId: string;
		sessionId: string;
		body: RankedBlackjackActionLogEntryV1;
	}): Promise<RankedCoordinatorResponse> => {
		actionRequestSchema.parse(body);
		const nowSeconds = asNowSeconds(deps.now());
		let session = await deps.repository.findOwnedSession(userId, sessionId);
		if (!session) {
			await consumeRate(userId, 'ranked_action', nowSeconds);
			throw new RankedServiceError('SESSION_NOT_FOUND');
		}

		if (body.sequence < session.nextSequence) {
			if (session.actionLog[body.sequence]?.action !== body.action) {
				await consumeRate(userId, 'ranked_action', nowSeconds);
				log('ranked_action_rejected', { userId, sessionId });
				throw new RankedServiceError('IDENTIFIER_REUSE_MISMATCH');
			}
			await consumeRate(userId, 'ranked_replay', nowSeconds);
			log('ranked_session_replayed', { userId, sessionId });
			if (session.status === 'active' && nowSeconds >= session.expiresAt) {
				return expireOwned(userId, sessionId);
			}
			return render(session);
		}
		if (body.sequence > session.nextSequence) {
			await consumeRate(userId, 'ranked_action', nowSeconds);
			throw new RankedServiceError('SEQUENCE_MISMATCH', {
				expectedSequence: session.nextSequence,
			});
		}
		if (session.status !== 'active') {
			await consumeRate(userId, 'ranked_replay', nowSeconds);
			return render(session);
		}
		if (nowSeconds >= session.expiresAt) {
			await consumeRate(userId, 'ranked_action', nowSeconds);
			return expireOwned(userId, sessionId);
		}

		await consumeRate(userId, 'ranked_action', nowSeconds);
		await reconcileCurrentActionMembership(userId, deps.now().getTime());
		for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
			// Re-capture nowSeconds per retry so the expiration check and
			// transition timestamps reflect the current wall clock rather than
			// the value captured before the first attempt. Within a single
			// iteration, all fields share the same attemptNowSeconds to avoid
			// createdAt/expiresAt skew within one transition record.
			const attemptNowSeconds = asNowSeconds(deps.now());
			if (session.status !== 'active') return render(session);
			if (body.sequence !== session.nextSequence) {
				if (
					body.sequence < session.nextSequence &&
					session.actionLog[body.sequence]?.action === body.action
				) {
					return render(session);
				}
				if (body.sequence < session.nextSequence) {
					throw new RankedServiceError('IDENTIFIER_REUSE_MISMATCH');
				}
				throw new RankedServiceError('SEQUENCE_MISMATCH', {
					expectedSequence: session.nextSequence,
				});
			}
			if (attemptNowSeconds >= session.expiresAt) return expireOwned(userId, sessionId);

			const replayed = await replay(session);
			const legal = replayed.replay.legalActions.find(({ action }) => action === body.action);
			if (!legal) {
				throw new RankedServiceError('INVALID_ACTION');
			}
			const account = await deps.repository.readAccount(userId);
			if (!account) return internalError('Ranked account disappeared during action');
			if (account.chipBalance < legal.additionalWager) {
				throw new RankedServiceError('INSUFFICIENT_BALANCE');
			}
			const actionLog = [...session.actionLog, body];
			const nextReplay = await replayed.adapter.replay(
				decodeCanonicalBase64Url(session.seed),
				session.config,
				actionLog,
			);
			const outcome = replayed.adapter.terminalOutcome(nextReplay);
			const actionLogJson = canonicalizeRanked(actionLog);
			const actionLogHash = hashCanonical(actionLog);
			const input: ActionTransitionInput = {
				userId,
				sessionId,
				expectedSequence: body.sequence,
				actionLogJson,
				actionLogHash,
				additionalWager: legal.additionalWager,
				committedWager: nextReplay.state.committedWager,
				nowSeconds: attemptNowSeconds,
				rateLimitMode: 'already-consumed',
			};
			if (outcome) {
				const receiptContext: ReceiptContext = {
					sessionId,
					gameType: session.gameType,
					rulesetVersion: session.rulesetVersion,
					seedCommitment: session.seedCommitment,
					configHash: session.configHash,
					actionLogHash,
					initialWager: session.initialWager,
					committedWager: nextReplay.state.committedWager,
				};
				input.terminal = terminalInput(
					receiptContext,
					outcome,
					account.chipBalance,
					legal.additionalWager,
					attemptNowSeconds,
					100,
				);
				input.nonRewardTerminal = terminalInput(
					receiptContext,
					outcome,
					account.chipBalance,
					legal.additionalWager,
					attemptNowSeconds,
					0,
				);
			}

			const transition = outcome
				? await deps.repository.runTerminalTransition({
						...input,
						terminal: input.terminal!,
					})
				: await deps.repository.runActionTransition(input);
			if (transition.kind === 'rate-limited') {
				log('ranked_rate_limited', { userId, sessionId });
				throw new RankedServiceError('RATE_LIMITED', {
					retryAfter: transition.retryAfter,
				});
			}
			if (transition.kind === 'applied') {
				log(transition.result ? 'ranked_session_settled' : 'ranked_action_accepted', {
					userId,
					sessionId,
				});
				return readAndRender(userId, sessionId, transition.result);
			}

			const current = await deps.repository.findOwnedSession(userId, sessionId);
			if (!current) throw new RankedServiceError('SESSION_NOT_FOUND');
			if (current.nextSequence > body.sequence) {
				if (current.actionLog[body.sequence]?.action !== body.action) {
					throw new RankedServiceError('IDENTIFIER_REUSE_MISMATCH');
				}
				return render(current);
			}
			if (current.nextSequence < body.sequence) {
				throw new RankedServiceError('SEQUENCE_MISMATCH', {
					expectedSequence: current.nextSequence,
				});
			}
			if (current.status !== 'active') return render(current);
			session = current;
			await reconcileMembership(userId, deps.now().getTime());
			const freshAccount = await deps.repository.readAccount(userId);
			if (!freshAccount) return internalError('Ranked account disappeared during action retry');
			if (freshAccount.chipBalance < legal.additionalWager) {
				throw new RankedServiceError('INSUFFICIENT_BALANCE');
			}
			if (!outcome) throw new RankedServiceError('ACCOUNT_BALANCE_CHANGED');
		}
		throw new RankedServiceError('ACCOUNT_BALANCE_CHANGED');
	};

	return { start, resume, act, expire };
}
