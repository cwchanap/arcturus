/**
 * Fetch with an abort-based timeout.
 *
 * Wraps `fetch` with an `AbortController` that aborts the request after
 * `timeoutMs` milliseconds. The timer is always cleared once the request
 * settles (resolve or reject), so callers only need to handle the response
 * and any thrown error (an aborted request rejects with an `AbortError`).
 */
export async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}
