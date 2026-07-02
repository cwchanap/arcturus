export const DEFAULT_GUEST_GAME_BALANCE = 1000;

export type PublicGameUser = {
	id: string;
	chipBalance?: number | null;
};

export type PublicGameSession = {
	isGuest: boolean;
	userId: string;
	initialBalance: number;
	balanceLabel: 'Guest Balance' | 'Your Balance';
	guestModeValue: 'true' | 'false';
	balanceAvailableValue: 'true' | 'false';
};

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
