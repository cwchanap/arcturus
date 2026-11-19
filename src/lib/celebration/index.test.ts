import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { formatChips } from '../i18n/messages/common';
import { setSoundMuted } from '../sound-preference';
import { celebrateWin, showCelebration } from './index';

const COIN_SRC = '/audio/fx/coin-shower.mp3';
const STING_SRC = '/audio/fx/big-win-sting.mp3';
const RIBBON_SRC = '/images/fx/big-win-ribbon.webp';
const SPARKLE_SRC = '/images/fx/sparkle.webp';
const CHIP_SOURCES = [
	'/images/fx/chip-gold.webp',
	'/images/fx/chip-red.webp',
	'/images/fx/chip-blue.webp',
];
const ALL_PARTICLE_SOURCES = [...CHIP_SOURCES, SPARKLE_SRC];

/** Audio double logging the exact call order (pause/reset/replay assertions). */
type LoggedAudio = {
	src: string;
	currentTime: number;
	playCalls: number;
	pauseCalls: number;
	log: string[];
};

const audioLog: LoggedAudio[] = [];
let playImpl: () => unknown = () => Promise.resolve();

class FakeAudio {
	src: string;
	private _currentTime = 0;
	playCalls = 0;
	pauseCalls = 0;
	log: string[] = [];

	constructor(src: string) {
		this.src = src;
		audioLog.push(this);
	}

	get currentTime(): number {
		return this._currentTime;
	}

	set currentTime(value: number) {
		this._currentTime = value;
		this.log.push(`currentTime=${value}`);
	}

	pause(): void {
		this.pauseCalls++;
		this.log.push('pause');
	}

	play(): unknown {
		this.playCalls++;
		this.log.push('play');
		return playImpl();
	}
}

const pendingTimers = new Map<number, { id: number; callback: () => void }>();
const clearedTimers: number[] = [];
const pendingFrames = new Map<number, (time: number) => void>();
const cancelledFrames: number[] = [];
const cancelledAnimations: unknown[] = [];

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const happyWindow = new Window();
/** happy-dom document typed as the standard lib.dom Document for querySelector generics. */
const doc = happyWindow.document as unknown as Document;
const originalMatchMedia = happyWindow.matchMedia.bind(happyWindow) as unknown;
const setMatchMedia = (impl: unknown): void => {
	(happyWindow as unknown as { matchMedia: unknown }).matchMedia = impl;
};
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

beforeAll(() => {
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		writable: true,
		value: happyWindow,
	});
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		writable: true,
		value: happyWindow.document,
	});
	(happyWindow as unknown as { Audio: unknown }).Audio = FakeAudio;

	globalThis.setTimeout = ((callback: () => void) => {
		const id = pendingTimers.size + clearedTimers.length + 1;
		pendingTimers.set(id, { id, callback });
		return id;
	}) as unknown as typeof setTimeout;
	globalThis.clearTimeout = ((id?: number) => {
		if (id !== undefined && pendingTimers.delete(id)) clearedTimers.push(id);
	}) as unknown as typeof clearTimeout;
	globalThis.requestAnimationFrame = ((callback: (time: number) => void) => {
		const id = pendingFrames.size + cancelledFrames.length + 1;
		pendingFrames.set(id, callback);
		return id;
	}) as unknown as typeof requestAnimationFrame;
	globalThis.cancelAnimationFrame = ((id?: number) => {
		if (id !== undefined && pendingFrames.delete(id)) cancelledFrames.push(id);
	}) as unknown as typeof cancelAnimationFrame;

	// Spy on WAAPI so replace-semantics can assert previous animations cancel.
	const imageProto = happyWindow.HTMLImageElement.prototype as unknown as {
		animate: (
			this: unknown,
			...args: unknown[]
		) => { cancel: () => void; finished?: Promise<unknown> };
	};
	const nativeAnimate = imageProto.animate;
	imageProto.animate = function (this: unknown, ...args: unknown[]) {
		const animation = nativeAnimate.apply(this, args);
		// happy-dom eagerly rejects the finished promise on cancel(); silence it.
		animation.finished?.catch(() => {});
		const nativeCancel = animation.cancel.bind(animation);
		animation.cancel = () => {
			cancelledAnimations.push(animation);
			nativeCancel();
		};
		return animation;
	};
});

afterAll(() => {
	happyWindow.close();
	globalThis.setTimeout = originalSetTimeout;
	globalThis.clearTimeout = originalClearTimeout;
	globalThis.requestAnimationFrame = originalRequestAnimationFrame;
	globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
	if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
	else Reflect.deleteProperty(globalThis, 'window');
	if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
	else Reflect.deleteProperty(globalThis, 'document');
});

beforeEach(() => {
	pendingTimers.clear();
	clearedTimers.length = 0;
	pendingFrames.clear();
	cancelledFrames.length = 0;
	cancelledAnimations.length = 0;
	// audioLog is deliberately cumulative: the production clip cache lives for
	// the whole page, so earlier instances stay in use across tests.
	playImpl = () => Promise.resolve();
	setSoundMuted(false);
	setMatchMedia(originalMatchMedia);
	doc.body.replaceChildren();
	doc.documentElement.removeAttribute('data-locale');
});

function overlay(): HTMLElement | null {
	return doc.querySelector('[data-celebration-overlay]');
}

function fireCleanupTimer(): void {
	expect(pendingTimers.size).toBe(1);
	for (const timer of [...pendingTimers.values()]) {
		pendingTimers.delete(timer.id);
		timer.callback();
	}
}

/** Drains scheduled rAF callbacks with a 16 ms monotonic clock. */
function drainAnimationFrames(): void {
	let clock = 0;
	for (let wave = 0; wave < 200 && pendingFrames.size > 0; wave++) {
		const frames = [...pendingFrames.entries()];
		pendingFrames.clear();
		clock += 16;
		for (const [, frame] of frames) frame(clock);
	}
}

function coinAudio(): LoggedAudio | undefined {
	return audioLog.find((audio) => audio.src === COIN_SRC);
}

function stingAudio(): LoggedAudio | undefined {
	return audioLog.find((audio) => audio.src === STING_SRC);
}

function stubReducedMotion(reduced: boolean): void {
	setMatchMedia((query: string) => ({
		matches: reduced && query.includes('prefers-reduced-motion'),
		media: query,
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false,
	}));
}

function celebrationImages(): HTMLImageElement[] {
	return [...doc.querySelectorAll<HTMLImageElement>('[data-celebration-overlay] img')];
}

function srcsOf(images: HTMLImageElement[]): string[] {
	return images.map((image) => image.getAttribute('src') ?? '');
}

describe('showCelebration overlay', () => {
	test('lazily appends exactly one fixed, click-through, aria-hidden overlay', () => {
		showCelebration('big', 100);
		const first = overlay();
		expect(first).not.toBeNull();
		expect(first?.parentElement).toBe(doc.body);
		expect(first?.getAttribute('aria-hidden')).toBe('true');
		expect(first?.style.pointerEvents).toBe('none');
		expect(first?.style.position).toBe('fixed');

		showCelebration('huge', 100);
		expect(doc.querySelectorAll('[data-celebration-overlay]').length).toBe(1);
	});

	test('big burst uses 30-40 chips plus sparkles, all from shipped assets', () => {
		showCelebration('big', 100);
		const images = celebrationImages();
		const chips = srcsOf(images).filter((src) => src?.startsWith('/images/fx/chip-'));
		const sparkles = srcsOf(images).filter((src) => src === SPARKLE_SRC);
		expect(chips.length).toBeGreaterThanOrEqual(30);
		expect(chips.length).toBeLessThanOrEqual(40);
		expect(sparkles.length).toBeGreaterThanOrEqual(1);
		for (const src of srcsOf(images)) expect(ALL_PARTICLE_SOURCES).toContain(src);
		expect(srcsOf(images)).not.toContain(RIBBON_SRC);
	});
});

describe('huge ribbon', () => {
	test('adds ribbon with localized title and animated net amount inside the safe band', () => {
		doc.documentElement.dataset.locale = 'ja';
		showCelebration('huge', 987654);
		const images = celebrationImages();
		expect(srcsOf(images)).toContain(RIBBON_SRC);
		const title = doc.querySelector<HTMLElement>('[data-celebration-title]');
		const amount = doc.querySelector<HTMLElement>('[data-celebration-amount]');
		expect(title?.textContent).toBe('大勝利');
		expect(amount).not.toBeNull();
		// Both localized lines live inside the ribbon safe band container.
		expect(title?.closest('[data-celebration-ribbon]')).not.toBeNull();
		expect(amount?.closest('[data-celebration-ribbon]')).not.toBeNull();
		drainAnimationFrames();
		expect(amount?.textContent).toBe(formatChips(987654, 'ja'));
	});

	test('count-up finishes at the exact net amount', () => {
		showCelebration('huge', 987654);
		const amount = doc.querySelector<HTMLElement>('[data-celebration-amount]');
		expect(amount?.textContent).not.toBe(formatChips(987654, 'en'));
		drainAnimationFrames();
		expect(amount?.textContent).toBe(formatChips(987654, 'en'));
	});
});

describe('replacement and cleanup', () => {
	test('replaces a running effect: cancels animations, clears timer, removes old nodes', () => {
		showCelebration('big', 100);
		const firstTimerId = [...pendingTimers.values()][0]?.id;
		const burstSize = celebrationImages().length;
		const cancelsBefore = cancelledAnimations.length;

		showCelebration('huge', 200);
		expect(firstTimerId).toBeDefined();
		expect(clearedTimers).toContain(firstTimerId);
		expect(pendingTimers.size).toBe(1);
		expect(cancelledAnimations.length - cancelsBefore).toBe(burstSize);
		expect(srcsOf(celebrationImages())).toContain(RIBBON_SRC);
		expect(celebrationImages().length).toBe(burstSize + 1);
	});

	test('cleans up overlay children and pending frames when the timer fires', () => {
		showCelebration('huge', 500);
		expect(celebrationImages().length).toBeGreaterThan(0);
		fireCleanupTimer();
		expect(overlay()?.children.length).toBe(0);
		expect(pendingTimers.size).toBe(0);
	});
});

describe('cleanup failure safety', () => {
	test('failing frame/overlay cleanup never propagates into the next celebration', () => {
		showCelebration('huge', 500);
		// Both cleanup APIs are made to throw: the replacement celebration's
		// initial teardown (and its timer-fired teardown) must not surface them.
		const harnessCancel = globalThis.cancelAnimationFrame;
		globalThis.cancelAnimationFrame = (() => {
			throw new Error('frame cancel refused');
		}) as unknown as typeof cancelAnimationFrame;
		const host = overlay() as HTMLElement;
		const workingReplace = host.replaceChildren.bind(host);
		host.replaceChildren = () => {
			throw new Error('overlay clear refused');
		};
		try {
			expect(() => showCelebration('big', 100)).not.toThrow();
			// The new effect still rendered on top of the un-clearable old one.
			expect(celebrationImages().length).toBeGreaterThan(0);
			// Scheduled cleanup of the new effect stays non-throwing too.
			expect(() => fireCleanupTimer()).not.toThrow();
		} finally {
			globalThis.cancelAnimationFrame = harnessCancel;
			host.replaceChildren = workingReplace;
		}
		// With real cleanup restored, the next round still ends spotless.
		showCelebration('big', 100);
		fireCleanupTimer();
		expect(overlay()?.children.length).toBe(0);
	});
});

describe('animation failure safety', () => {
	test('a throwing animate() never reaches the game and partial particles are removed', () => {
		const imageProto = happyWindow.HTMLImageElement.prototype as unknown as {
			animate: (
				this: unknown,
				...args: unknown[]
			) => { cancel: () => void; finished?: Promise<unknown> };
		};
		const workingAnimate = imageProto.animate;
		let animateCalls = 0;
		imageProto.animate = function (this: unknown, ...args: unknown[]) {
			animateCalls += 1;
			if (animateCalls > 10) throw new Error('WAAPI unavailable');
			return workingAnimate.apply(this, args);
		};
		try {
			expect(() => showCelebration('big', 100)).not.toThrow();
		} finally {
			imageProto.animate = workingAnimate;
		}
		// The stub genuinely fired past the partial-particle point.
		expect(animateCalls).toBeGreaterThan(10);
		expect(overlay()).not.toBeNull();
		// Partial effect torn down instead of left dangling; no orphan timer.
		expect(overlay()?.children.length).toBe(0);
		expect(pendingTimers.size).toBe(0);
	});
});

describe('reduced motion', () => {
	test('big shows the static localized amount without particles or count-up', () => {
		stubReducedMotion(true);
		showCelebration('big', 1234);
		expect(celebrationImages()).toHaveLength(0);
		expect(overlay()?.textContent).toContain(formatChips(1234, 'en'));
		expect(pendingFrames.size).toBe(0);
		fireCleanupTimer();
		expect(overlay()?.children.length).toBe(0);
	});

	test('huge shows static ribbon, title and amount without particles or count-up', () => {
		stubReducedMotion(true);
		showCelebration('huge', 1234);
		expect(srcsOf(celebrationImages())).toEqual([RIBBON_SRC]);
		expect(doc.querySelector('[data-celebration-title]')?.textContent).toBe('Big Win');
		expect(doc.querySelector('[data-celebration-amount]')?.textContent).toBe(
			formatChips(1234, 'en'),
		);
		expect(pendingFrames.size).toBe(0);
		fireCleanupTimer();
		expect(overlay()?.children.length).toBe(0);
	});
});

describe('celebration audio', () => {
	test('big plays the coin shower', () => {
		const playsBefore = coinAudio()?.playCalls ?? 0;
		showCelebration('big', 100);
		expect(coinAudio()?.src).toBe(COIN_SRC);
		expect(coinAudio()?.playCalls).toBe(playsBefore + 1);
	});

	test('huge plays both shipped clips', () => {
		const coinBefore = coinAudio()?.playCalls ?? 0;
		const stingBefore = stingAudio()?.playCalls ?? 0;
		showCelebration('huge', 100);
		expect(coinAudio()?.playCalls).toBe(coinBefore + 1);
		expect(stingAudio()?.playCalls).toBe(stingBefore + 1);
	});

	test('reuses cached clips: pause, reset currentTime, replay from the start', () => {
		showCelebration('big', 100);
		showCelebration('big', 100);
		// The clip cache lives for the page, so exactly one coin instance exists.
		const coins = audioLog.filter((audio) => audio.src === COIN_SRC);
		expect(coins).toHaveLength(1);
		const coin = coins[0];
		expect(coin?.playCalls).toBeGreaterThanOrEqual(2);
		expect(coin?.pauseCalls).toBeGreaterThanOrEqual(1);
		expect(coin?.currentTime).toBe(0);
		expect(coin?.log.slice(-6)).toEqual([
			'pause',
			'currentTime=0',
			'play',
			'pause',
			'currentTime=0',
			'play',
		]);
	});

	test('rejected, undefined and synchronously failing play() never break the result', () => {
		playImpl = () => Promise.reject(new Error('playback denied'));
		expect(() => showCelebration('big', 100)).not.toThrow();

		playImpl = () => undefined;
		expect(() => showCelebration('big', 100)).not.toThrow();

		playImpl = () => {
			throw new Error('synchronous refusal');
		};
		expect(() => showCelebration('huge', 100)).not.toThrow();
		expect(celebrationImages().length).toBeGreaterThan(0);
	});

	test('gates playback on the shared mute preference at call time', () => {
		const playsBefore = coinAudio()?.playCalls ?? 0;
		setSoundMuted(true);
		showCelebration('big', 100);
		expect(coinAudio()?.playCalls ?? 0).toBe(playsBefore);

		setSoundMuted(false);
		showCelebration('big', 100);
		expect(coinAudio()?.playCalls).toBe(playsBefore + 1);
	});

	test('a muted replacement celebration silences the previous still-running clip', () => {
		showCelebration('big', 100); // unmuted: the coin shower is playing
		const coin = coinAudio();
		const playsBefore = coin?.playCalls ?? 0;
		const pausesBefore = coin?.pauseCalls ?? 0;

		setSoundMuted(true);
		showCelebration('big', 100); // muted replacement
		// No new playback, but the stale clip from the unmuted celebration is
		// stopped and rewound instead of being left to finish in the open.
		expect(coin?.playCalls ?? 0).toBe(playsBefore);
		expect(coin?.pauseCalls).toBeGreaterThan(pausesBefore);
		expect(coin?.currentTime).toBe(0);
	});

	test('reduced motion still plays clips per the mute preference (visuals stay static)', () => {
		stubReducedMotion(true);
		const coinBefore = coinAudio()?.playCalls ?? 0;
		const stingBefore = stingAudio()?.playCalls ?? 0;

		showCelebration('big', 100);
		expect(celebrationImages()).toHaveLength(0);
		expect(coinAudio()?.playCalls).toBe(coinBefore + 1);
		expect(stingAudio()?.playCalls ?? 0).toBe(stingBefore);

		showCelebration('huge', 100);
		expect(srcsOf(celebrationImages())).toEqual([RIBBON_SRC]);
		expect(coinAudio()?.playCalls).toBe(coinBefore + 2);
		expect(stingAudio()?.playCalls).toBe(stingBefore + 1);

		// The mute preference remains the only gate for audio.
		setSoundMuted(true);
		const coinMutedBefore = coinAudio()?.playCalls ?? 0;
		showCelebration('big', 100);
		expect(coinAudio()?.playCalls ?? 0).toBe(coinMutedBefore);
	});
});

describe('entrypoints', () => {
	test('celebrateWin maps net win against stake to big and huge, ignoring sub-threshold results', () => {
		const coinBefore = coinAudio()?.playCalls ?? 0;
		const stingBefore = stingAudio()?.playCalls ?? 0;

		celebrateWin({ win: 100, stake: 25 });
		expect(overlay()).toBeNull();

		celebrateWin({ win: -30, stake: 25 });
		expect(overlay()).toBeNull();

		celebrateWin({ win: 125, stake: 25 });
		expect(overlay()).not.toBeNull();
		expect(celebrationImages().length).toBeGreaterThan(0);
		expect(coinAudio()?.playCalls).toBe(coinBefore + 1);
		expect(stingAudio()?.playCalls ?? 0).toBe(stingBefore);

		celebrateWin({ win: 500, stake: 25 });
		expect(stingAudio()?.playCalls).toBe(stingBefore + 1);
		expect(srcsOf(celebrationImages())).toContain(RIBBON_SRC);
	});

	test('celebrateWin rejects nonfinite or non-positive wins', () => {
		for (const win of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			celebrateWin({ win, stake: 10 });
		}
		expect(overlay()).toBeNull();
	});

	test('showCelebration rejects invalid amounts without touching a running effect', () => {
		showCelebration('big', 100);
		const imagesBefore = celebrationImages().length;
		const timersBefore = pendingTimers.size;
		const coinBefore = coinAudio()?.playCalls ?? 0;

		for (const amount of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
			showCelebration('huge', amount);
		}
		expect(celebrationImages().length).toBe(imagesBefore);
		expect(pendingTimers.size).toBe(timersBefore);
		expect(coinAudio()?.playCalls ?? 0).toBe(coinBefore);
	});
});

// Runs after every cache-counting test above: replacing the document is a
// page replacement, so the module legitimately rebuilds its caches afterwards.
describe('document replacement', () => {
	test('a replaced document gets a fresh overlay and never reuses the stale one', () => {
		showCelebration('big', 100);
		expect(overlay()).not.toBeNull();

		// HMR and test files replace the whole document; the cached overlay must
		// not leak between them (happy-dom suites share the module registry).
		const second = new Window();
		const secondDoc = second.document as unknown as Document;
		const documentOverride = Object.getOwnPropertyDescriptor(globalThis, 'document');
		Object.defineProperty(globalThis, 'document', {
			configurable: true,
			writable: true,
			value: secondDoc,
		});
		try {
			// Replacing the effect cancels the stale burst; happy-dom rejects the
			// cancelled animations' finished promises, so this must stay silent.
			expect(() => showCelebration('big', 100)).not.toThrow();
			expect(secondDoc.querySelector('[data-celebration-overlay]')).not.toBeNull();
			expect(secondDoc.querySelectorAll('[data-celebration-overlay] img').length).toBeGreaterThan(
				0,
			);
			// The stale overlay stays behind in the old document, untouched.
			expect(doc.querySelectorAll('[data-celebration-overlay] img').length).toBe(0);
		} finally {
			if (documentOverride) {
				Object.defineProperty(globalThis, 'document', documentOverride);
			} else {
				Reflect.deleteProperty(globalThis, 'document');
			}
			second.close();
		}
	});
});
