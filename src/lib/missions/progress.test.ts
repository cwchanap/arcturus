import { describe, expect, test } from 'bun:test';
import { computeIncrement, clampProgress, parseMetadata } from './progress';
import type { MissionDefinition, MissionGameEvent } from './types';

function makeDef(id: string, metric: MissionDefinition['metric'], target = 5): MissionDefinition {
	return {
		id,
		title: id,
		description: '',
		period: 'daily',
		metric,
		target,
		rewardChips: 500,
		icon: 'star',
	};
}

const baseEvent: MissionGameEvent = {
	gameType: 'blackjack',
	outcome: 'win',
	handCount: 1,
	winsIncrement: 1,
	lossesIncrement: 0,
	delta: 100,
};

describe('computeIncrement', () => {
	test('handsPlayed matches gameType', () => {
		const def = makeDef('d1', { kind: 'handsPlayed', gameType: 'blackjack' });
		expect(computeIncrement(def, baseEvent, null)).toEqual({ amount: 1 });
	});

	test('handsPlayed does not match different gameType', () => {
		const def = makeDef('d1', { kind: 'handsPlayed', gameType: 'craps' });
		expect(computeIncrement(def, baseEvent, null)).toEqual({ amount: 0 });
	});

	test('handsPlayed with no gameType matches any game', () => {
		const def = makeDef('d1', { kind: 'handsPlayed' });
		expect(computeIncrement(def, baseEvent, null)).toEqual({ amount: 1 });
	});

	test('handsPlayed with handCount > 1', () => {
		const def = makeDef('d1', { kind: 'handsPlayed', gameType: 'blackjack' });
		expect(computeIncrement(def, { ...baseEvent, handCount: 3 }, null)).toEqual({ amount: 3 });
	});

	test('roundsWon uses winsIncrement', () => {
		const def = makeDef('d1', { kind: 'roundsWon' });
		expect(computeIncrement(def, { ...baseEvent, winsIncrement: 2 }, null)).toEqual({
			amount: 2,
		});
	});

	test('roundsWon falls back to outcome=win → 1', () => {
		const def = makeDef('d1', { kind: 'roundsWon' });
		const event: MissionGameEvent = {
			gameType: 'poker',
			outcome: 'win',
			handCount: 1,
			winsIncrement: 0,
			lossesIncrement: 0,
			delta: 100,
		};
		expect(computeIncrement(def, event, null)).toEqual({ amount: 1 });
	});

	test('roundsWon with outcome=loss → 0', () => {
		const def = makeDef('d1', { kind: 'roundsWon' });
		expect(
			computeIncrement(def, { ...baseEvent, outcome: 'loss', winsIncrement: 0 }, null),
		).toEqual({ amount: 0 });
	});

	test('spinsCompleted matches slots only', () => {
		const def = makeDef('d1', { kind: 'spinsCompleted' });
		expect(computeIncrement(def, { ...baseEvent, gameType: 'slots' }, null)).toEqual({ amount: 1 });
		expect(computeIncrement(def, { ...baseEvent, gameType: 'blackjack' }, null)).toEqual({
			amount: 0,
		});
	});

	test('netChipsEarned dropped for MVP — no test needed', () => {
		// netChipsEarned was removed from MissionMetric. No mission uses it.
	});

	test('gamesTried adds new gameType', () => {
		const def = makeDef('d1', { kind: 'gamesTried' });
		expect(computeIncrement(def, baseEvent, null)).toEqual({
			amount: 1,
			metadata: ['blackjack'],
		});
	});

	test('gamesTried does not add duplicate gameType', () => {
		const def = makeDef('d1', { kind: 'gamesTried' });
		const existing = { progress: 1, metadataJson: '["blackjack"]' };
		expect(computeIncrement(def, baseEvent, existing)).toEqual({ amount: 0 });
	});

	test('gamesTried adds to existing metadata', () => {
		const def = makeDef('d1', { kind: 'gamesTried' });
		const existing = { progress: 1, metadataJson: '["blackjack"]' };
		const crapsEvent = { ...baseEvent, gameType: 'craps' };
		expect(computeIncrement(def, crapsEvent, existing)).toEqual({
			amount: 1,
			metadata: ['blackjack', 'craps'],
		});
	});
});

describe('clampProgress', () => {
	test('clamps at target', () => {
		expect(clampProgress(7, 5)).toBe(5);
		expect(clampProgress(5, 5)).toBe(5);
		expect(clampProgress(3, 5)).toBe(3);
	});

	test('floors at 0', () => {
		expect(clampProgress(-1, 5)).toBe(0);
		expect(clampProgress(0, 5)).toBe(0);
	});
});

describe('parseMetadata', () => {
	test('returns [] for null/undefined/empty', () => {
		expect(parseMetadata(null)).toEqual([]);
		expect(parseMetadata(undefined)).toEqual([]);
		expect(parseMetadata('')).toEqual([]);
	});

	test('parses a string array', () => {
		expect(parseMetadata('["blackjack","craps"]')).toEqual(['blackjack', 'craps']);
	});

	test('returns [] for non-array JSON', () => {
		expect(parseMetadata('{"foo":"bar"}')).toEqual([]);
		expect(parseMetadata('"single-string"')).toEqual([]);
		expect(parseMetadata('42')).toEqual([]);
	});

	test('returns [] for invalid JSON (defensive catch)', () => {
		expect(parseMetadata('not-json')).toEqual([]);
		expect(parseMetadata('["unterminated')).toEqual([]);
	});

	test('filters out non-string entries from a mixed array', () => {
		expect(parseMetadata('["blackjack", 42, null, true, "craps"]')).toEqual(['blackjack', 'craps']);
	});
});
