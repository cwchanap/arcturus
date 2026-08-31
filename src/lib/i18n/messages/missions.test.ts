import { describe, expect, test } from 'bun:test';
import { getMissionDescription, getMissionTitle } from './missions';

describe('missions message catalog', () => {
	test('serves non-English copy for mission titles and descriptions', () => {
		expect(getMissionTitle('zh-Hant', 'daily-win-3')).toBe('三連勝');
		expect(getMissionDescription('ja', 'daily-win-3', 3)).toBe('任意のゲームで 3 ラウンド勝利');
	});
});
