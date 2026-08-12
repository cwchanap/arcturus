import { describe, expect, test } from 'bun:test';
import { makeMockD1 } from './mock-d1';
import {
	applyMissionProgress,
	buildProgressUpsertSQL,
	computeIncrement,
	clampProgress,
	parseMetadata,
	prepareMissionProgressStatements,
} from './progress';
import type { MissionDefinition, MissionGameEvent } from './types';
import type { WalletSettlementGate } from '../wallet/types';

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

describe('receipt-gated mission progress', () => {
	function gatedEvent() {
		return {
			gameType: 'blackjack',
			outcome: 'win' as const,
			handCount: 1,
			winsIncrement: 1,
			lossesIncrement: 0,
			delta: 100,
		};
	}

	async function runGatedScenario(
		gate: WalletSettlementGate,
		receiptExists: boolean,
	): Promise<{
		matchingWrites: number;
		effectiveWrites: number;
		statements: Array<{ sql: string; args: unknown[] }>;
	}> {
		const mock = makeMockD1();
		mock.onAll('SELECT originalMissionDefId', () => ({ results: [] }));
		mock.onAll('SELECT missionDefId', () => ({ results: [] }));
		mock.onRun('INSERT INTO mission_progress', (args) => ({
			meta: { changes: receiptExists && args.length > 7 ? 1 : 0 },
		}));
		mock.onRun('INSERT OR IGNORE INTO mission_game_tried', () => ({ meta: { changes: 0 } }));
		const statements = await prepareMissionProgressStatements(
			mock.binding,
			[{ userId: 'gate-user', event: gatedEvent() }],
			new Map([['gate-user', gate]]),
		);
		const batchResults = (await mock.binding.batch(statements)) as Array<{
			meta?: { changes?: number };
		}>;
		// Count INSERT statements that were issued, independently of whether the
		// gate permitted them to write. This makes both the gated (no-op) and
		// ungated (effective) cases observable.
		const insertIndices = statements
			.map((stmt, index) => ({ sql: (stmt as unknown as { sql?: string }).sql ?? '', index }))
			.filter(({ sql }) => sql.startsWith('INSERT INTO mission_progress'));
		const matchingWrites = insertIndices.length;
		const effectiveWrites = insertIndices.filter(
			({ index }) => batchResults[index]?.meta?.changes && batchResults[index].meta!.changes! > 0,
		).length;
		return { matchingWrites, effectiveWrites, statements: mock.calls };
	}

	test('updates missions when a matching wallet receipt exists', async () => {
		const result = await runGatedScenario(
			{ settlementId: 'settlement-match', attemptId: 'attempt-match' },
			true,
		);
		expect(result.matchingWrites).toBeGreaterThan(0);
		expect(result.effectiveWrites).toBe(result.matchingWrites);
		expect(result.statements.some((call) => call.sql.includes('FROM wallet_settlement'))).toBe(
			true,
		);
	});

	test('does not update missions when a wallet receipt is missing', async () => {
		const result = await runGatedScenario(
			{ settlementId: 'settlement-missing', attemptId: 'attempt-missing' },
			false,
		);
		// INSERTs are still issued (gated by WHERE EXISTS), but none take effect.
		expect(result.matchingWrites).toBeGreaterThan(0);
		expect(result.effectiveWrites).toBe(0);
	});

	test('keeps ungated mission progress behavior unchanged', async () => {
		const mock = makeMockD1();
		mock.onAll('SELECT originalMissionDefId', () => ({ results: [] }));
		mock.onAll('SELECT missionDefId', () => ({ results: [] }));
		mock.onRun('INSERT INTO mission_progress', () => ({ meta: { changes: 1 } }));
		await applyMissionProgress(mock.binding, 'gate-ungated', gatedEvent());
		expect(mock.calls.some((call) => call.sql.startsWith('INSERT INTO mission_progress'))).toBe(
			true,
		);
	});

	test('uses fixed receipt SQL instead of accepting table names', () => {
		const fakeD1 = {
			prepare(sql: string) {
				return {
					bind: (...args: unknown[]) => ({ sql, args }),
				};
			},
		};
		const statement = buildProgressUpsertSQL(
			fakeD1 as never,
			'user-id',
			{
				id: 'mission',
				title: 'mission',
				description: '',
				period: 'daily',
				metric: { kind: 'handsPlayed' },
				target: 5,
				rewardChips: 0,
				icon: 'star',
			},
			'daily',
			1,
			null,
			1,
			{ settlementId: 's', attemptId: 'a' },
		);
		expect(statement.sql).toContain('FROM wallet_settlement');
		expect(statement.sql).not.toContain('FROM ?');
		expect(statement.args).toEqual(['user-id', 'mission', 'daily', 1, null, 'user-id', 's', 'a']);
	});
});
