/**
 * Unit tests for fetchWithTimeout.
 */

import { describe, expect, test, spyOn } from 'bun:test';
import { fetchWithTimeout } from './fetch-with-timeout';

describe('fetchWithTimeout', () => {
	test('passes the merged signal to fetch and returns the response on success', async () => {
		const okResponse = new Response('ok', { status: 200 });
		const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(okResponse);

		const res = await fetchWithTimeout('https://example.com', { method: 'GET' }, 5000);

		expect(res).toBe(okResponse);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [, init] = fetchSpy.mock.calls[0];
		expect(init.signal).toBeInstanceOf(AbortSignal);
		fetchSpy.mockRestore();
	});

	test('aborts after the timeout elapses', async () => {
		const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
			(_url: string, init?: RequestInit) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => {
						reject(new DOMException('aborted', 'AbortError'));
					});
				}),
		);

		await expect(fetchWithTimeout('https://example.com', {}, 10)).rejects.toThrow('aborted');
		fetchSpy.mockRestore();
	});

	test('propagates an already-aborted caller signal immediately', async () => {
		const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
			(_url: string, init?: RequestInit) =>
				new Promise((_resolve, reject) => {
					if (init?.signal?.aborted) {
						reject(new DOMException('aborted', 'AbortError'));
						return;
					}
					init?.signal?.addEventListener('abort', () => {
						reject(new DOMException('aborted', 'AbortError'));
					});
				}),
		);

		const caller = new AbortController();
		caller.abort();

		await expect(
			fetchWithTimeout('https://example.com', { signal: caller.signal }, 5000),
		).rejects.toThrow('aborted');
		fetchSpy.mockRestore();
	});

	test('propagates a caller signal aborted mid-flight', async () => {
		const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
			(_url: string, init?: RequestInit) =>
				new Promise((_resolve, reject) => {
					if (init?.signal?.aborted) {
						reject(new DOMException('aborted', 'AbortError'));
						return;
					}
					init?.signal?.addEventListener('abort', () => {
						reject(new DOMException('aborted', 'AbortError'));
					});
				}),
		);

		const caller = new AbortController();
		const promise = fetchWithTimeout('https://example.com', { signal: caller.signal }, 5000);
		caller.abort();

		await expect(promise).rejects.toThrow('aborted');
		fetchSpy.mockRestore();
	});

	test('removes the caller-signal abort listener after a successful fetch', async () => {
		const okResponse = new Response('ok', { status: 200 });
		const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(okResponse);
		const removeSpy = spyOn(AbortSignal.prototype, 'removeEventListener');

		const caller = new AbortController();
		await fetchWithTimeout('https://example.com', { signal: caller.signal }, 5000);

		// The listener registered for caller-abort chaining must be removed on
		// the success path so the signal does not retain a dangling listener.
		expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
		removeSpy.mockRestore();
		fetchSpy.mockRestore();
	});

	test('does not throw when no caller signal is supplied', async () => {
		const okResponse = new Response('ok', { status: 200 });
		const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(okResponse);
		const removeSpy = spyOn(AbortSignal.prototype, 'removeEventListener');

		// No caller signal → the finally block must skip removeEventListener
		// without throwing. removeEventListener should not be called for the
		// (non-existent) caller signal.
		await expect(fetchWithTimeout('https://example.com', {}, 5000)).resolves.toBe(okResponse);
		expect(removeSpy).not.toHaveBeenCalled();
		removeSpy.mockRestore();
		fetchSpy.mockRestore();
	});

	test('removes the caller-signal abort listener after a caller-abort rejection', async () => {
		const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
			(_url: string, init?: RequestInit) =>
				new Promise((_resolve, reject) => {
					if (init?.signal?.aborted) {
						reject(new DOMException('aborted', 'AbortError'));
						return;
					}
					init?.signal?.addEventListener('abort', () => {
						reject(new DOMException('aborted', 'AbortError'));
					});
				}),
		);
		const removeSpy = spyOn(AbortSignal.prototype, 'removeEventListener');

		const caller = new AbortController();
		const promise = fetchWithTimeout('https://example.com', { signal: caller.signal }, 5000);
		caller.abort();

		await expect(promise).rejects.toThrow('aborted');
		// The finally block must clean up the caller-signal listener on the
		// rejection path too, so the signal does not retain a dangling listener.
		expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
		removeSpy.mockRestore();
		fetchSpy.mockRestore();
	});

	test('removes the caller-signal abort listener after a timeout rejection', async () => {
		const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
			(_url: string, init?: RequestInit) =>
				new Promise((_resolve, reject) => {
					if (init?.signal?.aborted) {
						reject(new DOMException('aborted', 'AbortError'));
						return;
					}
					init?.signal?.addEventListener('abort', () => {
						reject(new DOMException('aborted', 'AbortError'));
					});
				}),
		);
		const removeSpy = spyOn(AbortSignal.prototype, 'removeEventListener');

		const caller = new AbortController();
		// Short timeout fires first; fetch rejects via the internal controller,
		// and the finally block must still remove the caller-signal listener.
		await expect(
			fetchWithTimeout('https://example.com', { signal: caller.signal }, 10),
		).rejects.toThrow('aborted');
		expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
		removeSpy.mockRestore();
		fetchSpy.mockRestore();
	});
});
