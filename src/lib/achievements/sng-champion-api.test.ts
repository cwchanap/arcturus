import { describe, expect, test } from 'bun:test';
import type { APIRoute } from 'astro';
import { createPostHandler } from '../../pages/api/achievements/sng-champion';
import { ACHIEVEMENTS } from './achievement-rules';
import type { AchievementDefinition, AchievementId } from './types';

function byId(id: AchievementId): AchievementDefinition {
	return ACHIEVEMENTS.find((achievement) => achievement.id === id)!;
}

const CHAMPION = byId('sng_champion');
const BIG_SCORE = byId('big_score');

function context({
	user = { id: 'user-1', chipBalance: 4200 },
	db = {} as D1Database,
}: {
	user?: { id: string; chipBalance: number } | null;
	db?: D1Database | null;
} = {}): Parameters<APIRoute>[0] {
	return {
		locals: {
			user,
			runtime: { env: db ? { DB: db } : {} },
		},
		// Empty body by design: the URL carries the whole intent.
		request: new Request('https://arcturus.example/api/achievements/sng-champion', {
			method: 'POST',
		}),
	} as unknown as Parameters<APIRoute>[0];
}

async function json(response: Response): Promise<unknown> {
	return response.json();
}

describe('POST /api/achievements/sng-champion', () => {
	test('requires an authenticated user', async () => {
		const response = await createPostHandler({ check: async () => [CHAMPION] })(
			context({ user: null }),
		);
		expect(response.status).toBe(401);
		expect(await json(response)).toEqual({ error: 'UNAUTHORIZED' });
	});

	test('rejects requests without a database binding', async () => {
		let called = false;
		const response = await createPostHandler({
			check: async () => {
				called = true;
				return [];
			},
		})(context({ db: null }));

		expect(response.status).toBe(500);
		expect(await json(response)).toEqual({ error: 'DATABASE_UNAVAILABLE' });
		expect(called).toBe(false);
	});

	test('reports the champion feat with the authenticated identity and balance', async () => {
		const calls: Array<{
			db: unknown;
			userId: string;
			chipBalance: number;
			options: unknown;
		}> = [];
		const response = await createPostHandler({
			check: async (db, userId, chipBalance, options) => {
				calls.push({ db, userId, chipBalance, options });
				return [CHAMPION];
			},
		})(context());

		expect(response.status).toBe(200);
		expect(await json(response)).toEqual({
			newAchievements: [{ id: 'sng_champion', icon: CHAMPION.icon }],
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].userId).toBe('user-1');
		// Middleware-enriched balance, never request data (the body is empty).
		expect(calls[0].chipBalance).toBe(4200);
		expect(calls[0].options).toEqual({ gameType: 'poker', feats: ['sng_champion'] });
		expect(calls[0].db).toBeTruthy();
	});

	test('repeat POSTs never duplicate the champion grant', async () => {
		// Mirrors the (userId, achievementId) composite key: the first report
		// grants, later reports find it already earned and grant nothing.
		const earned = new Set<AchievementId>();
		const handler = createPostHandler({
			check: async (_db, _userId, _balance, options) => {
				const fresh = (options?.feats ?? []).filter((id) => !earned.has(id));
				for (const id of fresh) earned.add(id);
				return fresh.map((id) => byId(id));
			},
		});

		const first = await handler(context());
		expect(await json(first)).toEqual({
			newAchievements: [{ id: 'sng_champion', icon: CHAMPION.icon }],
		});

		const second = await handler(context());
		expect(await json(second)).toEqual({ newAchievements: [] });
	});

	test('may return rank and milestone badges alongside the champion', async () => {
		const response = await createPostHandler({ check: async () => [CHAMPION, BIG_SCORE] })(
			context(),
		);
		expect(response.status).toBe(200);
		expect(await json(response)).toEqual({
			newAchievements: [
				{ id: 'sng_champion', icon: CHAMPION.icon },
				{ id: 'big_score', icon: BIG_SCORE.icon },
			],
		});
	});

	test('maps a service failure to INTERNAL_ERROR', async () => {
		const response = await createPostHandler({
			check: async () => {
				throw new Error('d1 unavailable');
			},
		})(context());
		expect(response.status).toBe(500);
		expect(await json(response)).toEqual({ error: 'INTERNAL_ERROR' });
	});
});
