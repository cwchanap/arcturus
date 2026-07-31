import type { APIRoute } from 'astro';
import { createDb } from '../../../lib/db';
import { getPlayerStatisticsDashboard } from '../../../lib/game-stats/player-statistics';

export interface StatisticsRouteDependencies {
	createDb: typeof createDb;
	getPlayerStatisticsDashboard: typeof getPlayerStatisticsDashboard;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set('content-type', 'application/json');
	headers.set('cache-control', 'private, no-store');
	return new Response(JSON.stringify(body), { ...init, headers });
}

export function createStatisticsGetHandler(
	overrides: Partial<StatisticsRouteDependencies> = {},
): APIRoute {
	const dependencies: StatisticsRouteDependencies = {
		createDb,
		getPlayerStatisticsDashboard,
		...overrides,
	};

	return async ({ locals }) => {
		if (!locals.session) return jsonResponse({ error: 'Unauthorized' }, { status: 401 });

		const binding = locals.runtime?.env?.DB ?? null;
		if (!binding) {
			return jsonResponse({ error: 'Unable to load player statistics' }, { status: 500 });
		}

		try {
			const dashboard = await dependencies.getPlayerStatisticsDashboard(
				dependencies.createDb(binding),
				locals.session.user.id,
			);
			return jsonResponse(dashboard);
		} catch (error) {
			console.error('[PLAYER_STATISTICS] API load failed', error);
			return jsonResponse({ error: 'Unable to load player statistics' }, { status: 500 });
		}
	};
}

export const GET = createStatisticsGetHandler();
