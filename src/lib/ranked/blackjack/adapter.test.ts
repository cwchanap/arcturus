import { describe, expect, test } from 'bun:test';
import { encodeBase64Url, hashCanonical } from '../canonical';
import {
	blackjackRankedV1Adapter,
	BLACKJACK_RANKED_V1_CONFIG,
	issueBlackjackConfig,
} from './adapter';

const seedFixture = Uint8Array.from({ length: 32 }, (_, index) => index);

describe('ranked Blackjack v1 configuration', () => {
	test('issues the exact immutable v1 config and hashes the per-session wager', async () => {
		const first = await blackjackRankedV1Adapter.issue({ wager: 100 });
		const second = await blackjackRankedV1Adapter.issue({ wager: 200 });

		expect(BLACKJACK_RANKED_V1_CONFIG).toEqual({
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
		});
		expect(Object.isFrozen(BLACKJACK_RANKED_V1_CONFIG)).toBe(true);
		expect(first.config).toEqual({ ...BLACKJACK_RANKED_V1_CONFIG, initialWager: 100 });
		expect(Object.isFrozen(first.config)).toBe(true);
		expect(first.configJson).toBe(
			'{"blackjackProfitDenominator":2,"blackjackProfitNumerator":3,"dealerHitsSoft17":false,"deckCount":1,"gameType":"blackjack","initialWager":100,"maximumHands":4,"maximumWager":1000,"minimumWager":10,"normalWinProfitDenominator":1,"normalWinProfitNumerator":1,"rulesetVersion":"blackjack-ranked-v1"}',
		);
		expect(first.configHash).toBe(hashCanonical(first.config));
		expect(first.configHash).not.toBe(second.configHash);
		expect(issueBlackjackConfig(200)).toEqual(second.config);
	});
});

describe('ranked Blackjack v1 replay projection', () => {
	test('replays the deterministic deck and hides active seed, generator, deck cursor, and dealer hole card', async () => {
		const replay = await blackjackRankedV1Adapter.replay(
			seedFixture,
			issueBlackjackConfig(100),
			[],
		);
		const publicState = blackjackRankedV1Adapter.project(replay, 0);
		const serialized = JSON.stringify(publicState);

		expect(publicState.phase).toBe('player-turn');
		expect(publicState.playerHands).toEqual([
			{
				cards: [
					{ rank: '9', suit: 'hearts' },
					{ rank: 'A', suit: 'clubs' },
				],
				wager: 100,
				value: { value: 20, isSoft: true, isBust: false },
			},
		]);
		expect(publicState.dealer).toEqual({
			cards: [{ rank: '7', suit: 'hearts' }],
			value: { value: 7, isSoft: false, isBust: false },
		});
		expect(publicState.availableActions).toEqual(['hit', 'stand']);
		expect(Object.keys(publicState).sort()).toEqual([
			'activeHandIndex',
			'availableActions',
			'committedWager',
			'dealer',
			'nextSequence',
			'outcome',
			'phase',
			'playerHands',
		]);
		expect(serialized).not.toContain(encodeBase64Url(seedFixture));
		expect(serialized).not.toContain('deckCursor');
		expect(serialized).not.toContain('generator');
		expect(serialized).not.toContain('J');
	});

	test('reveals the full dealer hand only after a terminal replay', async () => {
		const replay = await blackjackRankedV1Adapter.replay(seedFixture, issueBlackjackConfig(100), [
			{ sequence: 0, action: 'stand' },
		]);
		const publicState = blackjackRankedV1Adapter.project(replay, 0);

		expect(publicState.phase).toBe('complete');
		expect(publicState.dealer.cards).toEqual([
			{ rank: '7', suit: 'hearts' },
			{ rank: 'J', suit: 'clubs' },
		]);
		expect(publicState.outcome).toEqual(blackjackRankedV1Adapter.terminalOutcome(replay));
	});

	test('removes additional-wager actions when the account cannot fund them', async () => {
		const replay = await blackjackRankedV1Adapter.replay(
			Uint8Array.from({ length: 32 }, (_, index) => index + 5),
			issueBlackjackConfig(100),
			[],
		);

		expect(replay.legalActions).toContainEqual({ action: 'double-down', additionalWager: 100 });
		expect(blackjackRankedV1Adapter.project(replay, 99).availableActions).toEqual(['hit', 'stand']);
		expect(blackjackRankedV1Adapter.project(replay, 100).availableActions).toEqual([
			'hit',
			'stand',
			'double-down',
		]);
	});

	test('removes split when the account cannot fund its additional wager', async () => {
		const replay = await blackjackRankedV1Adapter.replay(
			Uint8Array.from({ length: 32 }, (_, index) => index + 30),
			issueBlackjackConfig(100),
			[],
		);

		expect(replay.legalActions).toContainEqual({ action: 'split', additionalWager: 100 });
		expect(blackjackRankedV1Adapter.project(replay, 99).availableActions).toEqual(['hit', 'stand']);
		expect(blackjackRankedV1Adapter.project(replay, 100).availableActions).toEqual([
			'hit',
			'stand',
			'split',
		]);
	});

	test.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 100.5])(
		'does not treat an invalid account balance %p as funding for an additional wager',
		async (accountBalance) => {
			const replay = await blackjackRankedV1Adapter.replay(
				Uint8Array.from({ length: 32 }, (_, index) => index + 5),
				issueBlackjackConfig(100),
				[],
			);

			expect(blackjackRankedV1Adapter.project(replay, accountBalance).availableActions).toEqual([
				'hit',
				'stand',
			]);
		},
	);
});
