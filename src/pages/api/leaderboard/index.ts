/**
 * Leaderboard API Endpoint
 *
 * GET /api/leaderboard
 * Returns top 50 players ranked by chip balance.
 * Includes current user's rank if authenticated.
 */

import type { APIRoute } from 'astro';
import { createDb } from '../../../lib/db';
import {
	getLeaderboardData,
	DEFAULT_LEADERBOARD_LIMIT,
} from '../../../lib/leaderboard/leaderboard';

function jsonResponse(body: Record<string, unknown>, init?: ResponseInit) {
	return new Response(JSON.stringify(body), {
		headers: {
			'content-type': 'application/json',
		},
		...init,
	});
}

export const GET: APIRoute = async ({ locals, url }) => {
	// Authentication check (consistent with other API endpoints)
	const session = locals.session;
	if (!session) {
		return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
	}

	// Database binding check (Cloudflare Workers pattern)
	const dbBinding = locals.runtime?.env?.DB ?? null;
	if (!dbBinding) {
		return jsonResponse({ error: 'Database unavailable' }, { status: 500 });
	}

	const db = createDb(dbBinding);
	const currentUserId = session.user.id;

	// Parse optional limit from query params (default: 50, max: 100)
	const limitParam = url.searchParams.get('limit');
	const limit = Math.min(
		Math.max(
			1,
			parseInt(limitParam ?? String(DEFAULT_LEADERBOARD_LIMIT), 10) || DEFAULT_LEADERBOARD_LIMIT,
		),
		100,
	);

	try {
		const leaderboardData = await getLeaderboardData(db, {
			limit,
			currentUserId,
		});

		return jsonResponse({
			success: true,
			...leaderboardData,
		});
	} catch (error) {
		console.error('Leaderboard API error:', error);
		return jsonResponse(
			{
				success: false,
				error: 'Failed to fetch leaderboard',
			},
			{ status: 500 },
		);
	}
};
