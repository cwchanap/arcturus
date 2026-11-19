/**
 * Header sound toggle's visible muted state. The shared binder
 * (src/lib/sound-preference.ts) only manages `aria-pressed` and the
 * accessible label, so the visible off state must be CSS keyed on
 * `aria-pressed` inside the component itself, mirroring the Poker
 * `.poker-toggle` pattern. The Astro surface is asserted as source text
 * because bun cannot render it.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const component = readFileSync(join(import.meta.dir, 'SoundToggle.astro'), 'utf8');

describe('SoundToggle component', () => {
	test('ships localized on/off labels and an initial pressed state', () => {
		expect(component).toContain('data-sound-label-on');
		expect(component).toContain('data-sound-label-off');
		expect(component).toContain('aria-pressed="true"');
	});

	test('renders distinct on and off icon states keyed by aria-pressed', () => {
		expect(component).toContain('sound-toggle-on');
		expect(component).toContain('sound-toggle-off');
		// Only the active icon state shows: waves hidden while muted, the
		// mute cross hidden while unmuted.
		expect(component).toContain("[data-sound-toggle][aria-pressed='true'] .sound-toggle-off");
		expect(component).toContain("[data-sound-toggle][aria-pressed='false'] .sound-toggle-on");
		expect(component).toContain('display: none');
	});

	test('stays hidden until the binder applies the saved preference', () => {
		// The shipped markup defaults to the unmuted look; without this rule a
		// muted reader would see "sound on" until the module script runs.
		expect(component).toContain('[data-sound-toggle]:not([data-sound-bound])');
	});
});
