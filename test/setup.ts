import { afterEach } from 'bun:test';

// Bun runs the entire suite in one process. Cancel any timer a test leaves
// behind so delayed UI callbacks cannot fire after another suite tears down
// its DOM globals.
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;
const pendingTimeouts = new Set<ReturnType<typeof setTimeout>>();
const pendingIntervals = new Set<ReturnType<typeof setInterval>>();

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

globalThis.setInterval = ((
	callback: (...args: unknown[]) => void,
	delay?: number,
	...args: unknown[]
) => {
	const intervalId = nativeSetInterval(callback, delay, ...args);
	pendingIntervals.add(intervalId);
	return intervalId;
}) as typeof setInterval;

globalThis.clearInterval = ((intervalId?: ReturnType<typeof setInterval>) => {
	if (intervalId === undefined) return;
	pendingIntervals.delete(intervalId);
	nativeClearInterval(intervalId);
}) as typeof clearInterval;

afterEach(() => {
	for (const timeoutId of pendingTimeouts) {
		nativeClearTimeout(timeoutId);
	}
	pendingTimeouts.clear();
	for (const intervalId of pendingIntervals) {
		nativeClearInterval(intervalId);
	}
	pendingIntervals.clear();
});
