import { RouletteGame } from './RouletteGame';
import { RouletteUIRenderer } from './RouletteUIRenderer';
import { CHIP_DENOMINATIONS, SPIN_ANIMATION_MS } from './constants';
import type { BetType, RouletteBet, RouletteGameState, SpinResult } from './types';
import type { AchievementId } from '../achievements/types';
import { initAchievementToast } from '../achievement-toast';
import {
	GUEST_CLIENT_USER_ID,
	isGuestModeValue,
	loadGuestBankroll,
	persistGuestBankroll,
	shouldSyncAccountChips,
} from '../public-game-session';
import {
	isNonCommittedSpinRejection,
	messageForSpinRejection,
	SpinHttpError,
} from './spin-error-classification';

const SPIN_FETCH_TIMEOUT_MS = 15_000;
const BALANCE_FETCH_TIMEOUT_MS = 15_000;

type SpinResponse = {
	duplicate?: boolean;
	newBalance: number;
	winningNumber?: number;
	netDelta?: number;
	results?: SpinResult['results'];
	newAchievements?: Array<{ id: AchievementId; icon: string }>;
};

/** Wire the authoritative Roulette route to the browser UI. */
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
	let pendingResultTimer: ReturnType<typeof setTimeout> | null = null;

	const betsDroppedOnRefresh = restoreSavedSession(
		game,
		sessionKey,
		isGuestMode ? undefined : initialBalance,
	);

	const restoredChip = game.getSelectedChipAmount();
	if (CHIP_DENOMINATIONS.includes(restoredChip as (typeof CHIP_DENOMINATIONS)[number])) {
		ui.setSelectedChip(restoredChip);
	}
	ui.update(game.getState());

	const restoredState = game.getState();
	if (
		restoredState.phase === 'settled' &&
		restoredState.lastSpin &&
		typeof restoredState.lastSpin.winningNumber === 'number' &&
		Array.isArray(restoredState.lastSpin.results)
	) {
		ui.showResult(restoredState.lastSpin);
	}

	function persistSession(): void {
		if (isGuestMode) persistGuestBankroll(gameKey, userId, game.getBalance());
		try {
			localStorage.setItem(sessionKey, JSON.stringify(game.getState()));
		} catch {
			// Storage is optional; the game remains usable when it is unavailable.
		}
	}

	function updateAndPersist(): void {
		ui.update(game.getState());
		persistSession();
	}

	let messageTimer: ReturnType<typeof setTimeout> | null = null;

	function showMessage(message: string): void {
		const el = document.getElementById('game-message');
		if (!el) return;
		el.textContent = message;
		if (messageTimer !== null) clearTimeout(messageTimer);
		messageTimer = setTimeout(() => {
			messageTimer = null;
			el.textContent = '';
		}, 3_000);
	}

	function showSpinResult(
		data: SpinResponse,
		syncId: string,
		bets: RouletteBet[],
		totalBet: number,
	): void {
		if (
			typeof data.winningNumber !== 'number' ||
			typeof data.netDelta !== 'number' ||
			!Number.isFinite(data.newBalance) ||
			!Array.isArray(data.results)
		) {
			throw new Error('INVALID_SPIN_RESPONSE');
		}
		const spinResult: SpinResult = {
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
		ui.update(game.getState());
		if (data.newAchievements?.length) {
			window.dispatchEvent(
				new CustomEvent('achievement-earned', {
					detail: { achievements: data.newAchievements },
				}),
			);
		}
		persistSession();
		ui.animateWheel(spinResult.winningNumber);
		pendingResultTimer = setTimeout(() => {
			pendingResultTimer = null;
			ui.showResult(spinResult);
			ui.update(game.getState());
		}, SPIN_ANIMATION_MS);
	}

	function adoptDuplicateBalance(data: SpinResponse): void {
		if (!Number.isFinite(data.newBalance)) throw new Error('INVALID_SPIN_RESPONSE');
		game.setBalance(data.newBalance);
		game.discardActiveBets();
		ui.clearResult();
		ui.update(game.getState());
		persistSession();
		showMessage('Spin already settled — balance synced.');
	}

	async function handleUncertainSpin(): Promise<void> {
		const serverBalance = await fetchBalance();
		if (serverBalance !== null) game.setBalance(serverBalance);
		// No winning number can be reconstructed from a lost response. Clear the
		// unresolved wager and return to betting even when balance refresh fails;
		// the next page load remains authoritative.
		game.discardActiveBets();
		ui.clearResult();
		ui.update(game.getState());
		persistSession();
		showMessage(
			serverBalance === null
				? 'Spin result unavailable — refresh to verify your balance.'
				: 'Spin result unavailable — balance synced.',
		);
	}

	async function handleRejectedSpin(error: SpinHttpError): Promise<void> {
		if (error.message === 'INSUFFICIENT_BALANCE') {
			const serverBalance = await fetchBalance();
			if (serverBalance !== null) game.setBalance(serverBalance);
			game.discardActiveBets();
		} else {
			game.abortSpin();
		}
		ui.update(game.getState());
		persistSession();
		showMessage(messageForSpinRejection(error));
	}

	// Chip selection — sync UI and game state, then persist the preference.
	document.querySelectorAll('.chip-select').forEach((btn) => {
		btn.addEventListener('click', () => {
			const amount = Number((btn as HTMLElement).dataset.amount);
			ui.setSelectedChip(amount);
			game.setSelectedChipAmount(amount);
			persistSession();
		});
	});

	// Betting table — click and keyboard activation.
	document.querySelectorAll<HTMLElement>('[data-bet-type]').forEach((el) => {
		const placeBetFromCell = () => {
			if (game.getState().phase !== 'betting') return;
			const type = el.dataset.betType as BetType;
			const target = el.dataset.betTarget !== undefined ? Number(el.dataset.betTarget) : undefined;
			const result = game.placeBet(type, ui.getSelectedChipAmount(), target);
			if (!result.success) showMessage(result.error ?? 'Cannot place bet');
			updateAndPersist();
		};
		el.addEventListener('click', placeBetFromCell);
		el.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				placeBetFromCell();
			}
		});
	});

	document.getElementById('active-bets')?.addEventListener('click', (event) => {
		const target = event.target as HTMLElement;
		const betEntry = target.closest('[id^="active-bet-"]');
		if (!betEntry) return;
		game.removeBet(betEntry.id.replace('active-bet-', ''));
		updateAndPersist();
	});

	document.getElementById('clear-bets-button')?.addEventListener('click', () => {
		game.clearBets();
		updateAndPersist();
	});

	document.getElementById('spin-button')?.addEventListener('click', async () => {
		if (game.getState().phase !== 'betting') return;
		const syncId =
			typeof crypto !== 'undefined' && crypto.randomUUID
				? crypto.randomUUID()
				: `spin-${Date.now()}-${Math.random().toString(36).slice(2)}`;

		try {
			let spinResult: SpinResult;
			if (shouldSyncAccountChips({ isGuestMode })) {
				const bets = game.beginSpin();
				const totalBet = bets.reduce((sum, bet) => sum + bet.amount, 0);
				ui.update(game.getState());
				const { response, done } = await fetchSpin(syncId, bets, totalBet);
				try {
					const data = (await response.json()) as SpinResponse;
					if (!response.ok) {
						throw new SpinHttpError(
							response.status,
							typeof (data as { error?: unknown }).error === 'string'
								? (data as { error: string }).error
								: `HTTP ${response.status}`,
						);
					}
					if (data.duplicate) {
						adoptDuplicateBalance(data);
						return;
					}
					showSpinResult(data, syncId, bets, totalBet);
				} finally {
					done();
				}
			} else {
				const winningNumber = generateLocalWinningNumber();
				spinResult = game.spinGuest(winningNumber);
				spinResult.syncId = syncId;
				ui.update(game.getState());
				persistSession();
				ui.animateWheel(spinResult.winningNumber);
				pendingResultTimer = setTimeout(() => {
					pendingResultTimer = null;
					ui.showResult(spinResult);
					ui.update(game.getState());
				}, SPIN_ANIMATION_MS);
			}
		} catch (error) {
			console.error('[ROULETTE] Spin failed:', error);
			if (error instanceof SpinHttpError && isNonCommittedSpinRejection(error)) {
				await handleRejectedSpin(error);
			} else if (shouldSyncAccountChips({ isGuestMode }) && game.getState().phase === 'spinning') {
				await handleUncertainSpin();
			} else if (game.getState().phase === 'spinning') {
				game.abortSpin();
				ui.update(game.getState());
			}
		}
	});

	document.getElementById('new-round-button')?.addEventListener('click', () => {
		if (pendingResultTimer !== null) {
			clearTimeout(pendingResultTimer);
			pendingResultTimer = null;
		}
		game.newRound();
		ui.clearResult();
		updateAndPersist();
	});

	const rulesToggle = document.getElementById('rules-toggle');
	const rulesPanel = document.getElementById('rules-panel');
	const rulesToggleIcon = document.getElementById('rules-toggle-icon');
	rulesToggle?.addEventListener('click', () => {
		if (!rulesPanel) return;
		const expanded = rulesToggle.getAttribute('aria-expanded') === 'true';
		rulesToggle.setAttribute('aria-expanded', String(!expanded));
		rulesPanel.hidden = expanded;
		if (rulesToggleIcon) rulesToggleIcon.textContent = expanded ? '▸' : '▾';
	});

	const achievementToast = document.getElementById('achievement-toast');
	const achievementIconEl = document.getElementById('achievement-icon');
	const achievementNameEl = document.getElementById('achievement-name');
	if (achievementToast && achievementIconEl && achievementNameEl) {
		const { enqueue } = initAchievementToast(() => ({
			toast: achievementToast as HTMLElement,
			icon: achievementIconEl as HTMLElement,
			name: achievementNameEl as HTMLElement,
		}));
		window.addEventListener('achievement-earned', (event) => {
			const { achievements } = (event as CustomEvent).detail;
			if (Array.isArray(achievements)) enqueue(achievements);
		});
	}

	if (betsDroppedOnRefresh) showMessage('Bets cleared on refresh — please re-place your bets.');
}

async function fetchSpin(
	syncId: string,
	bets: SpinResult['bets'],
	totalBet: number,
): Promise<{ response: Response; done: () => void }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SPIN_FETCH_TIMEOUT_MS);
	try {
		const response = await fetch('/api/roulette/spin', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ syncId, bets, totalBet }),
			signal: controller.signal,
		});
		return { response, done: () => clearTimeout(timer) };
	} catch (error) {
		clearTimeout(timer);
		throw error;
	}
}

async function fetchBalance(): Promise<number | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), BALANCE_FETCH_TIMEOUT_MS);
	try {
		const response = await fetch('/api/chips/balance', { signal: controller.signal });
		if (!response.ok) return null;
		const data = (await response.json()) as { balance?: unknown };
		return typeof data.balance === 'number' && Number.isFinite(data.balance) ? data.balance : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
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

/** Restore only safe local state; an in-flight spin is intentionally dropped. */
function restoreSavedSession(game: RouletteGame, key: string, balanceOverride?: number): boolean {
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return false;
		const parsed = JSON.parse(raw) as Partial<RouletteGameState>;
		if (!parsed || typeof parsed !== 'object') return false;
		if (parsed.phase === 'spinning') {
			localStorage.removeItem(key);
			return balanceOverride !== undefined;
		}
		if (balanceOverride !== undefined) {
			if (
				parsed.phase !== 'settled' ||
				!Array.isArray(parsed.activeBets) ||
				parsed.activeBets.length > 0
			) {
				const hadBets = parsed.phase === 'betting' && parsed.activeBets?.length;
				localStorage.removeItem(key);
				return Boolean(hadBets);
			}
		}
		if (!game.restoreState(parsed)) return false;
		if (balanceOverride !== undefined) game.setBalance(balanceOverride);
		return false;
	} catch {
		return false;
	}
}
