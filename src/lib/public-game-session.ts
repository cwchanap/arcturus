export const DEFAULT_GUEST_GAME_BALANCE = 1000;

/**
 * Opaque client-side identifier emitted for guest sessions. Authenticated
 * sessions receive a per-user surrogate instead (see {@link hashUserId}).
 */
export const GUEST_CLIENT_USER_ID = 'anonymous';

export type PublicGameUser = {
	id: string;
	chipBalance?: number | null;
};

export type PublicGameSession = {
	isGuest: boolean;
	userId: string;
	/**
	 * Stable, opaque per-user identifier safe to render into the DOM and use
	 * as a localStorage namespace key. Guests resolve to {@link GUEST_CLIENT_USER_ID};
	 * authenticated users get a non-reversible surrogate derived from their id
	 * so the raw account id is never exposed client-side.
	 */
	clientUserId: string;
	initialBalance: number;
	balanceLabel: 'Guest Balance' | 'Your Balance';
	guestModeValue: 'true' | 'false';
	balanceAvailableValue: 'true' | 'false';
};

/**
 * Deterministic non-cryptographic hash (FNV-1a 32-bit) of a user id, returned
 * as a `u_`-prefixed base36 string. The same user always resolves to the same
 * surrogate across sessions and games, distinct users get distinct surrogates,
 * and the raw id is not recoverable from the output. This is sufficient for
 * DOM attribute + localStorage keying — it is NOT a security primitive.
 *
 * Collision expectation: 32-bit output means ~50% collision probability near
 * ~65k distinct user ids (birthday bound). Acceptable while the user base is
 * well below that scale; TODO: revisit if DOM/localStorage key collisions
 * become observable or the user base approaches that scale.
 */
export function hashUserId(userId: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < userId.length; i++) {
		h ^= userId.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return `u_${(h >>> 0).toString(36)}`;
}

function normalizeBalance(balance: number | null | undefined, fallbackBalance: number): number {
	if (typeof balance === 'number' && Number.isFinite(balance)) {
		return Math.max(0, Math.trunc(balance));
	}
	if (!Number.isFinite(fallbackBalance)) {
		return DEFAULT_GUEST_GAME_BALANCE;
	}
	return Math.max(0, Math.trunc(fallbackBalance));
}

export function createPublicGameSession(
	user: PublicGameUser | null | undefined,
	fallbackBalance = DEFAULT_GUEST_GAME_BALANCE,
): PublicGameSession {
	if (!user) {
		return {
			isGuest: true,
			userId: '',
			clientUserId: GUEST_CLIENT_USER_ID,
			initialBalance: normalizeBalance(undefined, fallbackBalance),
			balanceLabel: 'Guest Balance',
			guestModeValue: 'true',
			balanceAvailableValue: 'true',
		};
	}

	const hasAccountBalance =
		typeof user.chipBalance === 'number' && Number.isFinite(user.chipBalance);

	return {
		isGuest: false,
		userId: user.id,
		clientUserId: hashUserId(user.id),
		initialBalance: normalizeBalance(user.chipBalance, fallbackBalance),
		balanceLabel: 'Your Balance',
		guestModeValue: 'false',
		balanceAvailableValue: hasAccountBalance ? 'true' : 'false',
	};
}

export function isGuestModeValue(value: string | null | undefined): boolean {
	return value === 'true';
}

export function shouldSyncAccountChips({ isGuestMode }: { isGuestMode: boolean }): boolean {
	return !isGuestMode;
}

export function getGuestBankrollStorageKey(gameKey: string, userId: string): string {
	return `${gameKey}-bankroll:${userId}`;
}

export function loadGuestBankroll(gameKey: string, userId: string, fallback: number): number {
	if (!userId) return fallback;
	try {
		const raw = localStorage.getItem(getGuestBankrollStorageKey(gameKey, userId));
		if (!raw) return fallback;
		const parsed = Number(raw);
		return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : fallback;
	} catch {
		return fallback;
	}
}

export function persistGuestBankroll(gameKey: string, userId: string, balance: number): void {
	if (!userId) return;
	try {
		localStorage.setItem(
			getGuestBankrollStorageKey(gameKey, userId),
			String(Math.max(0, Math.trunc(balance))),
		);
	} catch {
		// best effort
	}
}
