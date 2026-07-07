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
import { ChipSyncCoordinator } from './chip-sync-coordinator';
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

	let spinInFlight = false;

	const syncCoordinator = syncToServer
		? new ChipSyncCoordinator(
				{
					fetchImpl: (url, init) => fetch(url, init as RequestInit),
					setTimeoutImpl: (fn, ms) => window.setTimeout(fn, ms),
					getGameBalance: () => game.getBalance(),
					setGameBalance: (balance) => game.setBalance(balance),
					onAchievement: (title) => renderer.showAchievement(title),
					onRateLimitGiveUp: () =>
						renderer.showStatus('Chip sync paused (rate limited). Balance will update shortly.'),
					generateSyncRequestId: () =>
						`slots-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
					endpoint: '/api/chips/update',
				},
				initialBalance,
			)
		: null;

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
		if (spinInFlight || !game.canSpin()) {
			renderer.showStatus('Insufficient chips');
			return;
		}
		spinInFlight = true;
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
			try {
				const result = game.spin(syncId);
				renderer.renderGrid(result.grid);
				if (result.lineWins.length > 0) renderer.highlightWins(result.lineWins);
				renderer.renderResult(result);
				renderer.showStatus(null);
				renderer.renderRecent(game.getHistory());
				updateSpinEnabled();
			} finally {
				renderer.setSpinning(false);
				spinInFlight = false;
			}
		};

		if (quickSpin) {
			reveal();
		} else {
			window.setTimeout(reveal, renderer.getSpinDurationMs(settingsMgr.getSettings()));
		}
	}

	async function handleRoundComplete(result: SpinResult): Promise<void> {
		if (!syncCoordinator) return;
		await syncCoordinator.handleRoundComplete(result);
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
			if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'BUTTON')
				return;
			e.preventDefault();
			doSpin();
		}
	});
}
