import type { GameType } from '../game-stats/types';
import { isGuestModeValue, loadGuestBankroll, persistGuestBankroll } from '../public-game-session';
import { createSettlementGate } from './settlement-gate';
import { ensureSettlementRecoveryControls } from './settlement-recovery';
import { newSettlementId } from './settlement-id';
import type { SettleRoundCommand, SettleRoundResult } from './types';

/**
 * Build the wallet settlement command for one completed net round of a public
 * game. The sign of `netDelta` derives the win/loss stats: positive is one
 * win, negative is one loss, zero is a push. Games that need different stats
 * semantics do not use this helper.
 */
export function buildRoundSettlementCommand(
	game: GameType,
	settlementId: string,
	netDelta: number,
): SettleRoundCommand {
	return {
		settlementId,
		game,
		delta: netDelta,
		stats: {
			rounds: 1,
			wins: netDelta > 0 ? 1 : 0,
			losses: netDelta < 0 ? 1 : 0,
			biggestWin: Math.max(netDelta, 0),
		},
	};
}

export type PublicGameSettlementMessages = {
	failed: string;
	retrying: string;
	retryFailed: string;
};

export interface PublicGameSettlementController {
	readonly isGuestMode: boolean;
	readonly clientUserId: string;
	readonly startingBalance: number;
	readonly isBlocked: boolean;
	readonly statusMessage: string | null;
	syncBalance(balance: number): void;
	completeRound(netDelta: number, localBalance: number): Promise<void>;
}

export function createPublicGameSettlementController(options: {
	gameKey: GameType;
	root: HTMLElement;
	recoveryHost: HTMLElement | null;
	resetLabel: string;
	messages: PublicGameSettlementMessages;
	render: () => void;
	onAdoptBalance: (balance: number) => void;
	onResetRound: () => void;
}): PublicGameSettlementController {
	const clientUserId = options.root.dataset.userId ?? 'anonymous';
	const isGuestMode = isGuestModeValue(options.root.dataset.guestMode ?? 'false');
	const parsedInitialBalance = Number(options.root.dataset.initialBalance ?? '1000');
	const initialBalance = Number.isFinite(parsedInitialBalance) ? parsedInitialBalance : 1000;
	const startingBalance = isGuestMode
		? loadGuestBankroll(options.gameKey, clientUserId, initialBalance)
		: initialBalance;

	const gate = createSettlementGate();
	let serverSyncedBalance = startingBalance;
	let statusMessage: string | null = null;

	const recovery = ensureSettlementRecoveryControls({
		attachTo: options.recoveryHost,
		containerId: `${options.gameKey}-settlement-recovery`,
		retryId: `${options.gameKey}-retry-settlement`,
		resetId: `${options.gameKey}-reset-settlement`,
		containerClass: 'hidden mt-4 flex flex-wrap justify-center gap-3',
		retryLabel: 'Retry settlement',
		resetLabel: options.resetLabel,
		retryClass: 'deco-btn px-4 py-2 rounded-lg',
		resetClass: 'deco-btn px-4 py-2 rounded-lg',
	});

	function syncBalance(balance: number): void {
		const formatted = balance.toLocaleString('en-US');
		const primary = document.getElementById('chip-balance');
		if (primary) primary.textContent = formatted;
		document.querySelectorAll<HTMLElement>('[data-chip-balance]').forEach((el) => {
			el.textContent = `${formatted} chips`;
		});
	}

	function adopt(result: SettleRoundResult): void {
		serverSyncedBalance = result.balance;
		options.onAdoptBalance(result.balance);
		statusMessage = null;
		recovery.container?.classList.add('hidden');
		if (result.newAchievements?.length) {
			window.dispatchEvent(
				new CustomEvent('achievement-earned', {
					detail: { achievements: result.newAchievements },
				}),
			);
		}
	}

	recovery.retry?.addEventListener('click', async () => {
		if (!gate.pending) return;
		if (recovery.retry) recovery.retry.disabled = true;
		if (recovery.reset) recovery.reset.disabled = true;
		statusMessage = options.messages.retrying;
		options.render();
		try {
			const result = await gate.retry();
			if (result) adopt(result);
		} catch (error) {
			console.error(`[WALLET_SETTLEMENT] ${options.gameKey} retry failed:`, error);
			statusMessage = options.messages.retryFailed;
			recovery.container?.classList.remove('hidden');
		} finally {
			if (recovery.retry) recovery.retry.disabled = false;
			if (recovery.reset) recovery.reset.disabled = false;
		}
		options.render();
	});

	recovery.reset?.addEventListener('click', () => {
		gate.reset();
		options.onAdoptBalance(serverSyncedBalance);
		options.onResetRound();
		statusMessage = null;
		recovery.container?.classList.add('hidden');
		options.render();
	});

	async function completeRound(netDelta: number, localBalance: number): Promise<void> {
		if (isGuestMode) {
			persistGuestBankroll(options.gameKey, clientUserId, localBalance);
			return;
		}

		let result: SettleRoundResult;
		try {
			const pending = gate.settle(
				buildRoundSettlementCommand(options.gameKey, newSettlementId(options.gameKey), netDelta),
			);
			options.render();
			result = await pending;
		} catch (error) {
			console.error(`[WALLET_SETTLEMENT] ${options.gameKey} settlement failed:`, error);
			statusMessage = options.messages.failed;
			recovery.container?.classList.remove('hidden');
			options.render();
			return;
		}
		adopt(result);
		options.render();
	}

	return {
		get isGuestMode() {
			return isGuestMode;
		},
		get clientUserId() {
			return clientUserId;
		},
		get startingBalance() {
			return startingBalance;
		},
		get isBlocked() {
			return gate.isBlocked;
		},
		get statusMessage() {
			return statusMessage;
		},
		syncBalance,
		completeRound,
	};
}
