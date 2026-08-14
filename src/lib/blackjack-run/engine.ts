import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { shouldDealerHit } from '../blackjack/dealerStrategy';
import {
	calculateHandValue,
	canDoubleDown,
	canSplit,
	compareHands,
	isBlackjack,
	isBust,
} from '../blackjack/handEvaluator';
import type { Card, Hand, HandValue, Rank, Suit } from '../blackjack/types';
import { BlackjackRunError, type BlackjackAction } from './protocol';

// --- Rule constants ---

export const MINIMUM_WAGER = 10;
export const MAXIMUM_WAGER = 1000;
const MAXIMUM_HANDS = 4;
const BLACKJACK_PAYOUT_NUMERATOR = 3;
const BLACKJACK_PAYOUT_DENOMINATOR = 2;

// --- Deterministic seed/deck machinery ---

const SEED_LENGTH = 32;
const UINT32_RANGE = 0x1_0000_0000;
const MAX_UINT64 = 0xffff_ffff_ffff_ffffn;
const DECK_DOMAIN = new TextEncoder().encode('arcturus:blackjack-run:deck');
const SUITS: readonly Suit[] = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS: readonly Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function assertSeed(seed: Uint8Array): void {
	if (!(seed instanceof Uint8Array) || seed.length !== SEED_LENGTH) {
		throw new TypeError('Run seed must be exactly 32 bytes');
	}
}

function assertUpperBound(exclusiveUpperBound: number): void {
	if (
		!Number.isSafeInteger(exclusiveUpperBound) ||
		exclusiveUpperBound <= 0 ||
		exclusiveUpperBound > UINT32_RANGE
	) {
		throw new RangeError('Exclusive upper bound must be an integer from 1 through 2^32');
	}
}

export function encodeUint64BigEndian(counter: bigint): Uint8Array {
	if (typeof counter !== 'bigint' || counter < 0n || counter > MAX_UINT64) {
		throw new RangeError('Counter must be an unsigned 64-bit integer');
	}
	const encoded = new Uint8Array(8);
	let remaining = counter;
	for (let offset = encoded.length - 1; offset >= 0; offset -= 1) {
		encoded[offset] = Number(remaining & 0xffn);
		remaining >>= 8n;
	}
	return encoded;
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
	return (
		bytes[offset] * 0x1_000_000 +
		bytes[offset + 1] * 0x1_0000 +
		bytes[offset + 2] * 0x100 +
		bytes[offset + 3]
	);
}

function deriveCounterBlock(seed: Uint8Array, counter: bigint): Uint8Array {
	assertSeed(seed);
	return hmac(sha256, seed, concatBytes(DECK_DOMAIN, encodeUint64BigEndian(counter)));
}

function createRandomSource(seed: Uint8Array): { nextInt(exclusiveUpperBound: number): number } {
	assertSeed(seed);
	const ownedSeed = seed.slice();
	let counter = 0n;
	let block = new Uint8Array();
	let offset = 0;

	const nextUint32 = (): number => {
		if (offset + 4 > block.length) {
			block = deriveCounterBlock(ownedSeed, counter);
			counter += 1n;
			offset = 0;
		}
		const value = readUint32BigEndian(block, offset);
		offset += 4;
		return value;
	};

	return {
		nextInt(exclusiveUpperBound: number): number {
			assertUpperBound(exclusiveUpperBound);
			const limit = Math.floor(UINT32_RANGE / exclusiveUpperBound) * exclusiveUpperBound;
			for (;;) {
				const value = nextUint32();
				if (value < limit) return value % exclusiveUpperBound;
			}
		},
	};
}

/** Deterministically shuffles a fresh single deck from a 32-byte seed. */
export function shuffleDeck(seed: Uint8Array): Card[] {
	const random = createRandomSource(seed);
	const deck: Card[] = [];
	for (const suit of SUITS) {
		for (const rank of RANKS) {
			deck.push({ rank, suit });
		}
	}
	for (let index = deck.length - 1; index > 0; index -= 1) {
		const swapIndex = random.nextInt(index + 1);
		[deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
	}
	return deck;
}

// --- Public types ---

export interface BlackjackRoundHand {
	readonly cards: readonly Card[];
	readonly wager: number;
}

export interface BlackjackRoundDealerHand {
	readonly cards: readonly Card[];
}

export interface BlackjackRoundState {
	readonly phase: 'player-turn' | 'complete';
	readonly playerHands: readonly BlackjackRoundHand[];
	readonly activeHandIndex: number;
	readonly dealerHand: BlackjackRoundDealerHand;
	readonly deckCursor: number;
	readonly committedWager: number;
}

export interface BlackjackLegalAction {
	readonly action: BlackjackAction;
	readonly additionalWager: number;
}

export type BlackjackHandResult = 'win' | 'loss' | 'push' | 'blackjack';
export type BlackjackSessionResult = 'win' | 'loss' | 'push';

export interface BlackjackHandOutcome {
	readonly handIndex: number;
	readonly result: BlackjackHandResult;
	readonly wager: number;
	readonly payout: number;
}

export interface BlackjackRoundOutcome {
	readonly result: BlackjackSessionResult;
	readonly hands: readonly BlackjackHandOutcome[];
	readonly committedWager: number;
	readonly payout: number;
	readonly gameNetDelta: number;
}

export interface BlackjackRoundReplay {
	readonly state: BlackjackRoundState;
	readonly nextSequence: number;
	readonly legalActions: readonly BlackjackLegalAction[];
	readonly outcome: BlackjackRoundOutcome | null;
}

export interface BlackjackPublicHand {
	readonly cards: readonly Card[];
	readonly wager: number;
	readonly value: HandValue;
}

export interface BlackjackPublicDealer {
	readonly cards: readonly Card[];
	readonly value: HandValue;
}

export interface BlackjackPublicRoundState {
	readonly phase: 'player-turn' | 'complete';
	readonly playerHands: readonly BlackjackPublicHand[];
	readonly activeHandIndex: number;
	readonly dealer: BlackjackPublicDealer;
	readonly committedWager: number;
	readonly nextSequence: number;
	readonly availableActions: readonly BlackjackAction[];
	readonly outcome: BlackjackRoundOutcome | null;
}

// --- Engine internals ---

interface MutableHand {
	cards: Card[];
	wager: number;
}

interface MutableState {
	phase: 'player-turn' | 'complete';
	playerHands: MutableHand[];
	activeHandIndex: number;
	dealerHand: { cards: Card[] };
	deckCursor: number;
	committedWager: number;
}

function assertWager(initialWager: number): void {
	if (
		!Number.isSafeInteger(initialWager) ||
		initialWager < MINIMUM_WAGER ||
		initialWager > MAXIMUM_WAGER
	) {
		throw new RangeError('Initial wager is outside blackjack-run limits');
	}
}

function assertDeck(deck: readonly Card[]): void {
	if (deck.length !== 52) {
		throw new RangeError('Blackjack run requires exactly 52 cards');
	}
	const identities = new Set(deck.map(({ rank, suit }) => `${rank}:${suit}`));
	if (identities.size !== deck.length) {
		throw new TypeError('Blackjack run requires 52 unique cards');
	}
}

function asCasualHand(cards: readonly Card[], wager: number, isDealer: boolean): Hand {
	return {
		cards: [...cards],
		bet: wager,
		isDealer,
	};
}

function isBlackjackHand(hand: MutableHand): boolean {
	return isBlackjack(asCasualHand(hand.cards, hand.wager, false));
}

function isBustHand(hand: MutableHand): boolean {
	return isBust(asCasualHand(hand.cards, hand.wager, false));
}

function isDealerBlackjack(state: MutableState): boolean {
	return isBlackjack(asCasualHand(state.dealerHand.cards, 0, true));
}

function isDealerBust(state: MutableState): boolean {
	return isBust(asCasualHand(state.dealerHand.cards, 0, true));
}

function dealCard(state: MutableState, deck: readonly Card[]): Card {
	const card = deck[deck.length - 1 - state.deckCursor];
	if (!card) {
		throw new RangeError('Blackjack run deck is exhausted');
	}
	state.deckCursor += 1;
	return { ...card };
}

function createMutableInitialState(initialWager: number, deck: readonly Card[]): MutableState {
	assertWager(initialWager);
	assertDeck(deck);

	const state: MutableState = {
		phase: 'player-turn',
		playerHands: [{ cards: [], wager: initialWager }],
		activeHandIndex: 0,
		dealerHand: { cards: [] },
		deckCursor: 0,
		committedWager: initialWager,
	};
	state.playerHands[0].cards.push(dealCard(state, deck), dealCard(state, deck));
	state.dealerHand.cards.push(dealCard(state, deck), dealCard(state, deck));

	if (isBlackjackHand(state.playerHands[0]) || isDealerBlackjack(state)) {
		state.phase = 'complete';
	}
	return state;
}

function snapshotState(state: MutableState): BlackjackRoundState {
	return {
		phase: state.phase,
		playerHands: state.playerHands.map(
			(hand): BlackjackRoundHand => ({
				cards: hand.cards.map((card) => ({ ...card })),
				wager: hand.wager,
			}),
		),
		activeHandIndex: state.activeHandIndex,
		dealerHand: {
			cards: state.dealerHand.cards.map((card) => ({ ...card })),
		},
		deckCursor: state.deckCursor,
		committedWager: state.committedWager,
	};
}

function getLegalActions(state: MutableState): BlackjackLegalAction[] {
	if (state.phase !== 'player-turn') return [];

	const activeHand = state.playerHands[state.activeHandIndex];
	const casualHand = asCasualHand(activeHand.cards, activeHand.wager, false);
	const actions: BlackjackLegalAction[] = [
		{ action: 'hit', additionalWager: 0 },
		{ action: 'stand', additionalWager: 0 },
	];
	if (canDoubleDown(casualHand)) {
		actions.push({ action: 'double-down', additionalWager: activeHand.wager });
	}
	if (state.playerHands.length < MAXIMUM_HANDS && canSplit(casualHand)) {
		actions.push({ action: 'split', additionalWager: activeHand.wager });
	}
	return actions;
}

function finishPlayerTurn(state: MutableState, deck: readonly Card[]): void {
	if (!state.playerHands.every(isBustHand)) {
		const dealerHand = asCasualHand(state.dealerHand.cards, 0, true);
		while (shouldDealerHit(dealerHand)) {
			const card = dealCard(state, deck);
			state.dealerHand.cards.push(card);
			dealerHand.cards.push(card);
		}
	}
	state.phase = 'complete';
}

function completeActiveHand(state: MutableState, deck: readonly Card[]): void {
	if (state.activeHandIndex < state.playerHands.length - 1) {
		state.activeHandIndex += 1;
		return;
	}
	finishPlayerTurn(state, deck);
}

function applyAction(state: MutableState, deck: readonly Card[], action: BlackjackAction): void {
	const activeHand = state.playerHands[state.activeHandIndex];
	switch (action) {
		case 'hit': {
			activeHand.cards.push(dealCard(state, deck));
			if (isBustHand(activeHand)) completeActiveHand(state, deck);
			return;
		}
		case 'stand':
			completeActiveHand(state, deck);
			return;
		case 'double-down': {
			const additionalWager = activeHand.wager;
			activeHand.wager += additionalWager;
			state.committedWager += additionalWager;
			activeHand.cards.push(dealCard(state, deck));
			completeActiveHand(state, deck);
			return;
		}
		case 'split': {
			const [firstCard, secondCard] = activeHand.cards;
			const firstHandDraw = dealCard(state, deck);
			const secondHandDraw = dealCard(state, deck);
			const newHand: MutableHand = {
				cards: [secondCard, secondHandDraw],
				wager: activeHand.wager,
			};
			activeHand.cards = [firstCard, firstHandDraw];
			state.playerHands.push(newHand);
			state.committedWager += activeHand.wager;
			return;
		}
	}
}

function settleHand(
	state: MutableState,
	hand: MutableHand,
	handIndex: number,
): BlackjackHandOutcome {
	const playerBlackjack = isBlackjackHand(hand);
	const dealerBlackjack = isDealerBlackjack(state);
	const playerBust = isBustHand(hand);
	const dealerBust = isDealerBust(state);

	if (playerBlackjack && dealerBlackjack) {
		return { handIndex, result: 'push', wager: hand.wager, payout: hand.wager };
	}
	if (playerBlackjack) {
		return {
			handIndex,
			result: 'blackjack',
			wager: hand.wager,
			payout:
				hand.wager +
				Math.floor((hand.wager * BLACKJACK_PAYOUT_NUMERATOR) / BLACKJACK_PAYOUT_DENOMINATOR),
		};
	}
	if (dealerBlackjack || playerBust) {
		return { handIndex, result: 'loss', wager: hand.wager, payout: 0 };
	}
	if (dealerBust) {
		return { handIndex, result: 'win', wager: hand.wager, payout: hand.wager * 2 };
	}

	const comparison = compareHands(
		asCasualHand(hand.cards, hand.wager, false),
		asCasualHand(state.dealerHand.cards, 0, true),
	);
	if (comparison > 0) {
		return { handIndex, result: 'win', wager: hand.wager, payout: hand.wager * 2 };
	}
	if (comparison < 0) {
		return { handIndex, result: 'loss', wager: hand.wager, payout: 0 };
	}
	return { handIndex, result: 'push', wager: hand.wager, payout: hand.wager };
}

function settleRound(state: MutableState): BlackjackRoundOutcome {
	const hands = state.playerHands.map((hand, handIndex) => settleHand(state, hand, handIndex));
	const payout = hands.reduce((total, hand) => total + hand.payout, 0);
	const gameNetDelta = payout - state.committedWager;
	return {
		result: gameNetDelta > 0 ? 'win' : gameNetDelta < 0 ? 'loss' : 'push',
		hands,
		committedWager: state.committedWager,
		payout,
		gameNetDelta,
	};
}

function rejectAction(action: BlackjackAction): never {
	throw new BlackjackRunError('INVALID_ACTION', {
		message: `Action is not legal in the current Blackjack state: ${action}`,
	});
}

/** Replays one deterministic Blackjack round against a fixed 52-card deck. */
export function replayBlackjackRoundWithDeck(
	initialWager: number,
	deck: readonly Card[],
	actions: readonly BlackjackAction[],
): BlackjackRoundReplay {
	const state = createMutableInitialState(initialWager, deck);

	for (const action of actions) {
		const legalActions = getLegalActions(state);
		if (!legalActions.some(({ action: legal }) => legal === action)) {
			rejectAction(action);
		}
		applyAction(state, deck, action);
	}

	return {
		state: snapshotState(state),
		nextSequence: actions.length,
		legalActions: getLegalActions(state),
		outcome: state.phase === 'complete' ? settleRound(state) : null,
	};
}

/** Replays one deterministic Blackjack round from a 32-byte seed. */
export function replayBlackjackRound(input: {
	seed: Uint8Array;
	initialWager: number;
	actions: readonly BlackjackAction[];
}): BlackjackRoundReplay {
	return replayBlackjackRoundWithDeck(input.initialWager, shuffleDeck(input.seed), input.actions);
}

/** Projects a replay for the browser: hides the hole card and filters unfunded actions. */
export function projectBlackjackRoundReplay(
	replay: BlackjackRoundReplay,
	availableBalance: number,
	forceTerminal = false,
): BlackjackPublicRoundState {
	const isTerminal = forceTerminal || replay.state.phase === 'complete';
	const safeAvailableBalance =
		Number.isSafeInteger(availableBalance) && availableBalance >= 0 ? availableBalance : 0;
	const dealerCards = isTerminal
		? replay.state.dealerHand.cards
		: replay.state.dealerHand.cards.slice(0, 1);
	const visibleDealerCards = dealerCards.map((card) => ({ ...card }));
	const availableActions = isTerminal
		? []
		: replay.legalActions
				.filter(
					({ additionalWager }) => additionalWager === 0 || safeAvailableBalance >= additionalWager,
				)
				.map(({ action }) => action);

	return {
		phase: isTerminal ? 'complete' : replay.state.phase,
		playerHands: replay.state.playerHands.map(({ cards, wager }) => {
			const visibleCards = cards.map((card) => ({ ...card }));
			return {
				cards: visibleCards,
				wager,
				value: calculateHandValue(visibleCards),
			};
		}),
		activeHandIndex: replay.state.activeHandIndex,
		dealer: {
			cards: visibleDealerCards,
			value: calculateHandValue(visibleDealerCards),
		},
		committedWager: replay.state.committedWager,
		nextSequence: replay.nextSequence,
		availableActions,
		outcome: replay.outcome,
	};
}
