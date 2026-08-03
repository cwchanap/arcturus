import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { Window } from 'happy-dom';
import { describe, expect, test } from 'vitest';
import DailyChallengeHistoryPage from '../src/pages/games/daily-challenge/[periodKey].astro';
import DailyChallengePage from '../src/pages/games/daily-challenge.astro';

const GUEST_CACHE_CONTROL = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';

const now = new Date('2026-07-30T00:00:00.000Z');
const user = {
	id: 'daily-challenge-page-user',
	name: 'Challenge Player',
	email: 'challenge-player@example.com',
	emailVerified: true,
	image: null,
	chipBalance: 1000,
	createdAt: now,
	updatedAt: now,
};

function guestLocals(): App.Locals {
	return {
		runtime: {
			env: { DB: {} },
		},
		session: null,
		user: null,
	} as App.Locals;
}

function authedLocals(): App.Locals {
	return {
		runtime: {
			env: { DB: {} },
		},
		session: {
			user,
			session: {
				id: 'daily-challenge-page-session',
				userId: user.id,
				expiresAt: new Date('2026-07-31T00:00:00.000Z'),
				token: 'daily-challenge-page-token',
				createdAt: now,
				updatedAt: now,
			},
		},
		user,
	} as App.Locals;
}

describe('daily challenge current page — cache and session behavior', () => {
	test('a guest gets a publicly cacheable shell with Vary: Cookie and a guest surrogate user id', async () => {
		const container = await AstroContainer.create();
		const response = await container.renderToResponse(DailyChallengePage, {
			locals: guestLocals(),
			partial: false,
			request: new Request('http://localhost:2000/games/daily-challenge'),
		});
		const html = await response.text();
		const window = new Window();
		window.document.write(html);

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe(GUEST_CACHE_CONTROL);
		expect(response.headers.get('vary')).toBe('Cookie');

		const root = window.document.querySelector('#daily-challenge-root');
		expect(root).not.toBeNull();
		expect(root?.getAttribute('data-user-id')).toBe('guest');
		expect(window.document.querySelector('[data-testid="daily-challenge-wager"]')).not.toBeNull();
		expect(
			window.document.querySelector('[data-testid="daily-challenge-leaderboard-rows"]'),
		).not.toBeNull();
		expect(
			window.document.querySelector('[data-testid="daily-challenge-history-rows"]'),
		).not.toBeNull();
		expect(window.document.querySelector('noscript')).not.toBeNull();
	});

	test('an authenticated visitor gets a private, no-store page with a user id', async () => {
		const container = await AstroContainer.create();
		const response = await container.renderToResponse(DailyChallengePage, {
			locals: authedLocals(),
			partial: false,
			request: new Request('http://localhost:2000/games/daily-challenge'),
		});
		const html = await response.text();
		const window = new Window();
		window.document.write(html);

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(response.headers.get('vary')).toBeNull();

		const root = window.document.querySelector('#daily-challenge-root');
		expect(root?.getAttribute('data-user-id')).toBe(user.id);
	});
});

describe('daily challenge historical page — period validation and cache behavior', () => {
	test('a valid period renders a public shell for guests without ranked write controls', async () => {
		const container = await AstroContainer.create();
		const response = await container.renderToResponse(DailyChallengeHistoryPage, {
			locals: guestLocals(),
			partial: false,
			params: { periodKey: '2026-07-30' },
			request: new Request('http://localhost:2000/games/daily-challenge/2026-07-30'),
		});
		const html = await response.text();
		const window = new Window();
		window.document.write(html);

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe(GUEST_CACHE_CONTROL);
		expect(response.headers.get('vary')).toBe('Cookie');

		const root = window.document.querySelector('#daily-challenge-root');
		expect(root?.getAttribute('data-period-key')).toBe('2026-07-30');
		expect(root?.getAttribute('data-user-id')).toBe('guest');

		const startRanked = window.document.querySelector<HTMLButtonElement>(
			'[data-testid="daily-challenge-start-ranked"]',
		);
		expect(startRanked).not.toBeNull();
		expect(startRanked?.disabled).toBe(true);
		expect(startRanked?.classList.contains('hidden')).toBe(true);
		expect(
			window.document.querySelector('[data-testid="daily-challenge-commitment"]'),
		).not.toBeNull();
		expect(
			window.document.querySelector('[data-testid="daily-challenge-reveal-status"]'),
		).not.toBeNull();
	});

	test('an authenticated visitor gets a private, no-store archive page', async () => {
		const container = await AstroContainer.create();
		const response = await container.renderToResponse(DailyChallengeHistoryPage, {
			locals: authedLocals(),
			partial: false,
			params: { periodKey: '2026-07-29' },
			request: new Request('http://localhost:2000/games/daily-challenge/2026-07-29'),
		});
		const html = await response.text();
		const window = new Window();
		window.document.write(html);

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('private, no-store');

		const root = window.document.querySelector('#daily-challenge-root');
		expect(root?.getAttribute('data-user-id')).toBe(user.id);
	});

	test('a malformed period key returns 404 with no-store', async () => {
		const container = await AstroContainer.create();
		const response = await container.renderToResponse(DailyChallengeHistoryPage, {
			locals: guestLocals(),
			partial: false,
			params: { periodKey: 'not-a-date' },
			request: new Request('http://localhost:2000/games/daily-challenge/not-a-date'),
		});

		expect(response.status).toBe(404);
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	test('an impossible calendar date returns 404', async () => {
		const container = await AstroContainer.create();
		const response = await container.renderToResponse(DailyChallengeHistoryPage, {
			locals: guestLocals(),
			partial: false,
			params: { periodKey: '2026-02-30' },
			request: new Request('http://localhost:2000/games/daily-challenge/2026-02-30'),
		});

		expect(response.status).toBe(404);
	});
});
