import { shouldDealerHit } from '../../blackjack/dealerStrategy';
import {
	canDoubleDown,
	canSplit,
	compareHands,
	isBlackjack,
	isBust,
} from '../../blackjack/handEvaluator';
import type { Card, Hand } from '../../blackjack/types';
import {
	RankedServiceError,
	type RankedBlackjackAction,
	type RankedBlackjackActionLogEntryV1,
} from '../protocol';
import type {
	RankedBlackjackConfigV1,
	RankedBlackjackHandOutcomeV1,
	RankedBlackjackHandV1,
	RankedBlackjackLegalActionV1,
	RankedBlackjackOutcomeV1,
	RankedBlackjackReplay,
	RankedBlackjackStateV1,
} from './types';

interface MutableRankedBlackjackHand {
	cards: Card[];
	wager: number;
}

interface MutableRankedBlackjackState {
	phase: 'player-turn' | 'complete';
	playerHands: MutableRankedBlackjackHand[];
	activeHandIndex: number;
	dealerHand: { cards: Card[] };
	deckCursor: number;
	committedWager: number;
}

const EXPECTED_CONFIG = {
	gameType: 'blackjack',
	rulesetVersion: 'blackjack-ranked-v1',
	deckCount: 1,
	minimumWager: 10,
	maximumWager: 1000,
	maximumHands: 4,
	dealerHitsSoft17: false,
	blackjackProfitNumerator: 3,
	blackjackProfitDenominator: 2,
	normalWinProfitNumerator: 1,
	normalWinProfitDenominator: 1,
} as const;

function assertConfig(config: RankedBlackjackConfigV1): void {
	for (const [key, value] of Object.entries(EXPECTED_CONFIG)) {
		if (config[key as keyof typeof EXPECTED_CONFIG] !== value) {
			throw new TypeError(`Unsupported blackjack-ranked-v1 configuration field: ${key}`);
		}
	}
	if (
		!Number.isSafeInteger(config.initialWager) ||
		config.initialWager < config.minimumWager ||
		config.initialWager > config.maximumWager
	) {
		throw new RangeError('Initial wager is outside blackjack-ranked-v1 limits');
	}
}

function assertDeck(deck: readonly Card[]): void {
	if (deck.length !== 52) {
		throw new RangeError('blackjack-ranked-v1 requires exactly 52 cards');
	}
	const identities = new Set(deck.map(({ rank, suit }) => `${rank}:${suit}`));
	if (identities.size !== deck.length) {
		throw new TypeError('blackjack-ranked-v1 requires 52 unique cards');
	}
}

function asCasualHand(cards: readonly Card[], wager: number, isDealer: boolean): Hand {
	return {
		cards: [...cards],
		bet: wager,
		isDealer,
	};
}

function isBlackjackHand(hand: MutableRankedBlackjackHand): boolean {
	return isBlackjack(asCasualHand(hand.cards, hand.wager, false));
}

function isBustHand(hand: MutableRankedBlackjackHand): boolean {
	return isBust(asCasualHand(hand.cards, hand.wager, false));
}

function isDealerBlackjack(state: MutableRankedBlackjackState): boolean {
	return isBlackjack(asCasualHand(state.dealerHand.cards, 0, true));
}

function isDealerBust(state: MutableRankedBlackjackState): boolean {
	return isBust(asCasualHand(state.dealerHand.cards, 0, true));
}

function dealCard(state: MutableRankedBlackjackState, deck: readonly Card[]): Card {
	const card = deck[deck.length - 1 - state.deckCursor];
	if (!card) {
		throw new RangeError('Ranked Blackjack deck is exhausted');
	}
	state.deckCursor += 1;
	return { ...card };
}

function createMutableInitialState(
	config: RankedBlackjackConfigV1,
	deck: readonly Card[],
): MutableRankedBlackjackState {
	assertConfig(config);
	assertDeck(deck);

	const state: MutableRankedBlackjackState = {
		phase: 'player-turn',
		playerHands: [{ cards: [], wager: config.initialWager }],
		activeHandIndex: 0,
		dealerHand: { cards: [] },
		deckCursor: 0,
		committedWager: config.initialWager,
	};
	state.playerHands[0].cards.push(dealCard(state, deck), dealCard(state, deck));
	state.dealerHand.cards.push(dealCard(state, deck), dealCard(state, deck));

	if (isBlackjackHand(state.playerHands[0]) || isDealerBlackjack(state)) {
		state.phase = 'complete';
	}
	return state;
}

function snapshotState(state: MutableRankedBlackjackState): RankedBlackjackStateV1 {
	return {
		phase: state.phase,
		playerHands: state.playerHands.map(
			(hand): RankedBlackjackHandV1 => ({
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

export function createInitialBlackjackState(
	config: RankedBlackjackConfigV1,
	deck: readonly Card[],
): RankedBlackjackStateV1 {
	return snapshotState(createMutableInitialState(config, deck));
}

function getLegalActions(state: MutableRankedBlackjackState): RankedBlackjackLegalActionV1[] {
	if (state.phase !== 'player-turn') return [];

	const activeHand = state.playerHands[state.activeHandIndex];
	const casualHand = asCasualHand(activeHand.cards, activeHand.wager, false);
	const actions: RankedBlackjackLegalActionV1[] = [
		{ action: 'hit', additionalWager: 0 },
		{ action: 'stand', additionalWager: 0 },
	];
	if (canDoubleDown(casualHand)) {
		actions.push({ action: 'double-down', additionalWager: activeHand.wager });
	}
	if (state.playerHands.length < EXPECTED_CONFIG.maximumHands && canSplit(casualHand)) {
		actions.push({ action: 'split', additionalWager: activeHand.wager });
	}
	return actions;
}

function finishPlayerTurn(state: MutableRankedBlackjackState, deck: readonly Card[]): void {
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

function completeActiveHand(state: MutableRankedBlackjackState, deck: readonly Card[]): void {
	if (state.activeHandIndex < state.playerHands.length - 1) {
		state.activeHandIndex += 1;
		return;
	}
	finishPlayerTurn(state, deck);
}

function applyAction(
	state: MutableRankedBlackjackState,
	deck: readonly Card[],
	action: RankedBlackjackAction,
): void {
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
			const newHand: MutableRankedBlackjackHand = {
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
	state: MutableRankedBlackjackState,
	hand: MutableRankedBlackjackHand,
	handIndex: number,
): RankedBlackjackHandOutcomeV1 {
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
			payout: hand.wager + Math.floor((hand.wager * 3) / 2),
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

function settleRound(state: MutableRankedBlackjackState): RankedBlackjackOutcomeV1 {
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

function rejectSequence(expectedSequence: number): never {
	throw new RankedServiceError('SEQUENCE_MISMATCH', { expectedSequence });
}

function rejectAction(action: RankedBlackjackAction): never {
	throw new RankedServiceError('INVALID_ACTION', {
		message: `Action is not legal in the current ranked Blackjack state: ${action}`,
	});
}

export function replayRankedBlackjack(
	config: RankedBlackjackConfigV1,
	deck: readonly Card[],
	actions: readonly RankedBlackjackActionLogEntryV1[],
): RankedBlackjackReplay {
	const state = createMutableInitialState(config, deck);
	let nextSequence = 0;

	for (const entry of actions) {
		if (entry.sequence !== nextSequence) rejectSequence(nextSequence);
		const legalActions = getLegalActions(state);
		if (!legalActions.some(({ action }) => action === entry.action)) {
			rejectAction(entry.action);
		}
		applyAction(state, deck, entry.action);
		nextSequence += 1;
	}

	return {
		state: snapshotState(state),
		nextSequence,
		legalActions: getLegalActions(state),
		outcome: state.phase === 'complete' ? settleRound(state) : null,
	};
}
