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
});
