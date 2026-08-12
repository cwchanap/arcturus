import { describe, expect, test } from 'bun:test';
import { buildBaccaratSettlementCommand } from './settlement';

describe('Baccarat wallet settlement command', () => {
	test('builds a winning round command', () => {
		expect(buildBaccaratSettlementCommand('baccarat-win', 120)).toEqual({
			settlementId: 'baccarat-win',
			game: 'baccarat',
			delta: 120,
			stats: { rounds: 1, wins: 1, losses: 0, biggestWin: 120 },
		});
	});

	test('records a losing round without a biggest win', () => {
		expect(buildBaccaratSettlementCommand('baccarat-loss', -50).stats).toEqual({
			rounds: 1,
			wins: 0,
			losses: 1,
			biggestWin: 0,
		});
	});
});
