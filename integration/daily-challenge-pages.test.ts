import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { Window } from 'happy-dom';
import { describe, expect, test } from 'vitest';
import DailyChallengePage from '../src/pages/games/daily-challenge.astro';
import { hashUserId } from '../src/lib/public-game-session';

// The historical `[periodKey].astro` replay page was removed with the Daily
// migration (HPA-553 Task 7): exact-ranked replay, seven-day history, and the
// commitment/reveal surface are gone. These tests pin the remaining page-level
// contract: the guest caching surrogate and the new unified-run surface.

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
	const runtime = { env: { DB: {} } } as App.Locals['runtime'];
	return {
		runtime,
		locale: 'en',
		session: null,
		user: null,
	};
}

function authedLocals(): App.Locals {
	const runtime = { env: { DB: {} } } as App.Locals['runtime'];
	return {
		runtime,
		locale: 'en',
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
	};
}

describe('daily challenge current page — cache and session behavior', () => {
	test('a guest gets a publicly cacheable shell with Vary: Cookie, Accept-Language and a guest surrogate user id', async () => {
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
		// Automatic browser-language detection (Accept-Language) varies the
		// cached shell so one CDN copy can never leak the wrong locale.
		expect(response.headers.get('vary')).toBe('Cookie, Accept-Language');
		// AppLayout writes the document-level locale once on the root element.
		expect(window.document.documentElement.getAttribute('lang')).toBe('en');
		expect(window.document.documentElement.getAttribute('data-locale')).toBe('en');

		const root = window.document.querySelector('#daily-challenge-root');
		expect(root).not.toBeNull();
		expect(root?.getAttribute('data-user-id')).toBe('guest');
		// The current UTC period key drives the unified daily APIs.
		expect(root?.getAttribute('data-period-key')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(window.document.querySelector('[data-testid="daily-challenge-wager"]')).not.toBeNull();
		expect(
			window.document.querySelector('[data-testid="daily-challenge-leaderboard-rows"]'),
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
		expect(root?.getAttribute('data-user-id')).toBe(hashUserId(user.id));
	});

	test('the migrated surface keeps the mode switch and drops the legacy history/replay UI', async () => {
		const container = await AstroContainer.create();
		const response = await container.renderToResponse(DailyChallengePage, {
			locals: guestLocals(),
			partial: false,
			request: new Request('http://localhost:2000/games/daily-challenge'),
		});
		const html = await response.text();
		const window = new Window();
		window.document.write(html);

		const document = window.document;
		expect(document.querySelector('[data-testid="daily-challenge-mode-practice"]')).not.toBeNull();
		expect(document.querySelector('[data-testid="daily-challenge-mode-ranked"]')).not.toBeNull();
		expect(document.querySelector('[data-testid="daily-challenge-sign-in-cta"]')).not.toBeNull();
		expect(document.querySelector('[data-testid="daily-challenge-start-ranked"]')).not.toBeNull();
		expect(
			document.querySelector('[data-testid="daily-challenge-restart-practice"]'),
		).not.toBeNull();

		// Historical replay, seven-day history, and commitment/reveal copy are gone.
		expect(document.querySelector('[data-testid="daily-challenge-history"]')).toBeNull();
		expect(document.querySelector('[data-testid="daily-challenge-history-rows"]')).toBeNull();
		expect(
			document.querySelector('[data-testid="daily-challenge-replay-scenario-exact-ranked"]'),
		).toBeNull();
		expect(
			document.querySelector('[data-testid="daily-challenge-replay-scenario-practice"]'),
		).toBeNull();
		expect(document.querySelector('[data-testid="daily-challenge-commitment"]')).toBeNull();
		expect(document.querySelector('[data-testid="daily-challenge-reveal-status"]')).toBeNull();
	});
});
