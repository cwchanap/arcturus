/**
 * Fetch with an abort-based timeout.
 *
 * Wraps `fetch` with an `AbortController` that aborts the request after
 * `timeoutMs` milliseconds. The timer is always cleared once the request
 * settles (resolve or reject), so callers only need to handle the response
 * and any thrown error (an aborted request rejects with an `AbortError`).
 *
 * A caller-provided `init.signal` is chained to the internal controller, so
 * aborting either source aborts the request. If the caller's signal is
 * already aborted, the request aborts immediately.
 *
 * Implementation note: the caller signal is chained via a manual
 * `addEventListener('abort', …)` / `removeEventListener('abort', …)` pair
 * rather than `AbortSignal.any([callerSignal, controller.signal])`. The two
 * are functionally equivalent for our needs, but the manual approach is used
 * deliberately for broader runtime compatibility (`AbortSignal.any` is newer
 * and not universally available across all Workers/browser targets) and so
 * the listener can be removed in a `finally` block to avoid retaining a
 * dangling listener on the caller's signal after the fetch settles. Do not
 * "simplify" this to `AbortSignal.any` without confirming the target runtime
 * supports it and that the caller-signal listener is still cleaned up.
 */
export async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const callerSignal = init.signal;
	const onCallerAbort = () => controller.abort(callerSignal?.reason);
	if (callerSignal) {
		if (callerSignal.aborted) {
			controller.abort(callerSignal.reason);
		} else {
			callerSignal.addEventListener('abort', onCallerAbort, { once: true });
		}
	}
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
		if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
	}
}

/**
 * Fetch a URL and parse its response body as JSON, all under a single
 * abort-controlled timeout.
 *
 * `fetchWithTimeout` clears its abort timer once `fetch()` resolves (i.e. once
 * headers are received). A caller's subsequent `response.json()` reads the
 * body stream AFTER the timer has been cleared, so a server that returns
 * headers but stalls while writing the body can leave the body read pending
 * forever — the caller never reaches its fallback. This helper keeps the
 * abort controller active across both the fetch and the body parse, so a
 * stalled body aborts after `timeoutMs` and the caller can fall through to
 * its recovery/refresh path. Rejects with an `AbortError` on timeout.
 */
export async function fetchJsonWithTimeout<T = unknown>(
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<{ response: Response; data: T }> {
	const controller = new AbortController();
	const callerSignal = init.signal;
	const onCallerAbort = () => controller.abort(callerSignal?.reason);
	if (callerSignal) {
		if (callerSignal.aborted) {
			controller.abort(callerSignal.reason);
		} else {
			callerSignal.addEventListener('abort', onCallerAbort, { once: true });
		}
	}
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		// Read the body while the timer is still armed so a stalled body
		// stream aborts instead of hanging forever.
		const data = (await response.json()) as T;
		return { response, data };
	} finally {
		clearTimeout(timer);
		if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
	}
}
