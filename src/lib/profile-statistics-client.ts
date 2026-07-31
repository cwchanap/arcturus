import { parsePlayerStatisticsDashboard } from './profile-statistics-payload';
import { renderPlayerStatisticsDashboard } from './profile-statistics-renderer';

export interface ProfileStatisticsClientOptions {
	fetchImpl?: typeof fetch;
	redirect?: (href: string) => void;
}

/**
 * Upper bound on a statistics request before it is treated as stalled.
 * `AbortSignal.timeout` keeps the signal armed across both the headers fetch
 * and the body read, so a slow/stalled server rejects instead of leaving the
 * loading state up indefinitely and the error path can surface.
 */
const STATISTICS_REQUEST_TIMEOUT_MS = 8_000;

export async function initPlayerStatisticsClient(
	root: HTMLElement,
	options: ProfileStatisticsClientOptions = {},
): Promise<void> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const redirect = options.redirect ?? ((href) => window.location.assign(href));
	const loading = root.querySelector<HTMLElement>('[data-statistics-loading]');
	const error = root.querySelector<HTMLElement>('[data-statistics-error]');
	const content = root.querySelector<HTMLElement>('[data-statistics-content]');
	const retry = root.querySelector<HTMLButtonElement>('[data-statistics-retry]');
	const heading = root.querySelector<HTMLElement>('[data-statistics-heading]');
	if (!loading || !error || !content || !retry || !heading) {
		throw new Error('Player statistics shell is incomplete');
	}

	let isLoading = false;
	const load = async (focusAfterRetry: boolean): Promise<void> => {
		// Serialize requests: ignore re-entries while a load is in flight so the
		// retry control (and any other caller) cannot kick off concurrent fetches.
		if (isLoading) return;
		isLoading = true;
		retry.disabled = true;
		loading.hidden = false;
		error.hidden = true;
		content.hidden = true;
		root.setAttribute('aria-busy', 'true');
		try {
			const response = await fetchImpl('/api/profile/statistics', {
				credentials: 'same-origin',
				cache: 'no-store',
				signal: AbortSignal.timeout(STATISTICS_REQUEST_TIMEOUT_MS),
			});
			if (response.status === 401) {
				redirect('/signin');
				return;
			}
			if (!response.ok) throw new Error('Statistics request failed');
			const dashboard = parsePlayerStatisticsDashboard(await response.json());
			renderPlayerStatisticsDashboard(root, dashboard);
			loading.hidden = true;
			content.hidden = false;
			root.setAttribute('aria-busy', 'false');
			if (focusAfterRetry) heading.focus();
		} catch (loadError) {
			console.error('[PLAYER_STATISTICS] Client load failed', loadError);
			loading.hidden = true;
			error.hidden = false;
			root.setAttribute('aria-busy', 'false');
			if (focusAfterRetry) error.focus();
		} finally {
			// Re-arm on every completion path (success, error, and redirect) so the
			// dashboard stays interactive and later calls are admitted.
			isLoading = false;
			retry.disabled = false;
		}
	};

	retry.addEventListener('click', () => void load(true));
	await load(false);
}
