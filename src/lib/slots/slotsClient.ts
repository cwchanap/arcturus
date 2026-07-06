import {
	isGuestModeValue,
	loadGuestBankroll,
	persistGuestBankroll,
	shouldSyncAccountChips,
} from '../public-game-session';
import { MAX_BET, MIN_BET } from './constants';
import { GameSettingsManager } from './GameSettingsManager';
import { SlotsGame } from './SlotsGame';
import { SlotsUIRenderer } from './SlotsUIRenderer';
import {
	addPendingStats,
	createPendingStats,
	resolveSlotsSyncState,
	shouldAbandonFollowUpSync,
	getFollowUpBackoffDelayMs,
	MAX_FOLLOW_UP_ATTEMPTS,
} from './balance-sync-state';
import type { SpinResult } from './types';

export function initSlotsClient(): void {
	if (typeof window === 'undefined') return;
	const root = document.getElementById('slots-root');
	if (!root) return;

	const clientUserId = root.dataset.userId ?? 'anonymous';
	const isGuest = isGuestModeValue(root.dataset.guestMode ?? 'false');
	const syncToServer = shouldSyncAccountChips({ isGuestMode: isGuest });

	const settingsMgr = new GameSettingsManager(clientUserId);
	const renderer = new SlotsUIRenderer();

	const fallback = Number(root.dataset.initialBalance) || 0;
	const initialBalance = isGuest ? loadGuestBankroll('slots', clientUserId, fallback) : fallback;

	const game = new SlotsGame(initialBalance, settingsMgr.getSettings(), {
		onBalanceUpdate: (balance) => {
			renderer.renderBalance(balance);
			if (!syncToServer) persistGuestBankroll('slots', clientUserId, balance);
			updateSpinEnabled();
		},
		onRoundComplete: (result) => handleRoundComplete(result),
		onError: (err) => {
			renderer.showStatus(err.message);
			renderer.setSpinEnabled(true);
		},
	});

	let serverSyncedBalance = initialBalance;
	let isSyncInProgress = false;
	let syncPending = false;
	let followUpAttempts = 0;
	let pendingStats = createPendingStats();

	renderer.renderBalance(game.getBalance());
	renderer.renderBet(game.getBet());
	updateSpinEnabled();

	function selectBet(amount: number): void {
		const clamped = Math.max(MIN_BET, Math.min(MAX_BET, Math.floor(amount)));
		try {
			game.setBet(clamped);
			renderer.renderBet(clamped);
			updateSpinEnabled();
		} catch (_e) {
			// ignore invalid selection
		}
	}

	document.querySelectorAll<HTMLButtonElement>('.bet-chip').forEach((chip) => {
		chip.addEventListener('click', () => selectBet(Number(chip.dataset.bet)));
	});

	const spinBtn = document.getElementById('btn-spin') as HTMLButtonElement | null;
	spinBtn?.addEventListener('click', () => doSpin());

	function updateSpinEnabled(): void {
		renderer.setSpinEnabled(game.canSpin());
	}

	function doSpin(): void {
		if (!game.canSpin()) {
			renderer.showStatus('Insufficient chips');
			return;
		}
		const syncId =
			typeof crypto !== 'undefined' && 'randomUUID' in crypto
				? crypto.randomUUID()
				: `slots-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		renderer.setSpinEnabled(false);
		renderer.clearHighlight();
		renderer.showStatus('Spinning…');
		renderer.setSpinning(true);

		const quickSpin = settingsMgr.getSettings().quickSpin;
		const reveal = () => {
			const result = game.spin(syncId);
			renderer.setSpinning(false);
			renderer.renderGrid(result.grid);
			if (result.lineWins.length > 0) renderer.highlightWins(result.lineWins);
			renderer.renderResult(result);
			renderer.showStatus(null);
			renderer.renderRecent(game.getHistory());
			updateSpinEnabled();
		};

		if (quickSpin) {
			reveal();
		} else {
			window.setTimeout(reveal, renderer.getSpinDurationMs(settingsMgr.getSettings()));
		}
	}

	async function handleRoundComplete(result: SpinResult): Promise<void> {
		if (!syncToServer) return;
		const isWin = result.netDelta > 0;
		const isLoss = result.netDelta < 0;
		pendingStats = addPendingStats(pendingStats, isWin ? 1 : 0, isLoss ? 1 : 0, 1, result.netDelta);
		if (isSyncInProgress) {
			syncPending = true;
			return;
		}
		await runSync();
	}

	async function runSync(retryCount = 0): Promise<void> {
		isSyncInProgress = true;
		const gameBalance = game.getBalance();
		const deltaForRequest = gameBalance - serverSyncedBalance;
		if (deltaForRequest === 0 && retryCount === 0) {
			isSyncInProgress = false;
			return;
		}
		const snapshot = { ...pendingStats };
		const outcome: 'win' | 'loss' | 'push' =
			deltaForRequest > 0 ? 'win' : deltaForRequest < 0 ? 'loss' : 'push';

		try {
			const response = await fetch('/api/chips/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					delta: deltaForRequest,
					gameType: 'slots',
					previousBalance: serverSyncedBalance,
					outcome,
					handCount: snapshot.handsIncrement || 1,
					winsIncrement: snapshot.winsIncrement || undefined,
					lossesIncrement: snapshot.lossesIncrement || undefined,
					biggestWinCandidate: snapshot.biggestWinCandidate,
					syncId: `slots-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
				}),
			});
			const data = (await response.json().catch(() => ({}))) as {
				balance?: number;
				previousBalance?: number;
				error?: string;
				newAchievements?: Array<{ name?: string; title?: string }>;
			};

			if (response.ok) {
				if (typeof data.balance === 'number') {
					serverSyncedBalance = data.balance;
					game.setBalance(data.balance);
				}
				pendingStats = createPendingStats();
				if (data.newAchievements?.length) {
					for (const a of data.newAchievements) {
						renderer.showAchievement(a.title ?? a.name ?? 'Achievement unlocked!');
					}
				}
				isSyncInProgress = false;
				if (syncPending) {
					syncPending = false;
					followUpAttempts = 0;
					await runSync();
				}
				return;
			}

			if (response.status === 429) {
				isSyncInProgress = false;
				if (retryCount >= MAX_FOLLOW_UP_ATTEMPTS) return;
				const retryAfter = Number(response.headers.get('Retry-After') ?? '2');
				window.setTimeout(() => runSync(retryCount + 1), Math.min(retryAfter * 1000, 8000));
				return;
			}

			const resolution = resolveSlotsSyncState({
				error: data.error,
				hasServerBalance: typeof data.balance === 'number',
			});
			if (typeof data.balance === 'number') {
				serverSyncedBalance = data.balance;
				game.setBalance(data.balance);
			}
			pendingStats = resolution.clearPendingStats ? createPendingStats() : pendingStats;
			isSyncInProgress = false;
			if (resolution.syncPending && !shouldAbandonFollowUpSync(followUpAttempts)) {
				followUpAttempts++;
				window.setTimeout(() => runSync(0), getFollowUpBackoffDelayMs(followUpAttempts));
			}
		} catch (_e) {
			isSyncInProgress = false;
			game.setBalance(serverSyncedBalance);
			if (!shouldAbandonFollowUpSync(followUpAttempts)) {
				followUpAttempts++;
				window.setTimeout(() => runSync(0), getFollowUpBackoffDelayMs(followUpAttempts));
			}
		}
	}

	// Settings panel wiring
	const settingsPanel = document.getElementById('settings-panel');
	document.getElementById('btn-settings')?.addEventListener('click', () => {
		settingsPanel?.classList.remove('hidden');
		applySettingsToUi();
	});
	document.querySelector('.btn-settings-close')?.addEventListener('click', () => {
		settingsPanel?.classList.add('hidden');
	});
	const speedSelect = document.getElementById('setting-spin-speed') as HTMLSelectElement | null;
	speedSelect?.addEventListener('change', () => {
		settingsMgr.updateSettings({ spinSpeed: speedSelect.value as 'slow' | 'normal' | 'fast' });
	});
	document.getElementById('setting-sound')?.addEventListener('change', (e) => {
		settingsMgr.updateSettings({ soundEnabled: (e.target as HTMLInputElement).checked });
	});
	document.getElementById('setting-quick')?.addEventListener('change', (e) => {
		settingsMgr.updateSettings({ quickSpin: (e.target as HTMLInputElement).checked });
	});
	function applySettingsToUi(): void {
		const s = settingsMgr.getSettings();
		if (speedSelect) speedSelect.value = s.spinSpeed;
		const sound = document.getElementById('setting-sound') as HTMLInputElement | null;
		if (sound) sound.checked = s.soundEnabled;
		const quick = document.getElementById('setting-quick') as HTMLInputElement | null;
		if (quick) quick.checked = s.quickSpin;
	}

	// Paytable panel wiring
	const paytablePanel = document.getElementById('paytable-panel');
	document.getElementById('btn-paytable')?.addEventListener('click', () => {
		paytablePanel?.classList.remove('hidden');
	});
	document.querySelector('.btn-paytable-close')?.addEventListener('click', () => {
		paytablePanel?.classList.add('hidden');
	});

	// Keyboard: Space/Enter to spin
	document.addEventListener('keydown', (e) => {
		if ((e.key === ' ' || e.key === 'Enter') && game.canSpin()) {
			const target = e.target as HTMLElement;
			if (target.tagName === 'INPUT' || target.tagName === 'SELECT') return;
			e.preventDefault();
			doSpin();
		}
	});
}
