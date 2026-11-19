import { expect, test } from '@playwright/test';
import type { Locale } from '../src/lib/i18n/locale';
import { formatChips } from '../src/lib/i18n/messages/common';

/**
 * Geometry regression for the huge-tier celebration overlay (HPA-729).
 *
 * Triggers a fixed net win through the production entrypoint via the Vite
 * dev-module import — no debug route, window global, or RNG rigging — and
 * asserts the localized ribbon title and animated count stay inside the
 * ribbon's measured text-safe band across four locales × desktop/phone.
 * This complements browser-MCP visual acceptance; it does not replace it.
 */

const LOCALES = ['en', 'zh-Hant', 'zh-Hans', 'ja'] as const satisfies readonly Locale[];
const TITLE_TEXT: Record<(typeof LOCALES)[number], string> = {
	en: 'Big Win',
	'zh-Hant': '大獎',
	'zh-Hans': '大奖',
	ja: '大勝利',
};

/** Native ribbon size and its measured text-safe rectangle (HPA-728). */
const RIBBON_NATIVE = { width: 960, height: 320 } as const;
const SAFE_RECT = { x: 165, y: 64, width: 630, height: 192 } as const;
/** Slack for fractional layout rounding across viewports. */
const PX_SLACK = 0.5;
const WIN = 200;
const STAKE = 10; // 20× stake → huge tier

const VIEWPORTS = [
	{ name: 'desktop', width: 1280, height: 800 },
	{ name: 'phone', width: 375, height: 812 },
] as const;

for (const { name, width, height } of VIEWPORTS) {
	test.describe(`huge celebration geometry (${name})`, () => {
		test.use({ viewport: { width, height } });

		for (const locale of LOCALES) {
			test(`localized ribbon title and count stay inside the safe band (${locale})`, async ({
				page,
				context,
			}) => {
				await context.addCookies([
					{ name: 'arcturus_locale', value: locale, domain: 'localhost', path: '/' },
				]);
				await page.goto('/games/keno');

				await page.evaluate(async () => {
					// Runtime string (Vite dev serves the module); typed as a plain
					// string to keep astro check from resolving the page-side specifier.
					const fx = await import('/src/lib/celebration/index.ts' as string);
					fx.celebrateWin({ win: 200, stake: 10 });
				});

				const overlay = page.locator('[data-celebration-overlay]');
				const title = page.locator('[data-celebration-title]');
				const amount = page.locator('[data-celebration-amount]');
				// Visibility guards: hidden nodes satisfy toHaveText, so require
				// rendered elements within the ~1.6s effect lifetime.
				await expect(overlay).toBeVisible();
				await expect(overlay).toHaveAttribute('aria-hidden', 'true');
				await expect(title).toBeVisible();
				await expect(title).toHaveText(TITLE_TEXT[locale]);
				await expect(amount).toBeVisible();
				// Count-up (~0.8s) finishes well before the 1.6s teardown.
				await expect(amount).toHaveText(formatChips(WIN, locale), { timeout: 2_000 });

				const measured = await page.evaluate(() => {
					const box = (selector: string) => {
						const el = document.querySelector(selector);
						if (!el) throw new Error(`missing element: ${selector}`);
						const r = el.getBoundingClientRect();
						return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
					};
					const overlay = document.querySelector('[data-celebration-overlay]');
					if (!overlay) throw new Error('missing celebration overlay');
					return {
						ribbon: box('[data-celebration-ribbon]'),
						title: box('[data-celebration-title]'),
						amount: box('[data-celebration-amount]'),
						overlayPointerEvents: getComputedStyle(overlay).pointerEvents,
						centerHit: (() => {
							const target = document.elementFromPoint(
								window.innerWidth / 2,
								window.innerHeight / 2,
							);
							const insideOverlay =
								target instanceof Element && (target === overlay || overlay.contains(target));
							return { tag: target instanceof Element ? target.tagName : 'none', insideOverlay };
						})(),
					};
				});

				// Scale the measured safe band from ribbon-native coordinates.
				const ribbonWidth = measured.ribbon.right - measured.ribbon.left;
				const ribbonHeight = measured.ribbon.bottom - measured.ribbon.top;
				const band = {
					left: measured.ribbon.left + (SAFE_RECT.x / RIBBON_NATIVE.width) * ribbonWidth,
					top: measured.ribbon.top + (SAFE_RECT.y / RIBBON_NATIVE.height) * ribbonHeight,
					right:
						measured.ribbon.left +
						((SAFE_RECT.x + SAFE_RECT.width) / RIBBON_NATIVE.width) * ribbonWidth,
					bottom:
						measured.ribbon.top +
						((SAFE_RECT.y + SAFE_RECT.height) / RIBBON_NATIVE.height) * ribbonHeight,
				};
				for (const [label, rect] of [
					['title', measured.title],
					['count', measured.amount],
				] as const) {
					// Non-zero geometry: a zero-sized rect passes any containment check.
					expect(rect.right - rect.left, `${label} has non-zero width`).toBeGreaterThan(0);
					expect(rect.bottom - rect.top, `${label} has non-zero height`).toBeGreaterThan(0);
					expect(rect.left, `${label} left edge inside safe band`).toBeGreaterThanOrEqual(
						band.left - PX_SLACK,
					);
					expect(rect.top, `${label} top edge inside safe band`).toBeGreaterThanOrEqual(
						band.top - PX_SLACK,
					);
					expect(rect.right, `${label} right edge inside safe band`).toBeLessThanOrEqual(
						band.right + PX_SLACK,
					);
					expect(rect.bottom, `${label} bottom edge inside safe band`).toBeLessThanOrEqual(
						band.bottom + PX_SLACK,
					);
				}

				// The overlay never captures the pointer.
				expect(measured.overlayPointerEvents).toBe('none');
				expect(
					measured.centerHit.insideOverlay,
					'center hit-test resolves outside the overlay',
				).toBe(false);

				// A real click passes through the overlay to the element underneath.
				// The listener records whether the ribbon and its text were still
				// rendered at click time — the overlay host persists after teardown
				// (it is only emptied), so host connection alone proves nothing.
				// Retrigger first: the waits and geometry reads above can consume
				// most of the 1.6s lifetime, and a click after teardown would only
				// measure an emptied host, not click-through of a live effect.
				await page.evaluate(async () => {
					const fx = await import('/src/lib/celebration/index.ts' as string);
					fx.celebrateWin({ win: 200, stake: 10 });
				});
				// The click probe records non-zero geometry for ribbon, title and
				// amount; the ribbon image and the first count-up frame commit
				// size asynchronously, so wait for all three before clicking.
				await page.waitForFunction(() => {
					const overlay = document.querySelector('[data-celebration-overlay]');
					if (!overlay) return false;
					const rendered = (selector: string): boolean => {
						const node = document.querySelector(selector);
						if (node === null || !overlay.contains(node)) return false;
						const rect = node.getBoundingClientRect();
						return rect.width > 0 && rect.height > 0;
					};
					return (
						rendered('[data-celebration-ribbon]') &&
						rendered('[data-celebration-title]') &&
						rendered('[data-celebration-amount]')
					);
				});
				await page.evaluate(() => {
					const w = window as {
						celebrationE2EClick?: { target: string | null; overlayLive: boolean };
					};
					w.celebrationE2EClick = { target: null, overlayLive: false };
					document.addEventListener(
						'click',
						(event) => {
							const el = event.target instanceof Element ? event.target : null;
							const overlay = document.querySelector('[data-celebration-overlay]');
							const insideOverlay =
								el !== null && overlay !== null && (el === overlay || overlay.contains(el));
							// Rendered = present inside the overlay with non-zero geometry.
							// Teardown empties the host, so an emptied overlay reports false.
							const rendered = (selector: string): boolean => {
								const node = document.querySelector(selector);
								if (node === null || overlay === null || !overlay.contains(node)) return false;
								const rect = node.getBoundingClientRect();
								return rect.width > 0 && rect.height > 0;
							};
							w.celebrationE2EClick = {
								target: insideOverlay ? 'overlay' : (el?.tagName ?? 'none'),
								overlayLive:
									rendered('[data-celebration-ribbon]') &&
									rendered('[data-celebration-title]') &&
									rendered('[data-celebration-amount]'),
							};
						},
						{ once: true, capture: true },
					);
				});
				await page.mouse.click(width / 2, height / 2);
				const click = await page.evaluate(
					() =>
						(
							window as {
								celebrationE2EClick?: { target: string | null; overlayLive: boolean };
							}
						).celebrationE2EClick ?? null,
				);
				expect(click?.overlayLive, 'ribbon and its text still rendered at click time').toBe(true);
				expect(click?.target, 'real click lands on the underlying element').toBe(
					measured.centerHit.tag,
				);
			});
		}
	});
}
