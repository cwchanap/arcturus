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
