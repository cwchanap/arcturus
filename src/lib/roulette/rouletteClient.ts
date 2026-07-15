import { RouletteGame } from './RouletteGame';
import { RouletteUIRenderer } from './RouletteUIRenderer';
import { CHIP_DENOMINATIONS, SPIN_ANIMATION_MS } from './constants';
import type { BetType, SpinResult } from './types';
import { initAchievementToast } from '../achievement-toast';
import {
	isGuestModeValue,
	loadGuestBankroll,
	persistGuestBankroll,
	shouldSyncAccountChips,
	GUEST_CLIENT_USER_ID,
} from '../public-game-session';

// Preserves the HTTP status from a non-ok spin response so the retry
// logic can decide retriability by status code (409, 5xx) rather than
// fragile message-prefix matching.
class SpinHttpError extends Error {
	readonly status: number;
	constructor(status: number, error: string) {
		super(error);
		this.name = 'SpinHttpError';
		this.status = status;
	}
}

// A spin attempt is retriable when the server may have committed the
// round but we didn't receive the result. 409 CONCURRENT_MODIFICATION
// means a concurrent same-syncId request committed — retrying with the
// same syncId returns the stored result via idempotency. 5xx means the
// server errored mid-processing — retrying is safe for the same reason.
// TypeError means the network failed before a response arrived.
function isRetriableSpinError(err: unknown): boolean {
	if (err instanceof TypeError) return true;
	if (err instanceof SpinHttpError) return err.status === 409 || err.status >= 500;
	return false;
}

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

	// Only restore session in guest mode — authenticated users must use
	// the server-provided balance as authoritative.
	if (isGuestMode) {
		restoreSession(game, sessionKey);
		// Sync the UI chip selection to the restored state value.
		const restoredChip = game.getSelectedChipAmount();
		if (CHIP_DENOMINATIONS.includes(restoredChip as (typeof CHIP_DENOMINATIONS)[number])) {
			ui.setSelectedChip(restoredChip);
		}
	}
	ui.update(game.getState());

	function persistSession(): void {
		if (!isGuestMode) return;
		persistGuestBankroll(gameKey, userId, game.getBalance());
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

	// Chip selection — sync both UI and game state
	document.querySelectorAll('.chip-select').forEach((btn) => {
		btn.addEventListener('click', () => {
			const amount = Number((btn as HTMLElement).dataset.amount);
			ui.setSelectedChip(amount);
			game.setSelectedChipAmount(amount);
		});
	});

	// Betting table — click and keyboard activation
	document.querySelectorAll<HTMLElement>('[data-bet-type]').forEach((el) => {
		const placeBetFromCell = () => {
			if (game.getState().phase !== 'betting') return;
			const type = el.dataset.betType as BetType;
			const target = el.dataset.betTarget !== undefined ? Number(el.dataset.betTarget) : undefined;
			const amount = ui.getSelectedChipAmount();
			const result = game.placeBet(type, amount, target);
			if (!result.success) {
				showMessage(result.error ?? 'Cannot place bet');
			}
			updateAndPersist();
		};

		el.addEventListener('click', placeBetFromCell);
		el.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				placeBetFromCell();
			}
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

				const response = await fetchSpin(syncId, bets, totalBet);

				if (!response.ok) {
					const err = (await response.json().catch(() => ({}))) as { error?: string };
					throw new SpinHttpError(response.status, err.error ?? `HTTP ${response.status}`);
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
				// Update UI immediately so the table reflects the 'settled'
				// phase and updated balance during the 4s wheel animation,
				// rather than showing stale 'betting' state that looks
				// actionable.
				ui.update(game.getState());
			}

			// Persist the completed settlement immediately, before the animation
			// timeout, so a tab close during the 4s animation doesn't lose state.
			persistSession();

			ui.animateWheel(spinResult.winningNumber);
			setTimeout(() => {
				ui.showResult(spinResult);
				ui.update(game.getState());
			}, SPIN_ANIMATION_MS);
		} catch (err) {
			console.error('[ROULETTE] Spin failed:', err);
			// If the server may have processed the spin (network error, 409
			// concurrent modification, or 5xx), retry the same syncId once to
			// leverage endpoint idempotency before abandoning the attempt.
			if (
				isRetriableSpinError(err) &&
				shouldSyncAccountChips({ isGuestMode }) &&
				game.getState().phase === 'spinning'
			) {
				try {
					const bets = game.getState().activeBets;
					const totalBet = bets.reduce((s, b) => s + b.amount, 0);
					const retryResponse = await fetchSpin(syncId, bets, totalBet);
					if (retryResponse.ok) {
						const data = (await retryResponse.json()) as {
							winningNumber: number;
							netDelta: number;
							results: SpinResult['results'];
							newBalance: number;
							newAchievements?: Array<{ id: string; name: string; icon: string }>;
						};
						const retryResult: SpinResult = {
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
						game.applySettlement(retryResult);
						if (data.newAchievements?.length) {
							window.dispatchEvent(
								new CustomEvent('achievement-earned', {
									detail: { achievements: data.newAchievements },
								}),
							);
						}
						persistSession();
						ui.animateWheel(retryResult.winningNumber);
						setTimeout(() => {
							ui.showResult(retryResult);
							ui.update(game.getState());
						}, SPIN_ANIMATION_MS);
						return;
					}
				} catch (retryErr) {
					console.error('[ROULETTE] Retry also failed:', retryErr);
				}
			}
			// Re-fetch authoritative server balance before resetting, so we
			// don't abandon a committed spin's balance change.
			let serverBalanceAdopted = false;
			if (shouldSyncAccountChips({ isGuestMode })) {
				try {
					const balResp = await fetch('/api/chips/balance');
					if (balResp.ok) {
						const balData = (await balResp.json()) as { balance?: number };
						if (typeof balData.balance === 'number') {
							game.setBalance(balData.balance);
							serverBalanceAdopted = true;
						}
					}
				} catch {
					// ignore — fall through to reset with whatever balance we have
				}
			}
			// When the authoritative server balance was adopted, discard the
			// active bets WITHOUT refunding — the server balance already
			// reflects the true state, and refunding client-side bets on top
			// of it would create chips from nothing (C1 chip-inflation exploit).
			// When we could NOT reach the server, fall back to newRound() which
			// refunds the bets (server provably didn't settle if unreachable).
			if (serverBalanceAdopted) {
				game.discardActiveBets();
				showMessage('Spin result unclear — balance synced from server.');
			} else {
				game.newRound();
				showMessage('Spin failed. Please try again.');
			}
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

	function showMessage(msg: string): void {
		const el = document.getElementById('game-message');
		if (el) {
			el.textContent = msg;
			setTimeout(() => {
				el.textContent = '';
			}, 3000);
		}
	}
}

async function fetchSpin(
	syncId: string,
	bets: SpinResult['bets'],
	totalBet: number,
): Promise<Response> {
	return fetch('/api/roulette/spin', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ syncId, bets, totalBet }),
	});
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
