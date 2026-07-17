/**
 * Unit tests for fetchWithTimeout.
 */

import { describe, expect, test, spyOn } from 'bun:test';
import { fetchJsonWithTimeout, fetchWithTimeout } from './fetch-with-timeout';

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

	test('registers no abort listener when the caller signal is already aborted', async () => {
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
		const addSpy = spyOn(caller.signal, 'addEventListener');
		caller.abort();

		await expect(
			fetchWithTimeout('https://example.com', { signal: caller.signal }, 5000),
		).rejects.toThrow('aborted');

		// The already-aborted branch must short-circuit listener registration so
		// the caller's signal never has a dangling listener attached. (The
		// finally block still calls removeEventListener unconditionally, but
		// removing a never-added listener is a no-op.)
		expect(addSpy).not.toHaveBeenCalled();
		addSpy.mockRestore();
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

		const caller = new AbortController();
		const addSpy = spyOn(caller.signal, 'addEventListener');
		const removeSpy = spyOn(caller.signal, 'removeEventListener');
		await fetchWithTimeout('https://example.com', { signal: caller.signal }, 5000);

		// The exact function reference registered as the caller-abort chaining
		// listener must be the one removed, so the signal does not retain a
		// dangling listener (and a regression that removes the *wrong*
		// listener cannot slip through).
		const abortAddCalls = addSpy.mock.calls.filter((c) => c[0] === 'abort');
		expect(abortAddCalls).toHaveLength(1);
		const addedListener = abortAddCalls[0][1];
		expect(removeSpy).toHaveBeenCalledWith('abort', addedListener);
		removeSpy.mockRestore();
		addSpy.mockRestore();
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

		const caller = new AbortController();
		const addSpy = spyOn(caller.signal, 'addEventListener');
		const removeSpy = spyOn(caller.signal, 'removeEventListener');
		const promise = fetchWithTimeout('https://example.com', { signal: caller.signal }, 5000);
		caller.abort();

		await expect(promise).rejects.toThrow('aborted');
		// The finally block must clean up the caller-signal listener on the
		// rejection path too — and it must be the *same* function reference
		// that was registered, not just any function.
		const abortAddCalls = addSpy.mock.calls.filter((c) => c[0] === 'abort');
		expect(abortAddCalls).toHaveLength(1);
		const addedListener = abortAddCalls[0][1];
		expect(removeSpy).toHaveBeenCalledWith('abort', addedListener);
		removeSpy.mockRestore();
		addSpy.mockRestore();
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

		const caller = new AbortController();
		const addSpy = spyOn(caller.signal, 'addEventListener');
		const removeSpy = spyOn(caller.signal, 'removeEventListener');
		// Short timeout fires first; fetch rejects via the internal controller,
		// and the finally block must still remove the caller-signal listener.
		await expect(
			fetchWithTimeout('https://example.com', { signal: caller.signal }, 10),
		).rejects.toThrow('aborted');
		const abortAddCalls = addSpy.mock.calls.filter((c) => c[0] === 'abort');
		expect(abortAddCalls).toHaveLength(1);
		const addedListener = abortAddCalls[0][1];
		expect(removeSpy).toHaveBeenCalledWith('abort', addedListener);
		removeSpy.mockRestore();
		addSpy.mockRestore();
		fetchSpy.mockRestore();
	});
});

describe('fetchJsonWithTimeout', () => {
	test('returns the parsed JSON body and response on success', async () => {
		const okResponse = new Response(JSON.stringify({ balance: 1234 }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
		const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(okResponse);

		const { response, data } = await fetchJsonWithTimeout<{ balance: number }>(
			'https://example.com',
			{ method: 'GET' },
			5000,
		);

		expect(response).toBe(okResponse);
		expect(data.balance).toBe(1234);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		fetchSpy.mockRestore();
	});

	test('aborts when the body stream stalls past the timeout', async () => {
		// Regression: fetchWithTimeout clears its timer once fetch() resolves,
		// so a response that returns headers but never produces a body would
		// leave response.json() pending forever. fetchJsonWithTimeout must
		// keep the abort controller armed across the body read so a stalled
		// body aborts and the caller can fall through to its fallback.
		const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
			(_url: string, init?: RequestInit) =>
				new Promise((resolve) => {
					// Resolve immediately with headers, but the body stream
					// never emits chunks and never closes. When the abort
					// fires, error the stream controller so the pending
					// response.json() read rejects (a real fetch ties the body
					// stream to the signal; this mock emulates that).
					const neverClosingBody = new ReadableStream<Uint8Array>({
						start(streamController) {
							init?.signal?.addEventListener('abort', () => {
								streamController.error(new DOMException('aborted', 'AbortError'));
							});
						},
					});
					resolve(new Response(neverClosingBody, { status: 200 }));
				}),
		);

		await expect(
			fetchJsonWithTimeout('https://example.com', { method: 'GET' }, 20),
		).rejects.toThrow();
		fetchSpy.mockRestore();
	});

	test('aborts after the timeout when fetch itself stalls', async () => {
		const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
			(_url: string, init?: RequestInit) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => {
						reject(new DOMException('aborted', 'AbortError'));
					});
				}),
		);

		await expect(fetchJsonWithTimeout('https://example.com', {}, 10)).rejects.toThrow('aborted');
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
			fetchJsonWithTimeout('https://example.com', { signal: caller.signal }, 5000),
		).rejects.toThrow('aborted');
		fetchSpy.mockRestore();
	});

	test('removes the caller-signal abort listener after a successful body read', async () => {
		const okResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
		const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(okResponse);

		const caller = new AbortController();
		const addSpy = spyOn(caller.signal, 'addEventListener');
		const removeSpy = spyOn(caller.signal, 'removeEventListener');
		await fetchJsonWithTimeout('https://example.com', { signal: caller.signal }, 5000);

		const abortAddCalls = addSpy.mock.calls.filter((c) => c[0] === 'abort');
		expect(abortAddCalls).toHaveLength(1);
		const addedListener = abortAddCalls[0][1];
		expect(removeSpy).toHaveBeenCalledWith('abort', addedListener);
		removeSpy.mockRestore();
		addSpy.mockRestore();
		fetchSpy.mockRestore();
	});
});
