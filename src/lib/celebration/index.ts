/**
 * Shared big-win celebration: one viewport-center overlay with a chip burst
 * (plus ribbon, localized title and animated net amount on huge tiers), and
 * the shipped SFX clips, gated by the site-wide sound preference. Games call
 * `celebrateWin` (net win vs stake) or, for Poker, resolve the tier with
 * `winTier` against big blinds and call `showCelebration` directly. The
 * overlay is pointer-transparent and aria-hidden because every game already
 * announces its own result.
 */

import { formatChips } from '../i18n/messages/common';
import { getDocumentLocale, type Locale } from '../i18n/locale';
import { createTranslator, defineMessages } from '../i18n/translate';
import { isSoundMuted } from '../sound-preference';
import { type WinTier, winTier } from './tier';

export { WIN_TIER_MULTIPLES, winTier } from './tier';
export type { WinTier } from './tier';

const COIN_SHOWER_SRC = '/audio/fx/coin-shower.mp3';
const BIG_WIN_STING_SRC = '/audio/fx/big-win-sting.mp3';
const CHIP_SRCS = [
	'/images/fx/chip-gold.webp',
	'/images/fx/chip-red.webp',
	'/images/fx/chip-blue.webp',
];
const SPARKLE_SRC = '/images/fx/sparkle.webp';
const RIBBON_SRC = '/images/fx/big-win-ribbon.webp';

/** Native ribbon size and its measured text-safe rectangle (HPA-728). */
const RIBBON_NATIVE = { width: 960, height: 320 } as const;
const RIBBON_SAFE_RECT = { x: 165, y: 64, width: 630, height: 192 } as const;

const CELEBRATION_DURATION_MS = 1600;
const COUNT_UP_MS = 800;
const CHIP_COUNT = 36;
const SPARKLE_COUNT = 5;

const CELEBRATION_MESSAGES = defineMessages({
	en: { title: 'Big Win' },
	'zh-Hant': { title: '大獎' },
	'zh-Hans': { title: '大奖' },
	ja: { title: '大勝利' },
});

let overlay: HTMLDivElement | null = null;
let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
let activeAnimations: Animation[] = [];
let countFrame: number | null = null;

/** Ordinary-game entrypoint: classify net win against the round stake. */
export function celebrateWin({ win, stake }: { win: number; stake: number }): void {
	const tier = winTier(win, stake);
	if (tier) showCelebration(tier, win);
}

/** Poker entrypoint: the game resolves the tier against big blinds itself. */
export function showCelebration(tier: WinTier, amount: number): void {
	if (!Number.isFinite(amount) || amount <= 0) return;
	if (typeof document === 'undefined' || !document.body) return;

	// A new win replaces the previous effect instead of stacking; even this
	// replacement teardown sits inside the boundary so a failing cleanup can
	// never propagate into the caller's settlement path.
	try {
		teardown();
		stopClips();
		const host = getOverlay();
		const locale = getDocumentLocale();
		const reduced = prefersReducedMotion();

		if (!reduced) spawnBurst(host);
		if (tier === 'huge') {
			host.appendChild(buildRibbon(amount, locale, reduced));
		} else if (reduced) {
			host.appendChild(buildStaticAmount(amount, locale));
		}
		// Audio follows the mute preference alone; reduced motion limits visuals.
		playClip(COIN_SHOWER_SRC);
		if (tier === 'huge') playClip(BIG_WIN_STING_SRC);
		cleanupTimer = setTimeout(teardown, CELEBRATION_DURATION_MS);
	} catch {
		// The celebration is purely cosmetic: a failure (e.g. WAAPI missing)
		// must never reach the game — drop any partial effect instead.
		teardown();
	}
}

/** Runs one cleanup step; a cosmetic failure must never reach gameplay. */
function bestEffort(cleanup: () => void): void {
	try {
		cleanup();
	} catch {
		// A broken/stubbed DOM or timer API must not skip the remaining steps.
	}
}

function teardown(): void {
	if (cleanupTimer !== undefined) {
		bestEffort(() => clearTimeout(cleanupTimer));
		cleanupTimer = undefined;
	}
	if (countFrame !== null) {
		const frame = countFrame;
		bestEffort(() => cancelAnimationFrame(frame));
		countFrame = null;
	}
	for (const animation of activeAnimations) {
		bestEffort(() => {
			// Cancel rejects the finished promise; silence it so replacing a
			// running effect never surfaces an AbortError to the page.
			animation.finished?.catch(() => {});
			animation.cancel();
		});
	}
	activeAnimations = [];
	bestEffort(() => overlay?.replaceChildren());
}

function getOverlay(): HTMLDivElement {
	// Recreate if the page replaced its body or whole document (HMR, tests);
	// an overlay from a previous document is stale even while still connected.
	if (overlay?.isConnected && overlay.ownerDocument === document) return overlay;
	const element = document.createElement('div');
	element.dataset.celebrationOverlay = '';
	element.setAttribute('aria-hidden', 'true');
	const style = element.style;
	style.position = 'fixed';
	style.left = '0';
	style.top = '0';
	style.right = '0';
	style.bottom = '0';
	style.pointerEvents = 'none';
	style.overflow = 'hidden';
	style.zIndex = '9999';
	document.body.appendChild(element);
	overlay = element;
	return element;
}

function prefersReducedMotion(): boolean {
	try {
		return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	} catch {
		return false;
	}
}

function spawnBurst(host: HTMLDivElement): void {
	const total = CHIP_COUNT + SPARKLE_COUNT;
	for (let i = 0; i < total; i++) {
		const isSparkle = i >= CHIP_COUNT;
		const particle = document.createElement('img');
		particle.src = isSparkle
			? SPARKLE_SRC
			: CHIP_SRCS[Math.floor(Math.random() * CHIP_SRCS.length)];
		particle.alt = '';
		const size = Math.round(isSparkle ? 14 + Math.random() * 12 : 30 + Math.random() * 26);
		const drift = (Math.random() * 2 - 1) * 440;
		const apex = -(40 + Math.random() * 200);
		const fall = apex + 280 + Math.random() * 260;
		const spin = Math.random() * 720 - 360;
		const flip = Math.random() < 0.4 ? -1 : 1;
		const style = particle.style;
		style.position = 'absolute';
		style.left = '50%';
		style.top = '50%';
		style.width = `${size}px`;
		style.height = 'auto';
		const transform = (x: string, y: string, rotation: string, scaleX: number): string =>
			`translate(-50%, -50%) translate(${x}, ${y}) rotate(${rotation}) scaleX(${scaleX})`;
		const animation = particle.animate(
			[
				{ transform: transform('0px', '0px', '0deg', 1), opacity: '1', easing: 'ease-out' },
				{
					transform: transform(`${drift}px`, `${apex}px`, `${spin / 2}deg`, flip),
					opacity: '1',
					easing: 'ease-in',
					offset: 0.45,
				},
				{ transform: transform(`${drift}px`, `${fall}px`, `${spin}deg`, flip), opacity: '0' },
			],
			{ duration: CELEBRATION_DURATION_MS, fill: 'forwards' },
		);
		activeAnimations.push(animation);
		host.appendChild(particle);
	}
}

function buildRibbon(amount: number, locale: Locale, reduced: boolean): HTMLDivElement {
	const ribbon = document.createElement('div');
	ribbon.dataset.celebrationRibbon = '';
	const ribbonStyle = ribbon.style;
	ribbonStyle.position = 'absolute';
	ribbonStyle.left = '50%';
	ribbonStyle.top = '50%';
	ribbonStyle.transform = 'translate(-50%, -50%)';
	ribbonStyle.width = `${RIBBON_NATIVE.width}px`;
	ribbonStyle.maxWidth = '92vw';

	const art = document.createElement('img');
	art.src = RIBBON_SRC;
	art.alt = '';
	const artStyle = art.style;
	artStyle.display = 'block';
	artStyle.width = '100%';
	artStyle.height = 'auto';

	const safe = document.createElement('div');
	const safeStyle = safe.style;
	safeStyle.position = 'absolute';
	safeStyle.left = `${(RIBBON_SAFE_RECT.x / RIBBON_NATIVE.width) * 100}%`;
	safeStyle.top = `${(RIBBON_SAFE_RECT.y / RIBBON_NATIVE.height) * 100}%`;
	safeStyle.width = `${(RIBBON_SAFE_RECT.width / RIBBON_NATIVE.width) * 100}%`;
	safeStyle.height = `${(RIBBON_SAFE_RECT.height / RIBBON_NATIVE.height) * 100}%`;
	safeStyle.display = 'flex';
	safeStyle.flexDirection = 'column';
	safeStyle.alignItems = 'center';
	safeStyle.justifyContent = 'center';
	safeStyle.gap = '4%';

	const title = document.createElement('div');
	title.dataset.celebrationTitle = '';
	const titleStyle = title.style;
	titleStyle.color = 'var(--deco-brass-bright)';
	titleStyle.fontWeight = '700';
	titleStyle.fontSize = 'clamp(22px, 4.2vw, 46px)';
	titleStyle.letterSpacing = '0.04em';
	titleStyle.textShadow = '0 2px 10px rgba(0, 0, 0, 0.9)';
	titleStyle.whiteSpace = 'nowrap';
	title.textContent = createTranslator(CELEBRATION_MESSAGES, locale)('title');

	const count = document.createElement('div');
	count.dataset.celebrationAmount = '';
	const countStyle = count.style;
	countStyle.color = 'var(--deco-ivory)';
	countStyle.fontWeight = '700';
	countStyle.fontSize = 'clamp(20px, 3.4vw, 38px)';
	countStyle.textShadow = '0 2px 10px rgba(0, 0, 0, 0.9)';
	if (reduced) count.textContent = formatChips(amount, locale);
	else startCountUp(count, amount, locale);

	safe.appendChild(title);
	safe.appendChild(count);
	ribbon.appendChild(art);
	ribbon.appendChild(safe);
	return ribbon;
}

function buildStaticAmount(amount: number, locale: Locale): HTMLDivElement {
	const badge = document.createElement('div');
	badge.textContent = formatChips(amount, locale);
	const style = badge.style;
	style.position = 'absolute';
	style.left = '50%';
	style.top = '50%';
	style.transform = 'translate(-50%, -50%)';
	style.padding = '10px 22px';
	style.borderRadius = '12px';
	style.background = 'rgba(11, 15, 14, 0.85)';
	style.border = '1px solid var(--deco-brass)';
	style.color = 'var(--deco-brass-bright)';
	style.fontWeight = '700';
	style.fontSize = 'clamp(24px, 4vw, 40px)';
	style.textShadow = '0 2px 8px rgba(0, 0, 0, 0.9)';
	style.whiteSpace = 'nowrap';
	return badge;
}

function startCountUp(element: HTMLElement, amount: number, locale: Locale): void {
	if (typeof requestAnimationFrame !== 'function') {
		element.textContent = formatChips(amount, locale);
		return;
	}
	let startedAt: number | null = null;
	const tick = (time: number) => {
		if (startedAt === null) startedAt = time;
		const progress = Math.min(1, (time - startedAt) / COUNT_UP_MS);
		const eased = 1 - (1 - progress) * (1 - progress);
		element.textContent = formatChips(Math.round(amount * eased), locale);
		countFrame = progress < 1 ? requestAnimationFrame(tick) : null;
	};
	countFrame = requestAnimationFrame(tick);
}

const clips = new Map<string, HTMLAudioElement>();
/** Document the clip cache was built against; a replaced document invalidates it. */
let clipsDocument: Document | null = null;

function getClip(src: string): HTMLAudioElement | null {
	if (clipsDocument !== document) {
		clips.clear();
		clipsDocument = document;
	}
	const cached = clips.get(src);
	if (cached) return cached;
	const AudioCtor = typeof window === 'undefined' ? undefined : window.Audio;
	if (typeof AudioCtor !== 'function') return null;
	try {
		const clip = new AudioCtor(src);
		clips.set(src, clip);
		return clip;
	} catch {
		return null;
	}
}

/**
 * Pauses and rewinds every cached clip. A replacement must silence clips the
 * new tier does not play — e.g. a huge celebration's sting keeps sounding
 * through a following big one if only the replayed clips are stopped.
 */
function stopClips(): void {
	for (const clip of clips.values()) {
		bestEffort(() => {
			clip.pause();
			clip.currentTime = 0;
		});
	}
}

function playClip(src: string): void {
	const clip = getClip(src);
	if (!clip) return;
	try {
		// Stop and rewind even when muted: a muted celebration must silence
		// the previous celebration's still-running clip, not just skip its own.
		clip.pause();
		clip.currentTime = 0;
	} catch {
		// A broken/stubbed audio element must not interrupt the result.
	}
	if (isSoundMuted()) return;
	try {
		Promise.resolve(clip.play()).catch(() => {
			// Autoplay policies and odd mocks may reject playback; stay silent.
		});
	} catch {
		// play() can also throw synchronously; never interrupt the result.
	}
}
