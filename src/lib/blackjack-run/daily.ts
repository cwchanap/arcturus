import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes } from '@noble/hashes/utils.js';
import type { Card } from '../blackjack/types';
import {
	encodeUint64BigEndian,
	projectBlackjackRoundReplay,
	replayBlackjackRoundWithDeck,
	shuffleDeck,
	type BlackjackPublicRoundState,
	type BlackjackRoundReplay,
} from './engine';
import {
	periodKeySchema,
	BlackjackRunError,
	type BlackjackAction,
	type BlackjackRunCommand,
} from './protocol';
import { getDailyPeriodKey } from '../missions/periods';

export { getDailyPeriodKey };

// --- Daily constants ---

export const DAILY_RUN_CONFIG = Object.freeze({
	startingBankroll: 1000,
	roundCount: 10,
	minimumWager: 10,
	maximumWager: 1000,
	attemptTtlSeconds: 1800,
	rankedEntryCloseOffsetSeconds: 1800,
});

// --- UTC daily window ---

export interface DailyWindow {
	readonly periodKey: string;
	readonly startsAt: number;
	readonly rankedEntryClosesAt: number;
	readonly endsAt: number;
}

// Derives the canonical UTC window for a persisted periodKey. Calendar-validates
// the key so a malformed migration or corrupted row (e.g. "2025-13-45") cannot
// masquerade as a real day, then recomputes startsAt / rankedEntryClosesAt /
// endsAt from the validated key. This is the fail-closed boundary used when
// rehydrating persisted daily rows: callers must require exact equality
// against the persisted timestamps.
export function getDailyWindowForPeriodKey(periodKey: string): DailyWindow {
	if (!periodKeySchema.safeParse(periodKey).success) {
		throw new TypeError('Daily period key must be a YYYY-MM-DD string');
	}
	const startsAtMs = Date.parse(`${periodKey}T00:00:00.000Z`);
	if (Number.isNaN(startsAtMs)) {
		throw new RangeError('Daily period key must resolve to a valid UTC date');
	}
	// Round-trip through Date to reject non-existent calendar dates (e.g.
	// 2025-02-30 normalizes to 2025-03-02 in V8). The re-formatted key must
	// match the input exactly.
	const roundTripped = new Date(startsAtMs).toISOString().slice(0, 10);
	if (roundTripped !== periodKey) {
		throw new RangeError('Daily period key is not a real calendar date');
	}
	const startsAt = Math.trunc(startsAtMs / 1000);
	const endsAt = startsAt + 24 * 60 * 60;
	return {
		periodKey,
		startsAt,
		rankedEntryClosesAt: endsAt - DAILY_RUN_CONFIG.rankedEntryCloseOffsetSeconds,
		endsAt,
	};
}

export function getDailyWindow(nowSeconds: number): DailyWindow {
	if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
		throw new TypeError('Daily time must be a non-negative safe integer');
	}
	const date = new Date(nowSeconds * 1000);
	if (Number.isNaN(date.getTime())) {
		throw new RangeError('Daily time must resolve to a valid date');
	}
	const periodKey = getDailyPeriodKey(date);
	return getDailyWindowForPeriodKey(periodKey);
}

// --- Deterministic per-round seed derivation ---

const SEED_LENGTH = 32;
const ROUND_SEED_DOMAIN = new TextEncoder().encode('arcturus:blackjack-run:daily:round:');

function assertMasterSeed(seed: Uint8Array): void {
	if (!(seed instanceof Uint8Array) || seed.length !== SEED_LENGTH) {
		throw new TypeError('Daily run seed must be exactly 32 bytes');
	}
}

/** Derives the deterministic per-round seed for `roundIndex` from the run master seed. */
export function deriveDailyRoundSeed(masterSeed: Uint8Array, roundIndex: number): Uint8Array {
	assertMasterSeed(masterSeed);
	if (!Number.isSafeInteger(roundIndex) || roundIndex < 0) {
		throw new RangeError('Round index must be a non-negative safe integer');
	}
	return hmac(
		sha256,
		masterSeed,
		concatBytes(ROUND_SEED_DOMAIN, encodeUint64BigEndian(BigInt(roundIndex))),
	);
}

// --- Daily run replay ---

export type DailyDeckSource = (roundIndex: number) => readonly Card[];

export interface DailyRound {
	readonly roundIndex: number;
	readonly initialWager: number;
	readonly actions: readonly BlackjackAction[];
	readonly replay: BlackjackRoundReplay;
}

export interface DailyRunReplay {
	readonly availableBankroll: number;
	readonly roundsCompleted: number;
	readonly rounds: readonly DailyRound[];
	readonly activeRound: DailyRound | null;
	readonly activeRoundPublic: Omit<BlackjackPublicRoundState, 'nextSequence'> | null;
	readonly nextCommandSequence: number;
	readonly status: 'active' | 'completed' | 'forfeited';
	readonly terminalReason: 'completed' | 'bankroll-below-minimum' | 'forfeited' | null;
	readonly eligible: boolean | null;
}

interface MutableRound {
	roundIndex: number;
	initialWager: number;
	actions: BlackjackAction[];
	replay: BlackjackRoundReplay;
	// The deck is deterministic per roundIndex (derived from the master seed), so it is computed
	// once when the round starts and reused for every subsequent replay of that round.
	deck: readonly Card[];
}

interface MutableReplayState {
	readonly deckSource: DailyDeckSource;
	availableBankroll: number;
	roundsCompleted: number;
	rounds: MutableRound[];
	activeRound: MutableRound | null;
	nextCommandSequence: number;
	status: 'active' | 'completed' | 'forfeited';
	terminalReason: 'completed' | 'bankroll-below-minimum' | 'forfeited' | null;
	eligible: boolean | null;
}

function isValidWager(wager: number): boolean {
	return (
		Number.isSafeInteger(wager) &&
		wager >= DAILY_RUN_CONFIG.minimumWager &&
		wager <= DAILY_RUN_CONFIG.maximumWager
	);
}

function replayRound(
	round: Pick<MutableRound, 'initialWager' | 'deck' | 'actions'>,
): BlackjackRoundReplay {
	return replayBlackjackRoundWithDeck(round.initialWager, round.deck.slice(), round.actions);
}

function settleCompletedRound(state: MutableReplayState, replay: BlackjackRoundReplay): void {
	const outcome = replay.outcome;
	if (!outcome) throw new Error('Completed daily round has no outcome');
	state.availableBankroll += outcome.payout;
	state.roundsCompleted += 1;
	state.rounds.push(state.activeRound as MutableRound);
	state.activeRound = null;

	if (state.roundsCompleted === DAILY_RUN_CONFIG.roundCount) {
		state.status = 'completed';
		state.terminalReason = 'completed';
		state.eligible = true;
		return;
	}
	if (state.availableBankroll < DAILY_RUN_CONFIG.minimumWager) {
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
		throw new BlackjackRunError('ATTEMPT_COMPLETE');
	}
	if (state.activeRound) {
		throw new BlackjackRunError('INVALID_COMMAND');
	}
	if (!isValidWager(wager)) {
		throw new BlackjackRunError('INVALID_WAGER');
	}
	if (state.availableBankroll < wager) {
		throw new BlackjackRunError('INSUFFICIENT_CHALLENGE_BANKROLL');
	}

	state.availableBankroll -= wager;
	const roundIndex = state.roundsCompleted;
	const deck = state.deckSource(roundIndex);
	const actions: BlackjackAction[] = [];
	const replay = replayRound({ initialWager: wager, deck, actions });
	const round: MutableRound = {
		roundIndex,
		initialWager: wager,
		actions,
		replay,
		deck,
	};
	state.activeRound = round;
	maybeSettleActiveRound(state);
}

function applyBlackjackAction(state: MutableReplayState, action: BlackjackAction): void {
	if (state.status !== 'active') {
		throw new BlackjackRunError('ATTEMPT_COMPLETE');
	}
	const round = state.activeRound;
	if (!round) {
		throw new BlackjackRunError('INVALID_COMMAND');
	}

	const legalEntry = round.replay.legalActions.find((entry) => entry.action === action);
	if (!legalEntry) {
		throw new BlackjackRunError('INVALID_COMMAND');
	}
	if (legalEntry.additionalWager > 0) {
		if (state.availableBankroll < legalEntry.additionalWager) {
			throw new BlackjackRunError('INSUFFICIENT_CHALLENGE_BANKROLL');
		}
		state.availableBankroll -= legalEntry.additionalWager;
	}

	round.actions.push(action);
	round.replay = replayRound(round);
	maybeSettleActiveRound(state);
}

function applyForfeit(state: MutableReplayState): void {
	if (state.status !== 'active') {
		throw new BlackjackRunError('ATTEMPT_COMPLETE');
	}
	state.status = 'forfeited';
	state.terminalReason = 'forfeited';
	state.eligible = false;
}

function projectActiveRound(
	state: MutableReplayState,
): Omit<BlackjackPublicRoundState, 'nextSequence'> | null {
	const round = state.activeRound;
	if (!round || state.status !== 'active') return null;
	const projected = projectBlackjackRoundReplay(round.replay, state.availableBankroll);
	const { nextSequence: _omitted, ...publicState } = projected;
	void _omitted;
	return publicState;
}

function snapshotReplay(state: MutableReplayState): DailyRunReplay {
	const frozenRounds = state.rounds.map((round) => ({
		roundIndex: round.roundIndex,
		initialWager: round.initialWager,
		actions: [...round.actions],
		replay: round.replay,
	}));
	const frozenActive = state.activeRound
		? {
				roundIndex: state.activeRound.roundIndex,
				initialWager: state.activeRound.initialWager,
				actions: [...state.activeRound.actions],
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

/**
 * Replays a full Daily run from the master seed and an ordered command log.
 * `deckSource` is a determinism/test seam; production callers omit it and each
 * round derives its deck from the master seed.
 */
export function replayDailyRun(
	seed: Uint8Array,
	commands: readonly BlackjackRunCommand[],
	deckSource?: DailyDeckSource,
): DailyRunReplay {
	const resolvedDeckSource: DailyDeckSource =
		deckSource ?? ((roundIndex) => shuffleDeck(deriveDailyRoundSeed(seed, roundIndex)));

	const state: MutableReplayState = {
		deckSource: resolvedDeckSource,
		availableBankroll: DAILY_RUN_CONFIG.startingBankroll,
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
			throw new BlackjackRunError('SEQUENCE_MISMATCH', {
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

// --- Daily score ordering and percentile standing ---

export interface DailyScore {
	readonly endingBankroll: number;
	readonly roundsCompleted: number;
}

export function compareDailyScores(left: DailyScore, right: DailyScore): number {
	if (left.endingBankroll !== right.endingBankroll) {
		return right.endingBankroll - left.endingBankroll;
	}
	return right.roundsCompleted - left.roundsCompleted;
}

export function calculateDailyPercentile(
	totalEligible: number,
	playersStrictlyAbove: number,
): number {
	if (!Number.isSafeInteger(totalEligible) || totalEligible < 1) {
		throw new RangeError('An eligible result requires at least one eligible player');
	}
	if (
		!Number.isSafeInteger(playersStrictlyAbove) ||
		playersStrictlyAbove < 0 ||
		playersStrictlyAbove >= totalEligible
	) {
		throw new RangeError('Players strictly above is outside the eligible population');
	}
	const playersAtOrBelow = totalEligible - playersStrictlyAbove;
	return Math.min(100, Math.max(1, Math.round((100 * playersAtOrBelow) / totalEligible)));
}
