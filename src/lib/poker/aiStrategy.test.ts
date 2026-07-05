import { describe, expect, test } from 'bun:test';
import type { Card, GameContext, Player } from './types';
import { makeAIDecision, createAIConfig } from './aiStrategy';

// Deterministic linear-congruential PRNG so probabilistic tests are
// reproducible instead of relying on Math.random (which caused flakiness
// with only 10–20 iterations). Mirrors the seeded-random pattern used by
// the difficulty-ladder tests below but produces a varied sequence so
// statistical comparisons (tight vs loose, early vs late) still hold.
function createSeededRandom(seed: number): () => number {
	let state = seed % 0x100000000;
	if (state <= 0) state += 0x100000000;
	return () => {
		state = (state * 1664525 + 1013904223) % 0x100000000;
		return state / 0x100000000;
	};
}

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
		const random = createSeededRandom(42);
		const looseConfig = { ...createAIConfig('loose-aggressive'), random };
		const tightConfig = { ...createAIConfig('tight-aggressive'), random };

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
		const random = createSeededRandom(7);
		const config = { ...createAIConfig('tight-aggressive'), random };
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
		const random = createSeededRandom(99);
		const aggressiveConfig = { ...createAIConfig('loose-aggressive'), random };
		const passiveConfig = { ...createAIConfig('tight-passive'), random };

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
		const random = createSeededRandom(123);
		const config = { ...createAIConfig('tight-aggressive'), random };

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
			// Profile-based sizing is pot-aware and rounds to the table minimum.
			const roundedPotCap =
				Math.ceil((context.pot * 0.8) / context.minimumBet) * context.minimumBet;
			expect(decision.amount || 0).toBeLessThanOrEqual(roundedPotCap);
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

describe('makeAIDecision() - difficulty ladder', () => {
	test('createAIConfig defaults to medium difficulty for compatibility', () => {
		const config = createAIConfig('tight-aggressive');

		expect(config.personality).toBe('tight-aggressive');
		expect(config.difficulty).toBe('medium');
	});

	test('createAIConfig accepts explicit difficulty', () => {
		const config = createAIConfig('loose-passive', 'hard');

		expect(config.personality).toBe('loose-passive');
		expect(config.difficulty).toBe('hard');
	});

	test('hard difficulty continues with a strong draw that easy difficulty folds to pressure', () => {
		const aiPlayer = player(1, 500, 0, [card('A', 'hearts', 14), card('K', 'hearts', 13)]);
		const context: GameContext = {
			player: aiPlayer,
			players: [aiPlayer, player(2, 500, 180), player(3, 500, 0)],
			communityCards: [card('9', 'hearts', 9), card('5', 'hearts', 5), card('2', 'clubs', 2)],
			pot: 220,
			minimumBet: 10,
			phase: 'flop',
			bettingRound: 'flop',
			position: 'late',
		};

		const easyDecision = makeAIDecision(context, {
			...createAIConfig('tight-passive', 'easy'),
			random: () => 0.99,
		});
		const hardDecision = makeAIDecision(context, {
			...createAIConfig('tight-passive', 'hard'),
			random: () => 0.99,
		});

		expect(easyDecision.action).toBe('fold');
		expect(['call', 'raise']).toContain(hardDecision.action);
		expect(hardDecision.reasoning).toContain('hard');
	});

	test('hard aggressive bot can semi-bluff a strong draw when random roll allows it', () => {
		const aiPlayer = player(1, 500, 0, [card('Q', 'spades', 12), card('J', 'spades', 11)]);
		const context: GameContext = {
			player: aiPlayer,
			players: [aiPlayer, player(2, 500, 0), player(3, 500, 0)],
			communityCards: [card('10', 'spades', 10), card('9', 'clubs', 9), card('2', 'spades', 2)],
			pot: 80,
			minimumBet: 10,
			phase: 'flop',
			bettingRound: 'flop',
			position: 'late',
		};

		const decision = makeAIDecision(context, {
			...createAIConfig('loose-aggressive', 'hard'),
			random: () => 0.01,
		});

		expect(decision.action).toBe('raise');
		expect(decision.amount).toBeGreaterThanOrEqual(10);
		expect(decision.reasoning).toContain('semi-bluff');
	});
});

describe('makeAIDecision() - getPosition fallback', () => {
	// These tests omit `position` from the context so the internal getPosition
	// fallback is exercised. The type requires `position`, so we cast to omit it.
	function contextWithoutPosition(
		aiPlayer: Player,
		players: Player[],
		overrides: Partial<GameContext> = {},
	): GameContext {
		return {
			player: aiPlayer,
			players,
			communityCards: [],
			pot: 30,
			minimumBet: 10,
			phase: 'preflop',
			bettingRound: 'preflop',
			...overrides,
		} as GameContext;
	}

	test('returns middle when no dealer is assigned', () => {
		const aiPlayer = player(1, 500, 0, [card('A', 'hearts', 14), card('K', 'spades', 13)]);
		// No player has isDealer=true → dealerIndex === -1 → getPosition returns 'middle'
		const players = [aiPlayer, player(2, 500, 0), player(3, 500, 0)];
		const context = contextWithoutPosition(aiPlayer, players);

		const decision = makeAIDecision(context, {
			...createAIConfig('tight-aggressive'),
			random: () => 0.99,
		});

		// With a strong hand and middle position, the bot should still act;
		// the key assertion is that no error is thrown and a decision is made.
		expect(['check', 'raise']).toContain(decision.action);
	});

	test('3-handed: dealer is late, next seat is early, last seat is middle', () => {
		const dealer = player(1, 500, 0, [card('2', 'hearts', 2), card('7', 'clubs', 7)], true);
		const early = player(2, 500, 0, [card('9', 'hearts', 9), card('4', 'diamonds', 4)]);
		const middle = player(3, 500, 0, [card('A', 'spades', 14), card('K', 'diamonds', 13)]);

		// Dealer (positionFromDealer=0) → late
		const dealerContext = contextWithoutPosition(dealer, [dealer, early, middle]);
		const dealerDecision = makeAIDecision(dealerContext, {
			...createAIConfig('tight-aggressive'),
			random: () => 0.99,
		});
		expect(dealerDecision.reasoning).toContain('texture=');
		expect(['check', 'raise']).toContain(dealerDecision.action);

		// Seat after dealer (positionFromDealer=1) → early
		const earlyContext = contextWithoutPosition(early, [dealer, early, middle]);
		const earlyDecision = makeAIDecision(earlyContext, {
			...createAIConfig('tight-aggressive'),
			random: () => 0.99,
		});
		expect(['check', 'raise', 'fold']).toContain(earlyDecision.action);

		// Last seat (positionFromDealer=2) → middle
		const middleContext = contextWithoutPosition(middle, [dealer, early, middle]);
		const middleDecision = makeAIDecision(middleContext, {
			...createAIConfig('tight-aggressive'),
			random: () => 0.99,
		});
		expect(['check', 'raise']).toContain(middleDecision.action);
	});

	test('4+ handed: maps positionFromDealer 1-2 to early, 3 to middle, 4+ to late', () => {
		// 5-handed table to exercise the early/middle/late branches of the
		// non-3-handed getPosition path.
		const p0 = player(0, 500, 0, [card('2', 'hearts', 2), card('7', 'clubs', 7)], true);
		const p1 = player(1, 500, 0, [card('9', 'hearts', 9), card('4', 'diamonds', 4)]);
		const p2 = player(2, 500, 0, [card('5', 'spades', 5), card('6', 'diamonds', 6)]);
		const p3 = player(3, 500, 0, [card('8', 'clubs', 8), card('3', 'hearts', 3)]);
		const p4 = player(4, 500, 0, [card('A', 'spades', 14), card('K', 'diamonds', 13)]);
		const players = [p0, p1, p2, p3, p4];

		// positionFromDealer=1 → early
		const earlyDecision = makeAIDecision(contextWithoutPosition(p1, players), {
			...createAIConfig('tight-aggressive'),
			random: () => 0.99,
		});
		expect(['check', 'raise', 'fold']).toContain(earlyDecision.action);

		// positionFromDealer=3 → middle
		const middleDecision = makeAIDecision(contextWithoutPosition(p3, players), {
			...createAIConfig('tight-aggressive'),
			random: () => 0.99,
		});
		expect(['check', 'raise', 'fold']).toContain(middleDecision.action);

		// positionFromDealer=4 → late
		const lateDecision = makeAIDecision(contextWithoutPosition(p4, players), {
			...createAIConfig('tight-aggressive'),
			random: () => 0.99,
		});
		expect(['check', 'raise']).toContain(lateDecision.action);
	});
});

describe('makeAIDecision() - short-stack fallthrough', () => {
	test('checks with a value hand when too short to raise the minimum', () => {
		// canCheck (no bet to call) + strong hand (AA → valueMadeHand) but
		// chips < minimumBet so chooseRaiseAmount returns null. The raise
		// branch is entered but falls through to a check instead of forcing
		// an illegal raise.
		const aiPlayer = player(1, 5, 0, [card('A', 'hearts', 14), card('A', 'spades', 14)]);
		const context: GameContext = {
			player: aiPlayer,
			players: [aiPlayer, player(2, 500, 0), player(3, 500, 0)],
			communityCards: [],
			pot: 15,
			minimumBet: 10,
			phase: 'preflop',
			bettingRound: 'preflop',
			position: 'late',
		};

		const decision = makeAIDecision(context, {
			...createAIConfig('tight-aggressive'),
			random: () => 0.99,
		});

		expect(decision.action).toBe('check');
	});

	test('calls with a value hand when facing a bet but too short to raise', () => {
		// Facing a bet (canCheck=false) + strong hand (AA → valueMadeHand) but
		// after calling there is less than the minimum raise left, so
		// chooseRaiseAmount returns null. The raise branch is entered, falls
		// through, and the bot calls instead of raising.
		const aiPlayer = player(1, 15, 0, [card('A', 'hearts', 14), card('A', 'spades', 14)]);
		const context: GameContext = {
			player: aiPlayer,
			players: [aiPlayer, player(2, 500, 10), player(3, 500, 0)],
			communityCards: [],
			pot: 20,
			minimumBet: 10,
			phase: 'preflop',
			bettingRound: 'preflop',
			position: 'late',
		};

		const decision = makeAIDecision(context, {
			...createAIConfig('tight-aggressive'),
			random: () => 0.99,
		});

		// Too short to raise (15 - 10 call = 5 < 10 min raise) → falls through
		// to call. AA is strong enough to continue.
		expect(decision.action).toBe('call');
	});
});
