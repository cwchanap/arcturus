import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CATALOG, DEFAULT_SHOP_ITEM_ID_BY_KIND, SHOP_ITEM_IDS } from './catalog';
import { getPokerCosmeticVars, pokerCosmeticStyleAttr } from './cosmetics';

/**
 * The Astro surfaces are asserted as source text because the Poker page is
 * only composed in `.astro` files that bun cannot render.
 */
const projectRoot = join(import.meta.dir, '../../..');

function readSource(relativePath: string): string {
	return readFileSync(join(projectRoot, relativePath), 'utf8');
}

const DEFAULT_EQUIPPED = { ...DEFAULT_SHOP_ITEM_ID_BY_KIND };

describe('poker cosmetic CSS variables', () => {
	test('paid selections receive complete url() values built from catalog paths', () => {
		const vars = getPokerCosmeticVars({
			'card-back': 'card-back-sapphire',
			felt: 'felt-jade',
		});
		expect(vars['--poker-card-back-image']).toBe("url('/images/shop/card-back-sapphire.webp')");
		expect(vars['--poker-felt-image']).toBe("url('/images/shop/felt-jade.webp')");
	});

	test('defaults receive no variable so the CSS fallback artwork stays active', () => {
		const vars = getPokerCosmeticVars(DEFAULT_EQUIPPED);
		expect(vars['--poker-card-back-image']).toBeUndefined();
		expect(vars['--poker-felt-image']).toBeUndefined();
		expect(Object.keys(vars)).toHaveLength(0);
	});

	test('each kind resolves independently: paid felt with default card back', () => {
		const vars = getPokerCosmeticVars({
			'card-back': DEFAULT_SHOP_ITEM_ID_BY_KIND['card-back'],
			felt: 'felt-crimson',
		});
		expect(vars['--poker-felt-image']).toBe("url('/images/shop/felt-crimson.webp')");
		expect(vars['--poker-card-back-image']).toBeUndefined();
	});

	test('every paid item maps to exactly url(<its catalog imagePath>)', () => {
		for (const id of SHOP_ITEM_IDS) {
			const item = CATALOG[id];
			if (item.priceChips === 0) continue;
			const vars = getPokerCosmeticVars({
				...DEFAULT_EQUIPPED,
				[item.kind]: id,
			});
			const varName = item.kind === 'felt' ? '--poker-felt-image' : '--poker-card-back-image';
			expect(vars[varName]).toBe(`url('${item.imagePath}')`);
			expect(vars[varName]).toMatch(/^url\('\/images\/[\w/-]+\.webp'\)$/);
		}
	});
});

describe('poker cosmetic style attribute', () => {
	test('joins both variables into one style value', () => {
		const attr = pokerCosmeticStyleAttr(
			getPokerCosmeticVars({ 'card-back': 'card-back-jade', felt: 'felt-sapphire' }),
		);
		expect(attr).toBe(
			"--poker-felt-image:url('/images/shop/felt-sapphire.webp');--poker-card-back-image:url('/images/shop/card-back-jade.webp')",
		);
	});

	test('is undefined for defaults so the style attribute is omitted', () => {
		expect(pokerCosmeticStyleAttr(getPokerCosmeticVars(DEFAULT_EQUIPPED))).toBeUndefined();
	});
});

describe('poker SSR cosmetic seam (source text)', () => {
	test('cosmetic style is bound on the shared #poker-root used by both modes', () => {
		const page = readSource('src/pages/games/poker.astro');
		const rootTag = page.slice(
			page.indexOf('<div'),
			page.indexOf('<div', page.indexOf('id="poker-root"')),
		);
		expect(rootTag).toContain('id="poker-root"');
		expect(rootTag).toContain('style={cosmeticStyle}');
		// Both modes share this root: the style must not be gated on the mode.
		expect(rootTag).toContain('data-poker-mode');
	});

	test('authenticated SSR sets private, no-store and reads the shop state', () => {
		const page = readSource('src/pages/games/poker.astro');
		expect(page).toContain("Astro.response.headers.set('Cache-Control', 'private, no-store')");
		expect(page).toContain('readShopState(d1, user.id)');
	});

	test('poker.css consumes the variables with the original artwork as fallback', () => {
		const css = readSource('src/styles/poker.css');
		expect(css).toContain("var(--poker-felt-image, url('/images/poker/felt.webp'))");
		expect(css).toContain("var(--poker-card-back-image, url('/images/poker/card-back.webp'))");
	});
});
