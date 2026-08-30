import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { Window } from 'happy-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getPlayerStatisticsSummary } from '../src/lib/game-stats/player-statistics';
import ProfilePage from '../src/pages/profile.astro';

vi.mock('../src/lib/game-stats/player-statistics', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/lib/game-stats/player-statistics')>();

	return {
		...actual,
		getPlayerStatisticsSummary: vi.fn(async () => {
			throw new Error('database unavailable');
		}),
	};
});

vi.mock('../src/lib/achievements/achievements', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/lib/achievements/achievements')>();

	return {
		...actual,
		getAchievementsWithStatus: vi.fn(async () => []),
	};
});

const now = new Date('2026-07-30T00:00:00.000Z');
const d1Queries: string[] = [];
const dbBinding = {
	prepare(sql: string) {
		d1Queries.push(sql);
		throw new Error(`Unexpected Profile D1 query: ${sql}`);
	},
} as unknown as D1Database;
const user = {
	id: 'profile-statistics-integration-user',
	name: 'Integration Player',
	email: 'integration-player@example.com',
	emailVerified: true,
	image: null,
	chipBalance: 1000,
	createdAt: now,
	updatedAt: now,
};

const runtime = { env: { DB: dbBinding } } as App.Locals['runtime'];
const locals: App.Locals = {
	runtime,
	locale: 'en',
	session: {
		user,
		session: {
			id: 'profile-statistics-integration-session',
			userId: user.id,
			expiresAt: new Date('2026-07-31T00:00:00.000Z'),
			token: 'profile-statistics-integration-token',
			createdAt: now,
			updatedAt: now,
		},
	},
	user,
};

function normalizedText(element: Element | null): string {
	return element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

describe('profile route statistics failure isolation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		d1Queries.length = 0;
	});

	test('renders only the unavailable statistics state while the rest of the profile remains intact', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		try {
			const container = await AstroContainer.create();
			const response = await container.renderToResponse(ProfilePage, {
				locals,
				partial: false,
				request: new Request('http://localhost:2000/profile'),
			});
			const html = await response.text();
			const window = new Window();
			window.document.write(html);

			const statisticsSection = window.document.querySelector(
				'section[aria-labelledby="player-performance-heading"]',
			);

			expect(response.status).toBe(200);
			expect(getPlayerStatisticsSummary).toHaveBeenCalledOnce();
			// AppLayout writes the document-level locale once on the root element.
			expect(window.document.documentElement.getAttribute('lang')).toBe('en');
			expect(window.document.documentElement.getAttribute('data-locale')).toBe('en');
			expect(normalizedText(statisticsSection?.querySelector('[role="status"]'))).toBe(
				'Player statistics are temporarily unavailable.',
			);
			expect(statisticsSection?.querySelector('dl')).toBeNull();
			expect(normalizedText(statisticsSection)).not.toContain('Total Hands');

			const profileText = normalizedText(window.document.querySelector('main'));
			expect(profileText).toContain('Integration Player');
			expect(profileText).toContain('Account Details');
			expect(profileText).toContain('Casino Tips');
			expect(profileText).toContain('AI Rival Settings');
			expect(profileText).toContain('stored in this browser only');
			expect(window.document.querySelector('[data-initial-settings]')).toBeNull();
			expect(d1Queries.some((sql) => /llm_settings/i.test(sql))).toBe(false);
		} finally {
			consoleError.mockRestore();
		}
	});
});
