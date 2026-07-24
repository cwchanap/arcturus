import { afterEach } from 'bun:test';

// Bun runs the entire suite in one process. Cancel any timer a test leaves
// behind so delayed UI callbacks cannot fire after another suite tears down
// its DOM globals.
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const pendingTimeouts = new Set<ReturnType<typeof setTimeout>>();

globalThis.setTimeout = ((
	callback: (...args: unknown[]) => void,
	delay?: number,
	...args: unknown[]
) => {
	const timeoutId = nativeSetTimeout(() => {
		pendingTimeouts.delete(timeoutId);
		callback(...args);
	}, delay);
	pendingTimeouts.add(timeoutId);
	return timeoutId;
}) as typeof setTimeout;

globalThis.clearTimeout = ((timeoutId?: ReturnType<typeof setTimeout>) => {
	if (timeoutId === undefined) return;
	pendingTimeouts.delete(timeoutId);
	nativeClearTimeout(timeoutId);
}) as typeof clearTimeout;

afterEach(() => {
	for (const timeoutId of pendingTimeouts) {
		nativeClearTimeout(timeoutId);
	}
	pendingTimeouts.clear();
});
