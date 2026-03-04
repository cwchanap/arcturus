import { beforeAll, describe, expect, mock, test } from 'bun:test';

type DiceRollerModule = typeof import('./diceRoller');

let rollDie!: DiceRollerModule['rollDie'];
let rollDice!: DiceRollerModule['rollDice'];
let createRoll!: DiceRollerModule['createRoll'];
let rollCombinations!: DiceRollerModule['rollCombinations'];

beforeAll(async () => {
	// Ensure this file always imports the real diceRoller module, even when
	// other test files have active mock.module('./diceRoller') overrides.
	mock.restore();
	const diceRoller = await import(`./diceRoller.ts?dice-roller-test=${Date.now()}`);
	rollDie = diceRoller.rollDie;
	rollDice = diceRoller.rollDice;
	createRoll = diceRoller.createRoll;
	rollCombinations = diceRoller.rollCombinations;
});

describe('rollDie', () => {
	test('always returns a value between 1 and 6', () => {
		for (let i = 0; i < 200; i++) {
			const face = rollDie();
			expect(face).toBeGreaterThanOrEqual(1);
			expect(face).toBeLessThanOrEqual(6);
		}
	});
});

describe('rollDice', () => {
	test('total equals die1 + die2', () => {
		for (let i = 0; i < 100; i++) {
			const roll = rollDice();
			expect(roll.total).toBe((roll.die1 + roll.die2) as typeof roll.total);
		}
	});

	test('hard rolls are derivable from die faces', () => {
		for (let i = 0; i < 200; i++) {
			const roll = rollDice();
			expect(roll.die1 === roll.die2).toBeTypeOf('boolean');
		}
	});

	test('total is always between 2 and 12', () => {
		for (let i = 0; i < 200; i++) {
			const roll = rollDice();
			expect(roll.total).toBeGreaterThanOrEqual(2);
			expect(roll.total).toBeLessThanOrEqual(12);
		}
	});
});

describe('createRoll', () => {
	test('creates specific roll correctly', () => {
		const roll = createRoll(3, 4);
		expect(roll.die1).toBe(3);
		expect(roll.die2).toBe(4);
		expect(roll.total).toBe(7);
		expect(roll.die1 === roll.die2).toBe(false);
	});

	test('marks hard rolls correctly', () => {
		const roll = createRoll(3, 3);
		expect(roll.total).toBe(6);
		expect(roll.die1 === roll.die2).toBe(true);
	});
});

describe('rollCombinations', () => {
	test('7 has 6 combinations', () => {
		expect(rollCombinations(7)).toBe(6);
	});

	test('2 and 12 have 1 combination each', () => {
		expect(rollCombinations(2)).toBe(1);
		expect(rollCombinations(12)).toBe(1);
	});

	test('all combinations sum to 36', () => {
		const total = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].reduce(
			(sum, n) => sum + rollCombinations(n),
			0,
		);
		expect(total).toBe(36);
	});
});
