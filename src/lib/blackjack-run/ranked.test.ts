import { describe, expect, test } from 'bun:test';
import { replayBlackjackRoundWithDeck, type BlackjackRoundOutcome } from './engine';
import {
	additionalWagerFor,
	buildExpiryOutcome,
	buildRankedSettlementCommand,
	MAXIMUM_WAGER,
	MINIMUM_WAGER,
	RANKED_RUN_TTL_SECONDS,
} from './ranked';
import { splitCapableDeck } from './deck-helpers';

describe('ranked wager bounds', () => {
	test('pins the 10–1000 wager range', () => {
		expect(MINIMUM_WAGER).toBe(10);
		expect(MAXIMUM_WAGER).toBe(1000);
	});

	test('rejects a wager below the minimum', () => {
		expect(() => replayBlackjackRoundWithDeck(9, splitCapableDeck(), [])).toThrow(RangeError);
	});

	test('rejects a wager above the maximum', () => {
		expect(() => replayBlackjackRoundWithDeck(1001, splitCapableDeck(), [])).toThrow(RangeError);
	});
});

describe('ranked run TTL', () => {
	test('pins the 15-minute TTL', () => {
		expect(RANKED_RUN_TTL_SECONDS).toBe(15 * 60);
		expect(RANKED_RUN_TTL_SECONDS).toBe(900);
	});
});

describe('additionalWagerFor', () => {
	test.each([
		['double-down', 10, 10],
		['split', 25, 25],
		['hit', 10, 0],
		['stand', 10, 0],
	] as const)('maps %s at wager %i to %i', (action, wager, expected) => {
		expect(additionalWagerFor(action, wager)).toBe(expected);
	});

	test('agrees with the engine legal-action additional wagers', () => {
		const replay = replayBlackjackRoundWithDeck(100, splitCapableDeck(), []);
		for (const entry of replay.legalActions) {
			expect(additionalWagerFor(entry.action, 100)).toBe(entry.additionalWager);
		}
	});
});

describe('buildExpiryOutcome', () => {
	test('expires a single committed hand as a full loss', () => {
		const replay = replayBlackjackRoundWithDeck(100, splitCapableDeck(), ['stand']);

		const outcome = buildExpiryOutcome(replay.state);

		expect(outcome).toEqual({
			result: 'loss',
			hands: [{ handIndex: 0, result: 'loss', wager: 100, payout: 0 }],
			committedWager: 100,
			payout: 0,
			gameNetDelta: -100,
		});
	});

	test('expires every committed split hand as a loss', () => {
		const replay = replayBlackjackRoundWithDeck(100, splitCapableDeck(), ['split']);

		const outcome = buildExpiryOutcome(replay.state);

		expect(outcome).toEqual({
			result: 'loss',
			hands: [
				{ handIndex: 0, result: 'loss', wager: 100, payout: 0 },
				{ handIndex: 1, result: 'loss', wager: 100, payout: 0 },
			],
			committedWager: 200,
			payout: 0,
			gameNetDelta: -200,
		});
	});
});

describe('buildRankedSettlementCommand', () => {
	const winOutcome: BlackjackRoundOutcome = {
		result: 'win',
		hands: [{ handIndex: 0, result: 'win', wager: 100, payout: 200 }],
		committedWager: 100,
		payout: 200,
		gameNetDelta: 100,
	};

	const lossOutcome: BlackjackRoundOutcome = {
		result: 'loss',
		hands: [{ handIndex: 0, result: 'loss', wager: 100, payout: 0 }],
		committedWager: 100,
		payout: 0,
		gameNetDelta: -100,
	};

	const pushOutcome: BlackjackRoundOutcome = {
		result: 'push',
		hands: [{ handIndex: 0, result: 'push', wager: 100, payout: 100 }],
		committedWager: 100,
		payout: 100,
		gameNetDelta: 0,
	};

	test('uses the stable blackjack-run-<runId> settlement id', () => {
		const command = buildRankedSettlementCommand('abcdefghijklmnopqrstuv', winOutcome);
		expect(command.settlementId).toBe('blackjack-run-abcdefghijklmnopqrstuv');
		expect(command.game).toBe('blackjack');
	});

	test('credits delta equal to the gross payout', () => {
		expect(buildRankedSettlementCommand('run', winOutcome).delta).toBe(200);
		expect(buildRankedSettlementCommand('run', lossOutcome).delta).toBe(0);
		expect(buildRankedSettlementCommand('run', pushOutcome).delta).toBe(100);
	});

	test('records stats.netProfit equal to the true game net delta', () => {
		expect(buildRankedSettlementCommand('run', winOutcome).stats.netProfit).toBe(100);
		expect(buildRankedSettlementCommand('run', lossOutcome).stats.netProfit).toBe(-100);
		expect(buildRankedSettlementCommand('run', pushOutcome).stats.netProfit).toBe(0);
	});

	test.each([
		['win', winOutcome, { wins: 1, losses: 0 }],
		['loss', lossOutcome, { wins: 0, losses: 1 }],
		['push', pushOutcome, { wins: 0, losses: 0 }],
	] as const)('classifies a %s result in stats', (_name, outcome, { wins, losses }) => {
		const command = buildRankedSettlementCommand('run', outcome);
		expect(command.stats).toMatchObject({
			rounds: 1,
			wins,
			losses,
			biggestWin: Math.max(0, outcome.gameNetDelta),
			netProfit: outcome.gameNetDelta,
		});
	});

	test('is stable across repeated calls', () => {
		const first = buildRankedSettlementCommand('abcdefghijklmnopqrstuv', winOutcome);
		const second = buildRankedSettlementCommand('abcdefghijklmnopqrstuv', winOutcome);
		expect(second).toEqual(first);
	});
});
