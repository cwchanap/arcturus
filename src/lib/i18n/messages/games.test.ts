import { describe, expect, test } from 'bun:test';
import { GAME_TYPES } from '../../game-stats/constants';
import { SUPPORTED_LOCALES } from '../locale';
import { getGameName, type GameNameKey } from './games';

// Compile-time completeness: every GAME_TYPES member plus the three lobby
// extras must be a GameNameKey, and every key resolves in every locale.
const ALL_KEYS = [
	...GAME_TYPES,
	'daily-challenge',
	'poker-mp',
	'blackjack-ranked',
] as const satisfies readonly GameNameKey[];

describe('getGameName catalog', () => {
	test('covers every GAME_TYPES member plus the three lobby extras', () => {
		const expected: GameNameKey[] = [
			...GAME_TYPES,
			'daily-challenge',
			'poker-mp',
			'blackjack-ranked',
		];
		expect([...ALL_KEYS].sort()).toEqual(expected.sort());
	});

	test('every key resolves to a non-empty name in every locale', () => {
		for (const locale of SUPPORTED_LOCALES) {
			for (const key of ALL_KEYS) {
				const name = getGameName(locale, key);
				expect(typeof name).toBe('string');
				expect(name.length).toBeGreaterThan(0);
			}
		}
	});

	test('English reuses GAME_TYPE_LABELS with the normalized poker label', () => {
		expect(getGameName('en', 'poker')).toBe("Texas Hold'em Poker");
		expect(getGameName('en', 'blackjack')).toBe('Blackjack');
		expect(getGameName('en', 'pai-gow-poker')).toBe('Pai Gow Poker');
		expect(getGameName('en', 'daily-challenge')).toBe('Daily Challenge');
		expect(getGameName('en', 'poker-mp')).toBe('Multiplayer Poker');
		expect(getGameName('en', 'blackjack-ranked')).toBe('Ranked Blackjack');
	});

	test('non-English locales translate game names', () => {
		expect(getGameName('zh-Hant', 'poker')).toBe('德州撲克');
		expect(getGameName('zh-Hant', 'blackjack')).toBe('二十一點');
		expect(getGameName('zh-Hans', 'poker')).toBe('德州扑克');
		expect(getGameName('zh-Hans', 'blackjack')).toBe('二十一点');
		expect(getGameName('ja', 'poker')).toBe('テキサスホールデムポーカー');
		expect(getGameName('ja', 'blackjack')).toBe('ブラックジャック');
		expect(getGameName('ja', 'poker-mp')).toBe('マルチプレイヤーポーカー');
		expect(getGameName('ja', 'blackjack-ranked')).toBe('ランク戦ブラックジャック');
	});
});
