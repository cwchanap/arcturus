/**
 * Poker page sound-button copy. The shared mute binder
 * (src/lib/sound-preference.ts) only flips a button's accessible on/off
 * label when the button ships localized labels as `data-sound-label-*`
 * attributes, so poker.astro must provide them on #btn-sound. The Astro
 * surface is asserted as source text because bun cannot render it.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUPPORTED_LOCALES } from '../locale';
import { POKER_MESSAGES } from './poker';

const projectRoot = join(import.meta.dir, '../../../..');

const SOUND_LABELS: Record<(typeof SUPPORTED_LOCALES)[number], { on: string; off: string }> = {
	en: { on: 'Sound on', off: 'Sound off' },
	'zh-Hant': { on: '音效開', off: '音效關' },
	'zh-Hans': { on: '音效开', off: '音效关' },
	ja: { on: '効果音オン', off: '効果音オフ' },
};

describe('poker sound button labels', () => {
	test('soundOn/soundOff are translated in every locale', () => {
		for (const locale of SUPPORTED_LOCALES) {
			const branch = POKER_MESSAGES[locale] as Record<string, string>;
			expect(branch.soundOn).toBe(SOUND_LABELS[locale].on);
			expect(branch.soundOff).toBe(SOUND_LABELS[locale].off);
		}
	});

	test('#btn-sound ships data-sound-label-on/off for the shared binder', () => {
		const page = readFileSync(join(projectRoot, 'src/pages/games/poker.astro'), 'utf8');
		expect(page).toContain(`data-sound-label-on={t('soundOn')}`);
		expect(page).toContain(`data-sound-label-off={t('soundOff')}`);
	});
});
