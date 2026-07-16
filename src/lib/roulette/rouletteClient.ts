import { RouletteGame } from './RouletteGame';
import { RouletteUIRenderer } from './RouletteUIRenderer';
import { CHIP_DENOMINATIONS, SPIN_ANIMATION_MS } from './constants';
import type { BetType, RouletteBet, SpinResult } from './types';
import { initAchievementToast } from '../achievement-toast';
import {
	isGuestModeValue,
	loadGuestBankroll,
	persistGuestBankroll,
	shouldSyncAccountChips,
	GUEST_CLIENT_USER_ID,
} from '../public-game-session';

// Abort the spin request if the server hasn't responded within this window.
// A hung fetch would otherwise leave the UI stuck in the 'spinning' phase
// indefinitely — the retry logic only fires on thrown errors (TypeError /
// SpinHttpError), not on a request that never settles.
const SPIN_FETCH_TIMEOUT_MS = 15000;

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
// AbortError means the fetch timed out (fetchWithTimeout) — the server
// may have processed the spin even though we never got the response.
function isRetriableSpinError(err: unknown): boolean {
	if (err instanceof TypeError) return true;
	if (err instanceof DOMException && err.name === 'AbortError') return true;
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

	// Tracks the pending spin-result timer so it can be cancelled when a
	// new round starts. Without this, a user who clicks New Round during
	// the 4s wheel animation would see the stale result re-rendered after
	// the timer fires, overwriting the new round's state.
	let pendingResultTimer: ReturnType<typeof setTimeout> | null = null;

	// Restore session for both guest and authenticated users. For auth
	// users, the server-provided initialBalance is authoritative — we
	// override the persisted balance after restore so the display always
	// matches the server. The persisted phase/bets/lastSpin let the UI
	// show the last round's result without an automatic server retry.
	// When a spin was in flight at reload time, restoreSession returns
	// recovery info (syncId + bets) so we can re-submit via the server's
	// idempotency replay below.
	const spinRecovery = restoreSession(game, sessionKey, isGuestMode ? undefined : initialBalance);
	// Sync the UI chip selection to the restored state value.
	const restoredChip = game.getSelectedChipAmount();
	if (CHIP_DENOMINATIONS.includes(restoredChip as (typeof CHIP_DENOMINATIONS)[number])) {
		ui.setSelectedChip(restoredChip);
	}
	ui.update(game.getState());

	// If a settled round was restored from session, replay the result
	// display — ui.update() alone does not populate the winning number,
	// net delta, or bet-results sections.
	const restoredState = game.getState();
	if (
		restoredState.phase === 'settled' &&
		restoredState.lastSpin &&
		typeof restoredState.lastSpin.winningNumber === 'number' &&
		Array.isArray(restoredState.lastSpin.results)
	) {
		ui.showResult(restoredState.lastSpin);
	}

	// Re-submit an in-flight spin that was interrupted by a page reload.
	// If the Worker already committed the round, the server's idempotency
	// replay returns the stored result; if the original request was lost,
	// the server processes it fresh. Either way the server's balance is
	// authoritative. Fired asynchronously so the UI can paint the spinning
	// state first, giving the user visual feedback during recovery.
	if (spinRecovery) {
		void recoverPendingSpin(spinRecovery.syncId, spinRecovery.bets);
	}

	function persistSession(): void {
		// Guest bankroll is persisted separately for guest mode. For auth
		// users, the balance is server-authoritative and not persisted here
		// — restoreSession overrides it with the server-provided value.
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

	// Re-submit a spin whose request was interrupted by a page reload.
	// The persisted syncId lets the server deduplicate via idempotency:
	// if the round already committed, the server replays the stored
	// result; if the original request never arrived, it processes the
	// round fresh. The server's newBalance is authoritative either way.
	async function recoverPendingSpin(syncId: string, bets: RouletteBet[]): Promise<void> {
		const totalBet = bets.reduce((s, b) => s + b.amount, 0);
		try {
			const { response, done } = await fetchSpin(syncId, bets, totalBet);
			try {
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
			} finally {
				done();
			}
		} catch {
			// Recovery failed — re-fetch the authoritative balance so we
			// don't abandon a potentially-committed spin's balance change,
			// then discard without refunding (same rationale as the main
			// spin error path).
			let serverBalanceAdopted = false;
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
				// ignore — fall through with whatever balance we have
			}
			game.discardActiveBets();
			showMessage(
				serverBalanceAdopted
					? 'Spin result unclear — balance synced from server.'
					: 'Spin result unclear — please refresh the page.',
			);
			ui.update(game.getState());
			persistSession();
		}
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

		// Tracks whether we ever received a 2xx response from the spin
		// endpoint. If the body fails to parse after a 2xx, the server
		// likely committed the round — we must NOT refund the bets
		// client-side (that would inflate the display balance on top of
		// the server's already-updated balance). See C1 chip-inflation.
		let receivedOkResponse = false;

		try {
			let spinResult: SpinResult;

			if (shouldSyncAccountChips({ isGuestMode })) {
				// Authenticated: server-side settlement
				// beginSpin validates + locks the table (phase -> 'spinning')
				const bets = game.beginSpin();
				// Store the syncId in game state so it survives a page
				// reload during the in-flight request — the persisted
				// snapshot lets restoreSession re-submit via the server's
				// idempotency replay to recover the committed result.
				game.setPendingSyncId(syncId);
				const totalBet = bets.reduce((s, b) => s + b.amount, 0);
				ui.update(game.getState());
				persistSession();

				const { response, done } = await fetchSpin(syncId, bets, totalBet);
				try {
					if (!response.ok) {
						const err = (await response.json().catch(() => ({}))) as { error?: string };
						throw new SpinHttpError(response.status, err.error ?? `HTTP ${response.status}`);
					}

					// Mark that the server accepted the spin — even if the body
					// fails to parse below, the round was likely committed.
					receivedOkResponse = true;

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
				} finally {
					done();
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
			pendingResultTimer = setTimeout(() => {
				pendingResultTimer = null;
				ui.showResult(spinResult);
				ui.update(game.getState());
			}, SPIN_ANIMATION_MS);
		} catch (err) {
			console.error('[ROULETTE] Spin failed:', err);
			// If the server may have processed the spin (network error, 409
			// concurrent modification, 5xx, or a 2xx with an unparseable
			// body), retry the same syncId once to leverage endpoint
			// idempotency before abandoning the attempt.
			if (
				(isRetriableSpinError(err) || receivedOkResponse) &&
				shouldSyncAccountChips({ isGuestMode }) &&
				game.getState().phase === 'spinning'
			) {
				try {
					const bets = game.getState().activeBets;
					const totalBet = bets.reduce((s, b) => s + b.amount, 0);
					const { response: retryResponse, done: retryDone } = await fetchSpin(
						syncId,
						bets,
						totalBet,
					);
					try {
						if (retryResponse.ok) {
							receivedOkResponse = true;
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
							pendingResultTimer = setTimeout(() => {
								pendingResultTimer = null;
								ui.showResult(retryResult);
								ui.update(game.getState());
							}, SPIN_ANIMATION_MS);
							return;
						}
					} finally {
						retryDone();
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
			// We cannot prove the server didn't commit the round: a timeout
			// (AbortError) or network failure (TypeError) may still have reached
			// the Worker, and both the retry and balance refresh failed. Refunding
			// bets via newRound() would inflate the display balance on top of a
			// potentially-committed server settlement. Discard without refund and
			// ask the user to refresh — the server-authoritative balance on reload
			// is always correct.
			game.discardActiveBets();
			showMessage(
				serverBalanceAdopted
					? 'Spin result unclear — balance synced from server.'
					: 'Spin result unclear — please refresh the page.',
			);
			ui.update(game.getState());
			persistSession();
		}
	});

	// New round
	document.getElementById('new-round-button')?.addEventListener('click', () => {
		if (pendingResultTimer !== null) {
			clearTimeout(pendingResultTimer);
			pendingResultTimer = null;
		}
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
		// Return a `done` callback so the caller clears the timer only
		// after the response body has been fully read. If the server sends
		// headers but stalls the body, the abort fires during
		// response.json() and the caller's catch block runs — retry and
		// cleanup proceed instead of hanging the UI in 'spinning'.
		return { response, done: () => clearTimeout(timer) };
	} catch (err) {
		clearTimeout(timer);
		throw err;
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

type SpinRecoveryInfo = { syncId: string; bets: RouletteBet[] };

function restoreSession(
	game: RouletteGame,
	key: string,
	balanceOverride?: number,
): SpinRecoveryInfo | null {
	try {
		const raw = localStorage.getItem(key);
		if (raw) {
			const parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== 'object') return null;
			const phase = parsed.phase;
			if (phase !== 'betting' && phase !== 'spinning' && phase !== 'settled') return null;

			// In-flight spin recovery (auth users only): restore the
			// spinning state — including pendingSyncId and active bets —
			// so the caller can re-submit via the server's idempotency
			// replay. If the Worker committed the round before the reload,
			// the replay returns the stored result; if the original
			// request was lost, the server processes it fresh. Either way
			// the server's newBalance is authoritative.
			if (phase === 'spinning') {
				// Guest mode has no server to recover from — the guest
				// bankroll drives the starting balance.
				if (balanceOverride === undefined) return null;
				// Without a pendingSyncId or bets we can't re-submit —
				// discard and let the server balance drive the start.
				if (
					typeof parsed.pendingSyncId !== 'string' ||
					!parsed.pendingSyncId ||
					!Array.isArray(parsed.activeBets) ||
					parsed.activeBets.length === 0
				) {
					return null;
				}
				if (!game.restoreState(parsed)) return null;
				game.setBalance(balanceOverride);
				return {
					syncId: parsed.pendingSyncId,
					bets: game.getState().activeBets.map((b) => ({ ...b })),
				};
			}

			// For auth users (balanceOverride provided), only restore the
			// 'settled' phase. Restoring 'betting' with active bets would
			// let the user refund bets that were never submitted to the
			// server (the server balance wasn't deducted), inflating chips.
			// 'settled' has no active bets and the balance is overridden
			// with the server value, so it's safe.
			if (balanceOverride !== undefined && phase !== 'settled') return null;
			if (game.restoreState(parsed) && balanceOverride !== undefined) {
				// Auth users: server-provided balance is authoritative.
				game.setBalance(balanceOverride);
			}
			return null;
		}
	} catch {
		// ignore corrupted session
	}
	return null;
}
