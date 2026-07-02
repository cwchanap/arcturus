import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_GUEST_GAME_BALANCE,
	createPublicGameSession,
	isGuestModeValue,
	shouldSyncAccountChips,
} from './public-game-session';

describe('public-game-session', () => {
	test('creates a guest session when no user is present', () => {
		const session = createPublicGameSession(null);

		expect(session).toEqual({
			isGuest: true,
			userId: '',
			initialBalance: DEFAULT_GUEST_GAME_BALANCE,
			balanceLabel: 'Guest Balance',
			guestModeValue: 'true',
			balanceAvailableValue: 'true',
		});
	});

	test('uses the supplied fallback balance for guest sessions', () => {
		const session = createPublicGameSession(undefined, 750);

		expect(session.isGuest).toBe(true);
		expect(session.initialBalance).toBe(750);
	});

	test('uses the default guest balance when guest fallback is NaN', () => {
		const session = createPublicGameSession(undefined, Number.NaN);

		expect(session.isGuest).toBe(true);
		expect(session.initialBalance).toBe(DEFAULT_GUEST_GAME_BALANCE);
		expect(Number.isFinite(session.initialBalance)).toBe(true);
	});

	test('creates an account session from a finite user chip balance', () => {
		const session = createPublicGameSession({ id: 'user-1', chipBalance: 1250 });

		expect(session).toEqual({
			isGuest: false,
			userId: 'user-1',
			initialBalance: 1250,
			balanceLabel: 'Your Balance',
			guestModeValue: 'false',
			balanceAvailableValue: 'true',
		});
	});

	test('falls back to the game default when signed-in chip balance is missing', () => {
		const session = createPublicGameSession({ id: 'user-1', chipBalance: null }, 900);

		expect(session.isGuest).toBe(false);
		expect(session.initialBalance).toBe(900);
		expect(session.balanceAvailableValue).toBe('false');
	});

	test('uses the default guest balance when account fallback is infinite', () => {
		const session = createPublicGameSession({ id: 'user-1', chipBalance: null }, Infinity);

		expect(session.isGuest).toBe(false);
		expect(session.initialBalance).toBe(DEFAULT_GUEST_GAME_BALANCE);
		expect(session.balanceAvailableValue).toBe('false');
		expect(Number.isFinite(session.initialBalance)).toBe(true);
	});

	test('detects guest mode values from DOM dataset strings', () => {
		expect(isGuestModeValue('true')).toBe(true);
		expect(isGuestModeValue('false')).toBe(false);
		expect(isGuestModeValue(undefined)).toBe(false);
	});

	test('only account-backed sessions should sync account chips', () => {
		expect(shouldSyncAccountChips({ isGuestMode: true })).toBe(false);
		expect(shouldSyncAccountChips({ isGuestMode: false })).toBe(true);
	});
});
