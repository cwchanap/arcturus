import { RouletteGame } from './RouletteGame';
import { RouletteUIRenderer } from './RouletteUIRenderer';
import type { BetType, SpinResult } from './types';
import { initAchievementToast } from '../achievement-toast';
import {
	isGuestModeValue,
	loadGuestBankroll,
	persistGuestBankroll,
	shouldSyncAccountChips,
	GUEST_CLIENT_USER_ID,
} from '../public-game-session';

export function initRouletteClient(): void {
	const root = document.getElementById('roulette-root');
	if (!root) throw new Error('roulette-root not found');

	const initialBalance = Number(root.dataset.initialBalance ?? 1000);
	const userId = root.dataset.userId ?? GUEST_CLIENT_USER_ID;
	const isGuestMode = isGuestModeValue(root.dataset.guestMode);
	const gameKey = 'roulette';

	const restoredGuestBalance = isGuestMode
		? loadGuestBankroll(gameKey, userId, initialBalance)
		: initialBalance;

	const game = new RouletteGame({ initialBalance: restoredGuestBalance });
	const ui = new RouletteUIRenderer();
	const sessionKey = `roulette-session:${userId}`;

	restoreSession(game, sessionKey);
	ui.update(game.getState());

	function persistSession(): void {
		if (isGuestMode) {
			persistGuestBankroll(gameKey, userId, game.getBalance());
		}
		try {
			localStorage.setItem(sessionKey, JSON.stringify(game.getState()));
		} catch {
			// ignore
		}
	}

	function updateAndPersist(): void {
		ui.update(game.getState());
		persistSession();
	}

	// Chip selection
	document.querySelectorAll('.chip-select').forEach((btn) => {
		btn.addEventListener('click', () => {
			const amount = Number((btn as HTMLElement).dataset.amount);
			ui.setSelectedChip(amount);
		});
	});

	// Betting table clicks
	document.querySelectorAll<HTMLElement>('[data-bet-type]').forEach((el) => {
		el.addEventListener('click', () => {
			if (game.getState().phase !== 'betting') return;
			const type = el.dataset.betType as BetType;
			const target = el.dataset.betTarget !== undefined ? Number(el.dataset.betTarget) : undefined;
			const amount = ui.getSelectedChipAmount();
			const result = game.placeBet(type, amount, target);
			if (!result.success) {
				showMessage(result.error ?? 'Cannot place bet', 'error');
			}
			updateAndPersist();
		});
	});

	// Remove bet by clicking in sidebar
	document.getElementById('active-bets')?.addEventListener('click', (e) => {
		const target = e.target as HTMLElement;
		const betEntry = target.closest('[id^="active-bet-"]');
		if (!betEntry) return;
		const betId = betEntry.id.replace('active-bet-', '');
		game.removeBet(betId);
		updateAndPersist();
	});

	// Clear bets
	document.getElementById('clear-bets-button')?.addEventListener('click', () => {
		game.clearBets();
		updateAndPersist();
	});

	// Spin
	document.getElementById('spin-button')?.addEventListener('click', async () => {
		if (game.getState().phase !== 'betting') return;
		const syncId =
			typeof crypto !== 'undefined' && crypto.randomUUID
				? crypto.randomUUID()
				: `spin-${Date.now()}-${Math.random().toString(36).slice(2)}`;

		try {
			let spinResult: SpinResult;

			if (shouldSyncAccountChips({ isGuestMode })) {
				// Authenticated: server-side settlement
				// beginSpin validates + locks the table (phase -> 'spinning')
				const bets = game.beginSpin();
				const totalBet = bets.reduce((s, b) => s + b.amount, 0);
				ui.update(game.getState());
				persistSession();

				const response = await fetch('/api/roulette/spin', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ syncId, bets, totalBet }),
				});

				if (!response.ok) {
					const err = (await response.json().catch(() => ({}))) as { error?: string };
					throw new Error(err.error ?? `HTTP ${response.status}`);
				}

				const data = (await response.json()) as {
					winningNumber: number;
					netDelta: number;
					results: SpinResult['results'];
					newBalance: number;
					newAchievements?: Array<{ id: string; name: string; icon: string }>;
				};
				spinResult = {
					winningNumber: data.winningNumber,
					bets,
					totalBet,
					totalPayout: data.netDelta + totalBet,
					netDelta: data.netDelta,
					results: data.results,
					timestamp: Date.now(),
					syncId,
					newBalance: data.newBalance,
				};

				game.setBalance(data.newBalance);
				game.applySettlement(spinResult);

				if (data.newAchievements?.length) {
					window.dispatchEvent(
						new CustomEvent('achievement-earned', {
							detail: { achievements: data.newAchievements },
						}),
					);
				}
			} else {
				// Guest: local settlement (spinGuest handles begin+settle internally)
				const winningNumber = generateLocalWinningNumber();
				spinResult = game.spinGuest(winningNumber);
				spinResult.syncId = syncId;
			}

			ui.animateWheel(spinResult.winningNumber);
			setTimeout(() => {
				ui.showResult(spinResult);
				ui.update(game.getState());
				persistSession();
			}, 4000);
		} catch (err) {
			console.error('[ROULETTE] Spin failed:', err);
			game.clearBets();
			game.newRound();
			showMessage('Spin failed. Please try again.', 'error');
			ui.update(game.getState());
			persistSession();
		}
	});

	// New round
	document.getElementById('new-round-button')?.addEventListener('click', () => {
		game.newRound();
		ui.clearResult();
		updateAndPersist();
	});

	// Achievement toast
	const achievementToast = document.getElementById('achievement-toast');
	const achievementIconEl = document.getElementById('achievement-icon');
	const achievementNameEl = document.getElementById('achievement-name');

	if (achievementToast && achievementIconEl && achievementNameEl) {
		const { enqueue } = initAchievementToast(() => ({
			toast: achievementToast as HTMLElement,
			icon: achievementIconEl as HTMLElement,
			name: achievementNameEl as HTMLElement,
		}));
		window.addEventListener('achievement-earned', (e) => {
			const { achievements } = (e as CustomEvent).detail;
			if (Array.isArray(achievements)) enqueue(achievements);
		});
	}

	function showMessage(msg: string, _type: string): void {
		const el = document.getElementById('game-message');
		if (el) {
			el.textContent = msg;
			setTimeout(() => {
				el.textContent = '';
			}, 3000);
		}
	}
}

function generateLocalWinningNumber(): number {
	const buf = new Uint8Array(1);
	const LIMIT = 222;
	do {
		crypto.getRandomValues(buf);
	} while (buf[0] >= LIMIT);
	return buf[0] % 37;
}

function restoreSession(game: RouletteGame, key: string): void {
	try {
		const raw = localStorage.getItem(key);
		if (raw) {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object' && parsed.phase === 'spinning') {
				return;
			}
			game.restoreState(parsed);
		}
	} catch {
		// ignore corrupted session
	}
}
