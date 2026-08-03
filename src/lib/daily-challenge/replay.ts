import type { Card } from '../blackjack/types';
import { issueBlackjackConfig } from '../ranked/blackjack/adapter';
import { replayRankedBlackjack } from '../ranked/blackjack/engine';
import { projectRankedBlackjackReplay } from '../ranked/blackjack/projection';
import type { RankedBlackjackAction, RankedBlackjackActionLogEntryV1 } from '../ranked/protocol';
import { shuffleRankedDeck } from '../ranked/random';
import type {
	RankedBlackjackPublicStateV1,
	RankedBlackjackReplay,
} from '../ranked/blackjack/types';
import { deriveDailyChallengeRoundSeed } from './random';
import { DailyChallengeServiceError, type DailyChallengeCommandV1 } from './protocol';

export interface DailyChallengeConfigV1 {
	readonly challengeKind: 'blackjack-daily';
	readonly challengeRulesetVersion: 'blackjack-daily-v1';
	readonly gameType: 'blackjack';
	readonly gameRulesetVersion: 'blackjack-ranked-v1';
	readonly scoreVersion: 'blackjack-daily-score-v1';
	readonly startingBankroll: number;
	readonly roundCount: number;
	readonly minimumWager: number;
	readonly maximumWager: number;
	readonly attemptTtlSeconds: number;
	readonly rankedEntryCloseOffsetSeconds: number;
}

export interface DailyChallengeInternalRoundV1 {
	readonly roundIndex: number;
	readonly initialWager: number;
	readonly adapterActions: readonly RankedBlackjackActionLogEntryV1[];
	readonly replay: RankedBlackjackReplay;
}

export interface DailyChallengeReplayV1 {
	readonly availableBankroll: number;
	readonly roundsCompleted: number;
	readonly rounds: readonly DailyChallengeInternalRoundV1[];
	readonly activeRound: DailyChallengeInternalRoundV1 | null;
	readonly activeRoundPublic: Omit<RankedBlackjackPublicStateV1, 'nextSequence'> | null;
	readonly nextCommandSequence: number;
	readonly status: 'active' | 'completed' | 'forfeited';
	readonly terminalReason: 'completed' | 'bankroll-below-minimum' | 'forfeited' | null;
	readonly eligible: boolean | null;
}

export type DailyChallengeDeckSource = (roundIndex: number) => readonly Card[];

interface MutableInternalRound {
	roundIndex: number;
	initialWager: number;
	adapterActions: RankedBlackjackActionLogEntryV1[];
	replay: RankedBlackjackReplay;
	// Deck is deterministic per roundIndex (derived from the master seed), so it is computed
	// once when the round starts and reused for every subsequent replay of that round.
	deck: readonly Card[];
}

interface MutableReplayState {
	readonly config: DailyChallengeConfigV1;
	readonly deckSource: DailyChallengeDeckSource;
	availableBankroll: number;
	roundsCompleted: number;
	rounds: MutableInternalRound[];
	activeRound: MutableInternalRound | null;
	nextCommandSequence: number;
	status: 'active' | 'completed' | 'forfeited';
	terminalReason: 'completed' | 'bankroll-below-minimum' | 'forfeited' | null;
	eligible: boolean | null;
}

function isValidWager(wager: number, config: DailyChallengeConfigV1): boolean {
	return (
		Number.isSafeInteger(wager) && wager >= config.minimumWager && wager <= config.maximumWager
	);
}

function replayRound(round: MutableInternalRound): RankedBlackjackReplay {
	return replayRankedBlackjack(
		issueBlackjackConfig(round.initialWager),
		round.deck.slice(),
		round.adapterActions,
	);
}

function settleCompletedRound(state: MutableReplayState, replay: RankedBlackjackReplay): void {
	const outcome = replay.outcome;
	if (!outcome) throw new Error('Completed daily challenge round has no outcome');
	state.availableBankroll += outcome.payout;
	state.roundsCompleted += 1;
	state.rounds.push(state.activeRound as MutableInternalRound);
	state.activeRound = null;

	if (state.roundsCompleted === state.config.roundCount) {
		state.status = 'completed';
		state.terminalReason = 'completed';
		state.eligible = true;
		return;
	}
	if (state.availableBankroll < state.config.minimumWager) {
		state.status = 'completed';
		state.terminalReason = 'bankroll-below-minimum';
		state.eligible = true;
	}
}

function maybeSettleActiveRound(state: MutableReplayState): void {
	const round = state.activeRound;
	if (!round) return;
	if (round.replay.outcome) settleCompletedRound(state, round.replay);
}

function applyStartRound(state: MutableReplayState, wager: number): void {
	if (state.status !== 'active') {
		throw new DailyChallengeServiceError('ATTEMPT_COMPLETE');
	}
	if (state.activeRound) {
		throw new DailyChallengeServiceError('INVALID_COMMAND');
	}
	if (!isValidWager(wager, state.config)) {
		throw new DailyChallengeServiceError('INVALID_WAGER');
	}
	if (state.availableBankroll < wager) {
		throw new DailyChallengeServiceError('INSUFFICIENT_CHALLENGE_BANKROLL');
	}

	state.availableBankroll -= wager;
	const roundIndex = state.roundsCompleted;
	const deck = state.deckSource(roundIndex);
	const round: MutableInternalRound = {
		roundIndex,
		initialWager: wager,
		adapterActions: [],
		replay: undefined as unknown as RankedBlackjackReplay,
		deck,
	};
	round.replay = replayRound(round);
	state.activeRound = round;
	maybeSettleActiveRound(state);
}

function applyBlackjackAction(state: MutableReplayState, action: RankedBlackjackAction): void {
	if (state.status !== 'active') {
		throw new DailyChallengeServiceError('ATTEMPT_COMPLETE');
	}
	const round = state.activeRound;
	if (!round) {
		throw new DailyChallengeServiceError('INVALID_COMMAND');
	}

	const legalEntry = round.replay.legalActions.find((entry) => entry.action === action);
	if (!legalEntry) {
		throw new DailyChallengeServiceError('INVALID_COMMAND');
	}
	if (legalEntry.additionalWager > 0) {
		if (state.availableBankroll < legalEntry.additionalWager) {
			throw new DailyChallengeServiceError('INSUFFICIENT_CHALLENGE_BANKROLL');
		}
		state.availableBankroll -= legalEntry.additionalWager;
	}

	round.adapterActions.push({ sequence: round.adapterActions.length, action });
	round.replay = replayRound(round);
	maybeSettleActiveRound(state);
}

function applyForfeit(state: MutableReplayState): void {
	if (state.status !== 'active') {
		throw new DailyChallengeServiceError('ATTEMPT_COMPLETE');
	}
	state.status = 'forfeited';
	state.terminalReason = 'forfeited';
	state.eligible = false;
}

function projectActiveRound(
	state: MutableReplayState,
): Omit<RankedBlackjackPublicStateV1, 'nextSequence'> | null {
	const round = state.activeRound;
	if (!round || state.status !== 'active') return null;
	const projected = projectRankedBlackjackReplay(round.replay, state.availableBankroll);
	const { nextSequence: _omitted, ...publicState } = projected;
	void _omitted;
	return publicState;
}

function snapshotReplay(state: MutableReplayState): DailyChallengeReplayV1 {
	const frozenRounds = state.rounds.map((round) => ({
		roundIndex: round.roundIndex,
		initialWager: round.initialWager,
		adapterActions: round.adapterActions.map((entry) => ({ ...entry })),
		replay: round.replay,
	}));
	const frozenActive = state.activeRound
		? {
				roundIndex: state.activeRound.roundIndex,
				initialWager: state.activeRound.initialWager,
				adapterActions: state.activeRound.adapterActions.map((entry) => ({ ...entry })),
				replay: state.activeRound.replay,
			}
		: null;

	return {
		availableBankroll: state.availableBankroll,
		roundsCompleted: state.roundsCompleted,
		rounds: frozenRounds,
		activeRound: frozenActive,
		activeRoundPublic: projectActiveRound(state),
		nextCommandSequence: state.nextCommandSequence,
		status: state.status,
		terminalReason: state.terminalReason,
		eligible: state.eligible,
	};
}

export function replayDailyChallenge(
	config: DailyChallengeConfigV1,
	masterSeed: Uint8Array,
	commands: readonly DailyChallengeCommandV1[],
	deckSource?: DailyChallengeDeckSource,
): DailyChallengeReplayV1 {
	const resolvedDeckSource: DailyChallengeDeckSource =
		deckSource ??
		((roundIndex) =>
			shuffleRankedDeck(
				deriveDailyChallengeRoundSeed(config.challengeRulesetVersion, masterSeed, roundIndex),
			));

	const state: MutableReplayState = {
		config,
		deckSource: resolvedDeckSource,
		availableBankroll: config.startingBankroll,
		roundsCompleted: 0,
		rounds: [],
		activeRound: null,
		nextCommandSequence: 0,
		status: 'active',
		terminalReason: null,
		eligible: null,
	};

	for (const command of commands) {
		if (command.sequence !== state.nextCommandSequence) {
			throw new DailyChallengeServiceError('SEQUENCE_MISMATCH', {
				expectedSequence: state.nextCommandSequence,
			});
		}
		state.nextCommandSequence += 1;

		switch (command.command) {
			case 'start-round':
				applyStartRound(state, command.wager);
				break;
			case 'hit':
			case 'stand':
			case 'double-down':
			case 'split':
				applyBlackjackAction(state, command.command);
				break;
			case 'forfeit':
				applyForfeit(state);
				break;
		}
	}

	return snapshotReplay(state);
}
