import { describe, expect, test } from 'bun:test';
import { buildSicBoSettlementCommand } from './client';

describe('buildSicBoSettlementCommand', () => {
	test('builds a win command with full stats', () => {
		expect(buildSicBoSettlementCommand('sic-bo_win', { netDelta: 24 })).toEqual({
			settlementId: 'sic-bo_win',
			game: 'sic-bo',
			delta: 24,
			stats: { rounds: 1, wins: 1, losses: 0, biggestWin: 24 },
		});
	});

	test('builds a loss command', () => {
		expect(buildSicBoSettlementCommand('sic-bo_loss', { netDelta: -5 }).stats).toEqual({
			rounds: 1,
			wins: 0,
			losses: 1,
			biggestWin: 0,
		});
	});

	test('builds a push command', () => {
		expect(buildSicBoSettlementCommand('sic-bo_push', { netDelta: 0 }).stats).toEqual({
			rounds: 1,
			wins: 0,
			losses: 0,
			biggestWin: 0,
		});
	});
});
