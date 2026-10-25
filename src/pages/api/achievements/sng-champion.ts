import type { APIRoute } from 'astro';
import { createDb } from '../../../lib/db';
import { checkAndGrantAchievements } from '../../../lib/achievements/achievements';

type CheckAchievements = typeof checkAndGrantAchievements;

/**
 * Wallet-free Sit & Go Champion report. The URL is the intent: no request
 * body, identity, or balance is read — both come from authenticated
 * middleware. No wallet, game_stats, or mission writes.
 */
export function createPostHandler({
	check = checkAndGrantAchievements,
}: {
	check?: CheckAchievements;
} = {}): APIRoute {
	return async ({ locals }) => {
		const user = locals.user;
		if (!user?.id) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });

		const d1 = locals.runtime?.env?.DB;
		if (!d1) return Response.json({ error: 'DATABASE_UNAVAILABLE' }, { status: 500 });

		try {
			const newAchievements = await check(createDb(d1), user.id, user.chipBalance, {
				gameType: 'poker',
				feats: ['sng_champion'],
			});
			return Response.json({
				newAchievements: newAchievements.map(({ id, icon }) => ({ id, icon })),
			});
		} catch (error) {
			console.error('[SNG_CHAMPION] Achievement evaluation failed:', error);
			return Response.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
		}
	};
}

export const POST: APIRoute = createPostHandler();
