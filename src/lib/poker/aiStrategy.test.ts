import { describe, expect, test } from 'bun:test';
import type { Card, GameContext, Player } from './types';
import { makeAIDecision, createAIConfig } from './aiStrategy';

// Helper to create a card
function card(value: string, suit: Card['suit'], rank: number): Card {
	return { value, suit, rank };
}

// Helper to create a player
function player(
	id: number,
	chips: number,
	currentBet: number,
	hand: Card[] = [],
	isDealer: boolean = false,
): Player {
	return {
		id,
		name: `Player ${id}`,
		chips,
		hand,
		currentBet,
		totalBet: currentBet,
		folded: false,
		isAllIn: false,
		isDealer,
		isAI: true,
		hasActed: false,
	};
}

describe('createAIConfig()', () => {
	test('creates tight-aggressive config with high aggression, low bluff', () => {
		const config = createAIConfig('tight-aggressive');
		expect(config.personality).toBe('tight-aggressive');
		expect(config.aggressionLevel).toBe(0.75);
		expect(config.bluffFrequency).toBe(0.15);
	});

	test('creates tight-passive config with low aggression and bluff', () => {
		const config = createAIConfig('tight-passive');
		expect(config.personality).toBe('tight-passive');
		expect(config.aggressionLevel).toBe(0.25);
		expect(config.bluffFrequency).toBe(0.05);
	});

	test('creates loose-aggressive config with high aggression and bluff', () => {
		const config = createAIConfig('loose-aggressive');
		expect(config.personality).toBe('loose-aggressive');
		expect(config.aggressionLevel).toBe(0.85);
		expect(config.bluffFrequency).toBe(0.25);
	});

	test('creates loose-passive config with moderate aggression, low bluff', () => {
		const config = createAIConfig('loose-passive');
		expect(config.personality).toBe('loose-passive');
		expect(config.aggressionLevel).toBe(0.35);
		expect(config.bluffFrequency).toBe(0.1);
	});
});

describe('makeAIDecision() - preflop scenarios', () => {
	test('raises with premium pocket pair (AA) as tight-aggressive', () => {
		const config = createAIConfig('tight-aggressive');
		const aiPlayer = player(1, 500, 0, [card('A', 'hearts', 14), card('A', 'spades', 14)]);
		const context: GameContext = {
			player: aiPlayer,
			players: [aiPlayer, player(2, 500, 10), player(3, 500, 5)],
			communityCards: [],
			pot: 15,
			minimumBet: 10,
			phase: 'preflop',
			bettingRound: 'preflop',
			position: 'late',
		};

		const decision = makeAIDecision(context, config);
		expect(decision.action).toBe('raise');
		expect(decision.amount).toBeGreaterThan(10);
	});

	test('folds with weak hand (7-2 offsuit) as tight-aggressive when facing bet', () => {
		const config = createAIConfig('tight-aggressive');
		const aiPlayer = player(1, 500, 0, [card('7', 'hearts', 7), card('2', 'clubs', 2)]);
		const context: GameContext = {
			player: aiPlayer,
			players: [aiPlayer, player(2, 500, 50), player(3, 500, 0)],
			communityCards: [],
			pot: 50,
			minimumBet: 10,
			phase: 'preflop',
			bettingRound: 'preflop',
			position: 'early',
		};

		const decision = makeAIDecision(context, config);
		expect(decision.action).toBe('fold');
	});

	test('calls or checks with medium strength hand (pocket 8s) when no bet', () => {
		const config = createAIConfig('tight-aggressive');
		const aiPlayer = player(1, 500, 0, [card('8', 'hearts', 8), card('8', 'diamonds', 8)]);
		const context: GameContext = {
			player: aiPlayer,
			players: [aiPlayer, player(2, 500, 0), player(3, 500, 0)],
			communityCards: [],
			pot: 15,
			minimumBet: 10,
			phase: 'preflop',
			bettingRound: 'preflop',
			position: 'middle',
		};

		const decision = makeAIDecision(context, config);
		expect(['check', 'raise']).toContain(decision.action);
	});

	test('loose-aggressive plays more hands than tight-aggressive', () => {
		const looseConfig = createAIConfig('loose-aggressive');
		const tightConfig = createAIConfig('tight-aggressive');

		// Marginal hand: J-9 suited
		const aiPlayer = player(1, 500, 0, [card('J', 'hearts', 11), card('9', 'hearts', 9)]);
		const context: GameContext = {
			player: aiPlayer,
			players: [aiPlayer, player(2, 500, 20), player(3, 500, 0)],
			communityCards: [],
			pot: 20,
			minimumBet: 10,
			phase: 'preflop',
			bettingRound: 'preflop',
			position: 'late',
		};

		// Run multiple times to account for randomization
		let looseFolds = 0;
		let tightFolds = 0;
		const iterations = 20;

		for (let i = 0; i < iterations; i++) {
			const looseDecision = makeAIDecision(context, looseConfig);
			const tightDecision = makeAIDecision(context, tightConfig);

			if (looseDecision.action === 'fold') looseFolds++;
			if (tightDecision.action === 'fold') tightFolds++;
		}

		// Tight-aggressive should fold more often with marginal hands
		expect(tightFolds).toBeGreaterThan(looseFolds);
	});
});

describe('makeAIDecision() - postflop scenarios', () => {
	test('bets strong made hand (trips) aggressively', () => {
		const config = createAIConfig('tight-aggressive');
		const aiPlayer = player(1, 500, 0, [card('K', 'hearts', 13), card('K', 'diamonds', 13)]);
		const context: GameContext = {
			player: aiPlayer,
			players: [aiPlayer, player(2, 500, 0), player(3, 500, 0)],
			communityCards: [card('K', 'spades', 13), card('7', 'clubs', 7), card('3', 'hearts', 3)],
			pot: 60,
			minimumBet: 10,
			phase: 'flop',
			bettingRound: 'flop',
			position: 'middle',
		};

		const decision = makeAIDecision(context, config);
		expect(decision.action).toBe('raise');
		expect(decision.amount).toBeGreaterThan(0);
	});

	test('folds weak hand when facing significant bet', () => {
		const config = createAIConfig('tight-aggressive');
		const aiPlayer = player(1, 500, 0, [card('9', 'hearts', 9), card('8', 'clubs', 8)]);
		const context: GameContext = {
			player: aiPlayer,
			players: [aiPlayer, player(2, 500, 100), player(3, 500, 0)],
			communityCards: [card('K', 'spades', 13), card('Q', 'diamonds', 12), card('2', 'hearts', 2)],
			pot: 100,
			minimumBet: 10,
			phase: 'flop',
			bettingRound: 'flop',
			position: 'early',
		};

		const decision = makeAIDecision(context, config);
		expect(decision.action).toBe('fold');
	});

	test('calls with drawing hand and good pot odds', () => {
		const config = createAIConfig('tight-aggressive');
		// Flush draw: 4 hearts on board + hand
		const aiPlayer = player(1, 500, 0, [card('A', 'hearts', 14), card('K', 'hearts', 13)]);
		const context: GameContext = {
			player: aiPlayer,
			players: [aiPlayer, player(2, 500, 20), player(3, 500, 0)],
			communityCards: [card('9', 'hearts', 9), card('5', 'hearts', 5), card('2', 'clubs', 2)],
			pot: 100,
			minimumBet: 10,
			phase: 'flop',
			bettingRound: 'flop',
			position: 'late',
		};

		const decision = makeAIDecision(context, config);
		// With strong draw and good pot odds, should call or raise
		expect(['call', 'raise']).toContain(decision.action);
	});

	test('checks with made flush', () => {
		const config = createAIConfig('tight-aggressive');
		const aiPlayer = player(1, 500, 0, [card('A', 'hearts', 14), card('K', 'hearts', 13)]);
		const context: GameContext = {
			player: aiPlayer,
			players: [aiPlayer, player(2, 500, 0), player(3, 500, 0)],
			communityCards: [card('Q', 'hearts', 12), card('9', 'hearts', 9), card('5', 'hearts', 5)],
			pot: 100,
			minimumBet: 10,
			phase: 'flop',
			bettingRound: 'flop',
			position: 'middle',
		};

		const decision = makeAIDecision(context, config);
		// With nut flush, should raise or check (slow play)
		expect(['check', 'raise']).toContain(decision.action);
	});
});

describe('makeAIDecision() - position influence', () => {
	test('plays tighter in early position', () => {
		const config = createAIConfig('tight-aggressive');
		// Marginal hand: A-T offsuit
		const aiPlayer = player(1, 500, 0, [card('A', 'hearts', 14), card('10', 'clubs', 10)]);

		const earlyContext: GameContext = {
			player: aiPlayer,
			players: [aiPlayer, player(2, 500, 20, [], true), player(3, 500, 0)],
			communityCards: [],
			pot: 20,
			minimumBet: 10,
			phase: 'preflop',
			bettingRound: 'preflop',
			position: 'early',
		};

		const lateContext: GameContext = {
			...earlyContext,
			position: 'late',
			players: [player(2, 500, 20, [], true), player(3, 500, 0), aiPlayer],
		};

		// Run multiple times to account for randomization
		let earlyFolds = 0;
		let lateFolds = 0;
		const iterations = 20;

		for (let i = 0; i < iterations; i++) {
			const earlyDecision = makeAIDecision(earlyContext, config);
			const lateDecision = makeAIDecision(lateContext, config);

			if (earlyDecision.action === 'fold') earlyFolds++;
			if (lateDecision.action === 'fold') lateFolds++;
		}

		// Should be more conservative in early position
		expect(earlyFolds).toBeGreaterThanOrEqual(lateFolds);
	});
});

describe('makeAIDecision() - bet sizing', () => {
	test('aggressive players bet larger amounts', () => {
		const aggressiveConfig = createAIConfig('loose-aggressive');
		const passiveConfig = createAIConfig('tight-passive');

		const aiPlayer = player(1, 500, 0, [card('A', 'hearts', 14), card('A', 'spades', 14)]);
		const context: GameContext = {
			player: aiPlayer,
			players: [aiPlayer, player(2, 500, 0), player(3, 500, 0)],
			communityCards: [],
			pot: 30,
			minimumBet: 10,
			phase: 'preflop',
			bettingRound: 'preflop',
			position: 'late',
		};

		const aggressiveDecision = makeAIDecision(context, aggressiveConfig);
		const passiveDecision = makeAIDecision(context, passiveConfig);

		// Aggressive should raise more often and larger
		if (aggressiveDecision.action === 'raise' && passiveDecision.action === 'raise') {
			expect(aggressiveDecision.amount || 0).toBeGreaterThanOrEqual(passiveDecision.amount || 0);
		}
	});

	test('bet size increases with hand strength', () => {
		const config = createAIConfig('tight-aggressive');

		// Very strong hand
		const strongPlayer = player(1, 500, 0, [card('A', 'hearts', 14), card('A', 'spades', 14)]);
		const strongContext: GameContext = {
			player: strongPlayer,
			players: [strongPlayer, player(2, 500, 0), player(3, 500, 0)],
			communityCards: [],
			pot: 30,
			minimumBet: 10,
			phase: 'preflop',
			bettingRound: 'preflop',
			position: 'late',
		};

		// Moderate hand
		const moderatePlayer = player(1, 500, 0, [card('J', 'hearts', 11), card('10', 'hearts', 10)]);
		const moderateContext: GameContext = {
			player: moderatePlayer,
			players: [moderatePlayer, player(2, 500, 0), player(3, 500, 0)],
			communityCards: [],
			pot: 30,
			minimumBet: 10,
			phase: 'preflop',
			bettingRound: 'preflop',
			position: 'late',
		};

		// Run multiple times and check average bet size
		let strongTotal = 0;
		let moderateTotal = 0;
		let strongRaises = 0;
		let moderateRaises = 0;

		for (let i = 0; i < 10; i++) {
			const strongDecision = makeAIDecision(strongContext, config);
			const moderateDecision = makeAIDecision(moderateContext, config);

			if (strongDecision.action === 'raise' && strongDecision.amount) {
				strongTotal += strongDecision.amount;
				strongRaises++;
			}
			if (moderateDecision.action === 'raise' && moderateDecision.amount) {
				moderateTotal += moderateDecision.amount;
				moderateRaises++;
			}
		}

		// Average bet size should be higher for stronger hands
		if (strongRaises > 0 && moderateRaises > 0) {
			const strongAvg = strongTotal / strongRaises;
			const moderateAvg = moderateTotal / moderateRaises;
			expect(strongAvg).toBeGreaterThanOrEqual(moderateAvg);
		}
	});

	test('raise amount is capped by pot size', () => {
		const config = createAIConfig('loose-aggressive');
		const aiPlayer = player(1, 1000, 0, [card('A', 'hearts', 14), card('A', 'spades', 14)]);
		const context: GameContext = {
			player: aiPlayer,
			players: [aiPlayer, player(2, 500, 0), player(3, 500, 0)],
			communityCards: [],
			pot: 50, // Small pot
			minimumBet: 10,
			phase: 'preflop',
			bettingRound: 'preflop',
			position: 'late',
		};

		const decision = makeAIDecision(context, config);

		if (decision.action === 'raise') {
			// Should not bet more than 75% of pot (per implementation)
			expect(decision.amount || 0).toBeLessThanOrEqual(Math.floor(context.pot * 0.75));
		}
	});
});

describe('makeAIDecision() - pot odds calculation', () => {
	test('calls with good pot odds even with moderate hand', () => {
		const config = createAIConfig('tight-aggressive');
		// Moderate hand - pair of 9s
		const aiPlayer = player(1, 500, 0, [card('9', 'hearts', 9), card('9', 'clubs', 9)]);
		const context: GameContext = {
			player: aiPlayer,
			players: [aiPlayer, player(2, 500, 10), player(3, 500, 0)],
			communityCards: [card('K', 'spades', 13), card('J', 'diamonds', 11), card('7', 'clubs', 7)],
			pot: 200, // Large pot
			minimumBet: 10,
			phase: 'flop',
			bettingRound: 'flop',
			position: 'late',
		};

		const decision = makeAIDecision(context, config);
		// With excellent pot odds (10 to win 210), should call or raise
		expect(['call', 'raise']).toContain(decision.action);
	});

	test('folds with poor pot odds and weak hand', () => {
		const config = createAIConfig('tight-aggressive');
		const aiPlayer = player(1, 500, 0, [card('7', 'hearts', 7), card('6', 'clubs', 6)]);
		const context: GameContext = {
			player: aiPlayer,
			players: [aiPlayer, player(2, 500, 150), player(3, 500, 0)],
			communityCards: [card('K', 'spades', 13), card('Q', 'diamonds', 12), card('A', 'clubs', 14)],
			pot: 150, // Small pot relative to bet
			minimumBet: 10,
			phase: 'flop',
			bettingRound: 'flop',
			position: 'early',
		};

		const decision = makeAIDecision(context, config);
		expect(decision.action).toBe('fold');
	});
});

describe('makeAIDecision() - decision consistency', () => {
	test('always includes confidence score', () => {
		const config = createAIConfig('tight-aggressive');
		const aiPlayer = player(1, 500, 0, [card('K', 'hearts', 13), card('Q', 'hearts', 12)]);
		const context: GameContext = {
			player: aiPlayer,
			players: [aiPlayer, player(2, 500, 20), player(3, 500, 0)],
			communityCards: [],
			pot: 20,
			minimumBet: 10,
			phase: 'preflop',
			bettingRound: 'preflop',
			position: 'middle',
		};

		const decision = makeAIDecision(context, config);
		expect(decision.confidence).toBeDefined();
		expect(decision.confidence).toBeGreaterThanOrEqual(0);
		expect(decision.confidence).toBeLessThanOrEqual(1);
	});

	test('always includes reasoning', () => {
		const config = createAIConfig('tight-aggressive');
		const aiPlayer = player(1, 500, 0, [card('K', 'hearts', 13), card('Q', 'hearts', 12)]);
		const context: GameContext = {
			player: aiPlayer,
			players: [aiPlayer, player(2, 500, 20), player(3, 500, 0)],
			communityCards: [],
			pot: 20,
			minimumBet: 10,
			phase: 'preflop',
			bettingRound: 'preflop',
			position: 'middle',
		};

		const decision = makeAIDecision(context, config);
		expect(decision.reasoning).toBeDefined();
		expect(typeof decision.reasoning).toBe('string');
		expect(decision.reasoning!.length).toBeGreaterThan(0);
	});

	test('raise action always includes amount', () => {
		const config = createAIConfig('tight-aggressive');
		const aiPlayer = player(1, 500, 0, [card('A', 'hearts', 14), card('A', 'spades', 14)]);
		const context: GameContext = {
			player: aiPlayer,
			players: [aiPlayer, player(2, 500, 0), player(3, 500, 0)],
			communityCards: [],
			pot: 30,
			minimumBet: 10,
			phase: 'preflop',
			bettingRound: 'preflop',
			position: 'late',
		};

		const decision = makeAIDecision(context, config);
		if (decision.action === 'raise') {
			expect(decision.amount).toBeDefined();
			expect(decision.amount).toBeGreaterThan(0);
		}
	});
});
