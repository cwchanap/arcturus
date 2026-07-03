import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import {
	DEFAULT_GUEST_GAME_BALANCE,
	createPublicGameSession,
	getGuestBankrollStorageKey,
	isGuestModeValue,
	loadGuestBankroll,
	persistGuestBankroll,
	shouldSyncAccountChips,
} from './public-game-session';

describe('public-game-session', () => {
	let mockLocalStorage: {
		store: Record<string, string>;
		getItem: ReturnType<typeof mock>;
		setItem: ReturnType<typeof mock>;
		removeItem: ReturnType<typeof mock>;
		clear: () => void;
	};
	let originalLocalStorage: Storage;

	beforeEach(() => {
		originalLocalStorage = global.localStorage;
		mockLocalStorage = {
			store: {},
			getItem: mock((key: string) => mockLocalStorage.store[key] ?? null),
			setItem: mock((key: string, value: string) => {
				mockLocalStorage.store[key] = value;
			}),
			removeItem: mock((key: string) => {
				delete mockLocalStorage.store[key];
			}),
			clear: () => {
				mockLocalStorage.store = {};
			},
		};
		global.localStorage = mockLocalStorage as unknown as Storage;
	});

	afterEach(() => {
		mockLocalStorage.clear();
		global.localStorage = originalLocalStorage;
	});
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

	test('namespaces guest bankroll keys per game and user', () => {
		expect(getGuestBankrollStorageKey('poker', 'anonymous')).toBe('poker-bankroll:anonymous');
		expect(getGuestBankrollStorageKey('blackjack', 'u1')).toBe('blackjack-bankroll:u1');
	});

	test('persistGuestBankroll round-trips through loadGuestBankroll', () => {
		const key = getGuestBankrollStorageKey('poker', 'anon-rt');
		try {
			persistGuestBankroll('poker', 'anon-rt', 1234);
			expect(loadGuestBankroll('poker', 'anon-rt', 1000)).toBe(1234);
		} finally {
			localStorage.removeItem(key);
		}
	});

	test('loadGuestBankroll falls back when no persisted value exists', () => {
		const key = getGuestBankrollStorageKey('poker', 'anon-missing');
		try {
			localStorage.removeItem(key);
			expect(loadGuestBankroll('poker', 'anon-missing', 1000)).toBe(1000);
		} finally {
			localStorage.removeItem(key);
		}
	});

	test('loadGuestBankroll clamps non-negative and truncates decimals', () => {
		const key = getGuestBankrollStorageKey('poker', 'anon-clamp');
		try {
			localStorage.setItem(key, '-50.9');
			expect(loadGuestBankroll('poker', 'anon-clamp', 1000)).toBe(0);
			localStorage.setItem(key, '2500.99');
			expect(loadGuestBankroll('poker', 'anon-clamp', 1000)).toBe(2500);
		} finally {
			localStorage.removeItem(key);
		}
	});

	test('loadGuestBankroll falls back for non-numeric persisted values', () => {
		const key = getGuestBankrollStorageKey('poker', 'anon-bad');
		try {
			localStorage.setItem(key, 'not-a-number');
			expect(loadGuestBankroll('poker', 'anon-bad', 1000)).toBe(1000);
		} finally {
			localStorage.removeItem(key);
		}
	});

	test('guest bankroll helpers ignore empty userId', () => {
		expect(loadGuestBankroll('poker', '', 1000)).toBe(1000);
		persistGuestBankroll('poker', '', 500);
		expect(loadGuestBankroll('poker', '', 1000)).toBe(1000);
	});
});
