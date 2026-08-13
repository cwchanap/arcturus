import { describe, expect, test } from 'bun:test';
import { buildVideoPokerSettlementCommand } from './client';

describe('video poker wallet command', () => {
	test('maps win, push, and loss to Video Poker round stats', () => {
		expect(buildVideoPokerSettlementCommand('win', { netDelta: 8 })).toEqual({
			settlementId: 'win',
			game: 'video-poker',
			delta: 8,
			stats: { rounds: 1, wins: 1, losses: 0, biggestWin: 8 },
		});
		expect(buildVideoPokerSettlementCommand('push', { netDelta: 0 }).stats).toEqual({
			rounds: 1,
			wins: 0,
			losses: 0,
			biggestWin: 0,
		});
		expect(buildVideoPokerSettlementCommand('loss', { netDelta: -5 }).stats).toEqual({
			rounds: 1,
			wins: 0,
			losses: 1,
			biggestWin: 0,
		});
	});
});
