import { parsePlayerStatisticsDashboard } from './profile-statistics-payload';
import { renderPlayerStatisticsDashboard } from './profile-statistics-renderer';

export interface ProfileStatisticsClientOptions {
	fetchImpl?: typeof fetch;
	redirect?: (href: string) => void;
}

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

	const load = async (focusAfterRetry: boolean): Promise<void> => {
		loading.hidden = false;
		error.hidden = true;
		content.hidden = true;
		root.setAttribute('aria-busy', 'true');
		try {
			const response = await fetchImpl('/api/profile/statistics', {
				credentials: 'same-origin',
				cache: 'no-store',
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
		}
	};

	retry.addEventListener('click', () => void load(true));
	await load(false);
}
