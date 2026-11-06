/**
 * Lobby presence-copy tests. The lobby makes no unsupported presence claims:
 * no fake player counts on cards, and the hero stat reports the factual
 * number of games (`games.length`), labeled per locale.
 *
 * The Astro surfaces are asserted as source text because cards and the hero
 * are only composed in `.astro` files that bun cannot render.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUPPORTED_LOCALES } from '../locale';
import { GAME_CARD_MESSAGES, HOME_MESSAGES } from './home';

const projectRoot = join(import.meta.dir, '../../../..');

function readSource(relativePath: string): string {
	return readFileSync(join(projectRoot, relativePath), 'utf8');
}

describe('lobby game card copy', () => {
	test('no player-count copy in any locale, meta line keeps the minimum wager', () => {
		for (const locale of SUPPORTED_LOCALES) {
			const branch = GAME_CARD_MESSAGES[locale] as Record<string, string>;
			expect('playersPlaying' in branch).toBe(false);
			expect(branch.minBet).toBeTruthy();
			expect(branch.featured).toBeTruthy();
			expect(branch.play).toBeTruthy();
		}
	});
});

describe('home hero stats copy', () => {
	test('games-available label exists in all four locales', () => {
		for (const locale of SUPPORTED_LOCALES) {
			const branch = HOME_MESSAGES[locale] as Record<string, string>;
			expect(branch.statGamesAvailable).toBeTruthy();
		}
		expect(HOME_MESSAGES.en.statGamesAvailable).toBe('Games Available');
		expect((HOME_MESSAGES['zh-Hant'] as Record<string, string>).statGamesAvailable).toBe(
			'可玩遊戲',
		);
		expect((HOME_MESSAGES['zh-Hans'] as Record<string, string>).statGamesAvailable).toBe(
			'可玩游戏',
		);
		expect((HOME_MESSAGES.ja as Record<string, string>).statGamesAvailable).toBe('遊べるゲーム');
	});

	test('no players-online stat in any locale', () => {
		for (const locale of SUPPORTED_LOCALES) {
			const branch = HOME_MESSAGES[locale] as Record<string, string>;
			expect('statPlayersOnline' in branch).toBe(false);
		}
	});
});

describe('lobby surfaces make no presence claims', () => {
	test('home page has no presence stat or players field and its hero count is games.length', () => {
		const page = readSource('src/pages/index.astro');
		// Assert the removed presence-claim artifacts — the fabricated count,
		// its message key, and a `players` registry field/prop — rather than
		// the bare word "players", which unrelated copy could legitimately use.
		expect(page).not.toContain('statPlayersOnline');
		expect(page).not.toContain('5,680');
		expect(page).not.toMatch(/players\s*[=:]/);
		expect(page).toContain('formatWholeNumber(games.length');
	});

	test('game card keeps the minimum wager but no player count', () => {
		const card = readSource('src/components/GameCard.astro');
		expect(card).not.toContain('playersPlaying');
		expect(card).not.toMatch(/players\s*[=:]/);
		expect(card).toContain(`t('minBet'`);
	});
});
