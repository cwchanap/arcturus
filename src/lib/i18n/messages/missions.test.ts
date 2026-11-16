import { describe, expect, test } from 'bun:test';
import { getMissionDescription, getMissionTitle } from './missions';

describe('missions message catalog', () => {
	test('serves non-English copy for mission titles and descriptions', () => {
		expect(getMissionTitle('zh-Hant', 'daily-win-3')).toBe('三連勝');
		expect(getMissionDescription('ja', 'daily-win-3', 3)).toBe('任意のゲームで 3 ラウンド勝利');
	});

	test('composes game names into mission copy from the canonical catalog', () => {
		expect(getMissionTitle('en', 'daily-blackjack-5')).toBe('Blackjack Streak');
		expect(getMissionTitle('zh-Hant', 'daily-blackjack-5')).toBe('二十一點連勝');
		expect(getMissionTitle('ja', 'daily-baccarat-3')).toBe('バカララウンド');
		expect(getMissionDescription('zh-Hant', 'daily-baccarat-3', 3)).toBe('玩 3 手百家樂');
		expect(getMissionDescription('en', 'daily-craps-3', 3)).toBe('Play 3 Craps rounds');
		expect(getMissionDescription('ja', 'daily-keno-5', 5)).toBe('キノを 5 回プレイ');
	});

	test('poker titles match the binding templates in all four locales', () => {
		expect(getMissionTitle('en', 'daily-poker-10')).toBe("Texas Hold'em Poker Hands");
		expect(getMissionTitle('en', 'daily-poker-wins-3')).toBe("Texas Hold'em Poker Winner");
		expect(getMissionTitle('en', 'daily-poker-big-pot')).toBe('Big Pot');
		expect(getMissionTitle('en', 'weekly-poker-wins-15')).toBe("Texas Hold'em Poker Regular");
		expect(getMissionTitle('zh-Hant', 'daily-poker-10')).toBe('德州撲克手牌');
		expect(getMissionTitle('zh-Hant', 'daily-poker-wins-3')).toBe('德州撲克贏家');
		expect(getMissionTitle('zh-Hant', 'daily-poker-big-pot')).toBe('大底池');
		expect(getMissionTitle('zh-Hant', 'weekly-poker-wins-15')).toBe('德州撲克常客');
		expect(getMissionTitle('zh-Hans', 'daily-poker-10')).toBe('德州扑克手牌');
		expect(getMissionTitle('zh-Hans', 'daily-poker-wins-3')).toBe('德州扑克赢家');
		expect(getMissionTitle('zh-Hans', 'daily-poker-big-pot')).toBe('大底池');
		expect(getMissionTitle('zh-Hans', 'weekly-poker-wins-15')).toBe('德州扑克常客');
		expect(getMissionTitle('ja', 'daily-poker-10')).toBe('テキサスホールデムポーカーハンド');
		expect(getMissionTitle('ja', 'daily-poker-wins-3')).toBe('テキサスホールデムポーカーウィナー');
		expect(getMissionTitle('ja', 'daily-poker-big-pot')).toBe('ビッグポット');
		expect(getMissionTitle('ja', 'weekly-poker-wins-15')).toBe(
			'テキサスホールデムポーカーレギュラー',
		);
	});

	test('poker win counts use hands, not rounds, in all four locales', () => {
		expect(getMissionDescription('en', 'daily-poker-10', 10)).toBe(
			"Play 10 Texas Hold'em Poker hands",
		);
		expect(getMissionDescription('en', 'daily-poker-wins-3', 3)).toBe(
			"Win 3 Texas Hold'em Poker hands",
		);
		expect(getMissionDescription('en', 'weekly-poker-wins-15', 15)).toBe(
			"Win 15 Texas Hold'em Poker hands",
		);
		expect(getMissionDescription('zh-Hant', 'daily-poker-10', 10)).toBe('玩 10 手德州撲克');
		expect(getMissionDescription('zh-Hant', 'daily-poker-wins-3', 3)).toBe(
			'在德州撲克中贏得 3 手牌',
		);
		expect(getMissionDescription('zh-Hant', 'weekly-poker-wins-15', 15)).toBe(
			'在德州撲克中贏得 15 手牌',
		);
		expect(getMissionDescription('zh-Hans', 'daily-poker-10', 10)).toBe('玩 10 手德州扑克');
		expect(getMissionDescription('zh-Hans', 'daily-poker-wins-3', 3)).toBe(
			'在德州扑克中赢得 3 手牌',
		);
		expect(getMissionDescription('zh-Hans', 'weekly-poker-wins-15', 15)).toBe(
			'在德州扑克中赢得 15 手牌',
		);
		expect(getMissionDescription('ja', 'daily-poker-10', 10)).toBe(
			'テキサスホールデムポーカーを 10 ハンドプレイ',
		);
		expect(getMissionDescription('ja', 'daily-poker-wins-3', 3)).toBe(
			'テキサスホールデムポーカーで 3 ハンド勝利',
		);
		expect(getMissionDescription('ja', 'weekly-poker-wins-15', 15)).toBe(
			'テキサスホールデムポーカーで 15 ハンド勝利',
		);
	});

	test('big-pot copy states the inclusive 500 net-chip threshold with {count}', () => {
		expect(getMissionDescription('en', 'daily-poker-big-pot', 1)).toBe(
			"Win 1 Texas Hold'em Poker hand with at least 500 net chips",
		);
		expect(getMissionDescription('zh-Hant', 'daily-poker-big-pot', 1)).toBe(
			'以至少 500 淨籌碼贏得 1 手德州撲克',
		);
		expect(getMissionDescription('zh-Hans', 'daily-poker-big-pot', 1)).toBe(
			'以至少 500 净筹码赢得 1 手德州扑克',
		);
		expect(getMissionDescription('ja', 'daily-poker-big-pot', 1)).toBe(
			'テキサスホールデムポーカーの 1 ハンドで 500 ネットチップ以上を獲得',
		);
	});
});
