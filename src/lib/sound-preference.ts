/**
 * The one owner of the site-wide sound preference (`casino_sound_muted`).
 * Every sound toggle on the page — the shared header control and per-game
 * buttons — binds through `bindSoundToggle()`, so all of them stay in sync
 * and flipping one flips all. Pages without usable localStorage keep the
 * choice in memory for the current page only.
 */

export const SOUND_MUTED_STORAGE_KEY = 'casino_sound_muted';

/** In-memory fallback when localStorage is unavailable (private mode). */
let memoryMuted = false;

/** Sticky: once a write fails (quota, privacy), storage is skipped for reads too. */
let storageUnavailable = false;

type ChangeListener = (muted: boolean) => void;
const changeListeners = new Set<ChangeListener>();

export function isSoundMuted(): boolean {
	try {
		if (storageUnavailable || typeof localStorage === 'undefined') return memoryMuted;
		const raw = localStorage.getItem(SOUND_MUTED_STORAGE_KEY);
		if (raw === null) return memoryMuted;
		// Cache each successful read: if reads later start failing, the last
		// known choice answers instead of the unmuted default permitting audio.
		memoryMuted = raw === 'true';
		return memoryMuted;
	} catch {
		return memoryMuted;
	}
}

export function setSoundMuted(muted: boolean): void {
	memoryMuted = muted;
	try {
		if (!storageUnavailable && typeof localStorage !== 'undefined')
			localStorage.setItem(SOUND_MUTED_STORAGE_KEY, String(muted));
	} catch {
		// Quota/privacy failure: memory wins from here on, so a stale stored
		// value can never outvote the choice the user just made.
		storageUnavailable = true;
	}
	for (const listener of changeListeners) listener(muted);
}

/**
 * Wire a toggle button to the shared preference: one click handler flips the
 * preference, and a same-page change listener keeps this button's
 * `aria-pressed` and accessible on/off label current when any other bound
 * control (or game code) changes it. `onToggle` runs inside the click
 * handler for callers that react to their own toggle (e.g. game audio).
 * The button advertises its localized labels via `data-sound-label-on` /
 * `data-sound-label-off`; without them only `aria-pressed` is managed.
 */
export function bindSoundToggle(
	button: HTMLElement | null,
	onToggle?: (muted: boolean) => void,
): void {
	if (!button) return;
	const render = () => {
		const muted = isSoundMuted();
		button.setAttribute('aria-pressed', String(!muted));
		const label = button.getAttribute(muted ? 'data-sound-label-off' : 'data-sound-label-on');
		if (label !== null) {
			button.setAttribute('aria-label', label);
			button.setAttribute('title', label);
		}
	};
	const listener: ChangeListener = () => render();
	changeListeners.add(listener);
	render();
	button.addEventListener('click', () => {
		setSoundMuted(!isSoundMuted());
		onToggle?.(isSoundMuted());
	});
}
