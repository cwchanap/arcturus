import { describe, expect, test } from 'bun:test';
import type { RoundOutcome } from './types';
import {
	buildBlackjackSettlementCommand,
	canStartBlackjackRound,
	formatBlackjackOutcomeMessage,
	retryBlackjackSettlement,
} from './blackjackClient';
import type { SettlementGate } from '../wallet';

describe('Blackjack wallet settlement client', () => {
	test('builds one wallet command with per-hand stats for a completed round', () => {
		const outcomes: RoundOutcome[] = [
			{ handIndex: 0, result: 'blackjack', payout: 125 },
			{ handIndex: 1, result: 'loss', payout: 0 },
			{ handIndex: 2, result: 'push', payout: 50 },
		];

		const command = buildBlackjackSettlementCommand(outcomes, 75, [
			{ bet: 50 },
			{ bet: 50 },
			{ bet: 50 },
		]);

		expect(command).toEqual({
			settlementId: expect.stringMatching(/^blackjack-/),
			game: 'blackjack',
			delta: 75,
			stats: {
				rounds: 3,
				wins: 1,
				losses: 1,
				biggestWin: 75,
			},
		});
	});

	test('blocks a new authenticated round while the shared gate is blocked', () => {
		let consulted = false;
		const gate = {
			get isBlocked() {
				consulted = true;
				return true;
			},
		} as SettlementGate;

		expect(canStartBlackjackRound({ isGuestMode: false, gate })).toBe(false);
		expect(consulted).toBe(true);
	});

	test('does not block guest rounds on an authenticated settlement gate', () => {
		const gate = { isBlocked: true } as SettlementGate;
		expect(canStartBlackjackRound({ isGuestMode: true, gate })).toBe(true);
	});

	test('delegates Retry to the shared settlement gate', async () => {
		let retryCalls = 0;
		const result = await retryBlackjackSettlement({
			retry: async () => {
				retryCalls += 1;
				return { balance: 1_025, duplicate: false };
			},
		});

		expect(retryCalls).toBe(1);
		expect(result).toEqual({ balance: 1_025, duplicate: false });
	});
});

describe('formatBlackjackOutcomeMessage', () => {
	test('renders single-hand outcomes in English', () => {
		expect(formatBlackjackOutcomeMessage([{ handIndex: 0, result: 'blackjack', payout: 75 }])).toBe(
			'🎉 BLACKJACK! You win!',
		);
		expect(formatBlackjackOutcomeMessage([{ handIndex: 0, result: 'win', payout: 100 }])).toBe(
			'✓ You win!',
		);
		expect(formatBlackjackOutcomeMessage([{ handIndex: 0, result: 'loss', payout: 0 }])).toBe(
			'✗ Dealer wins',
		);
		expect(formatBlackjackOutcomeMessage([{ handIndex: 0, result: 'push', payout: 50 }])).toBe(
			'🤝 Push (Tie)',
		);
	});

	test('renders split hands with an overall summary', () => {
		const outcomes: RoundOutcome[] = [
			{ handIndex: 0, result: 'win', payout: 100 },
			{ handIndex: 1, result: 'loss', payout: 0 },
		];

		expect(formatBlackjackOutcomeMessage(outcomes)).toBe(
			'Hand 1: ✓ Win | Hand 2: ✗ Loss — Overall: Split result',
		);
	});

	test('localizes split summaries per locale', () => {
		const outcomes: RoundOutcome[] = [
			{ handIndex: 0, result: 'win', payout: 100 },
			{ handIndex: 1, result: 'win', payout: 100 },
		];

		expect(formatBlackjackOutcomeMessage(outcomes, 'zh-Hant')).toBe(
			'第 1 手：✓ 贏 | 第 2 手：✓ 贏 — 整體：你贏了！🎉',
		);
		expect(formatBlackjackOutcomeMessage(outcomes, 'ja')).toBe(
			'ハンド 1：✓ 勝ち | ハンド 2：✓ 勝ち — 総合：あなたの勝ち！🎉',
		);
	});
});
