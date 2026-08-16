// src/lib/sic-bo/client.init.test.ts
//
// Covers Sic-Bo-specific wiring only: guest bankroll persistence without
// wallet settlement, bet slip clearing, Roll disabled state, the
// complete-phase New Round action, and the authenticated settlement window
// (completeRound after roll; New Round stays disabled while settlement is
// blocked). The wallet controller's own success/retry/reset matrix is covered
// by src/lib/wallet/public-game-settlement.test.ts.

import { Window } from 'happy-dom';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { SIC_BO_CHIP_DENOMINATIONS, TOTAL_ODDS } from './rules';
import { initSicBoClient } from './client';

// ---------------------------------------------------------------------------
// happy-dom globals (same pattern as video-poker/client.init.test.ts)
// ---------------------------------------------------------------------------
const origWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const origDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const origFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const origLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const origCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
const happyWindow = new Window();

beforeAll(() => {
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		writable: true,
		value: happyWindow,
	});
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		writable: true,
		value: happyWindow.document,
	});
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		writable: true,
		value: happyWindow.localStorage,
	});
	// Override CustomEvent so window.dispatchEvent recognises the events.
	Object.defineProperty(globalThis, 'CustomEvent', {
		configurable: true,
		writable: true,
		value: happyWindow.CustomEvent,
	});
});

afterAll(() => {
	happyWindow.close();
	restore(origWindow, 'window');
	restore(origDocument, 'document');
	restore(origFetch, 'fetch');
	restore(origLocalStorage, 'localStorage');
	restore(origCustomEvent, 'CustomEvent');
});

function restore(desc: PropertyDescriptor | undefined, key: string): void {
	if (desc) Object.defineProperty(globalThis, key, desc);
	else Reflect.deleteProperty(globalThis, key);
}

// ---------------------------------------------------------------------------
// DOM fixture matching sic-bo.astro's element contract
// ---------------------------------------------------------------------------
const BET_KEYS = [
	'big',
	'small',
	'odd',
	'even',
	'any-triple',
	...Object.keys(TOTAL_ODDS).map((total) => `total:${total}`),
] as const;

const USER_ID = 'sb-guest-1';

function makeSicBoRoot(opts: { guestMode?: boolean; initialBalance?: number } = {}): HTMLElement {
	const root = document.createElement('main');
	root.id = 'sic-bo-root';
	root.setAttribute('data-testid', 'sic-bo-root');
	root.setAttribute('data-user-id', USER_ID);
	root.setAttribute('data-guest-mode', opts.guestMode === false ? 'false' : 'true');
	root.setAttribute('data-initial-balance', String(opts.initialBalance ?? 1000));

	const balance = document.createElement('div');
	balance.id = 'chip-balance';
	balance.textContent = String(opts.initialBalance ?? 1000);
	root.appendChild(balance);

	// Mirror element that CasinoLayout renders alongside the canonical balance
	// in the shared header for authenticated users.
	const chipBalanceMirror = document.createElement('span');
	chipBalanceMirror.setAttribute('data-chip-balance', '');
	chipBalanceMirror.textContent = `${opts.initialBalance ?? 1000} chips`;
	root.appendChild(chipBalanceMirror);

	const status = document.createElement('div');
	status.id = 'sic-bo-status';
	root.appendChild(status);

	const result = document.createElement('div');
	result.id = 'sic-bo-result';
	root.appendChild(result);

	const totalStake = document.createElement('div');
	totalStake.id = 'sic-bo-total-stake';
	root.appendChild(totalStake);

	for (let i = 0; i < 3; i++) {
		const die = document.createElement('div');
		die.id = `sic-bo-die-${i}`;
		die.setAttribute('data-value', '0');
		root.appendChild(die);
	}

	for (const amount of SIC_BO_CHIP_DENOMINATIONS) {
		const denom = document.createElement('button');
		denom.type = 'button';
		denom.setAttribute('data-denomination', String(amount));
		denom.textContent = `$${amount}`;
		root.appendChild(denom);
	}

	for (const key of BET_KEYS) {
		const bet = document.createElement('button');
		bet.type = 'button';
		bet.setAttribute('data-bet-key', key);
		const amount = document.createElement('span');
		amount.setAttribute('data-bet-amount', '');
		bet.appendChild(amount);
		root.appendChild(bet);
	}

	const clearBets = document.createElement('button');
	clearBets.id = 'sic-bo-clear-bets';
	clearBets.type = 'button';
	clearBets.textContent = 'Clear bets';
	root.appendChild(clearBets);

	const action = document.createElement('button');
	action.id = 'sic-bo-action';
	action.type = 'button';
	action.textContent = 'Roll';
	action.disabled = true;
	root.appendChild(action);

	const recoveryHost = document.createElement('div');
	recoveryHost.id = 'sic-bo-recovery-host';
	root.appendChild(recoveryHost);

	document.body.appendChild(root);
	return root;
}

function denomButton(amount: number): HTMLButtonElement {
	return document.querySelector<HTMLButtonElement>(`[data-denomination="${amount}"]`)!;
}

function betButton(key: string): HTMLButtonElement {
	return document.querySelector<HTMLButtonElement>(`[data-bet-key="${key}"]`)!;
}

function betAmount(key: string): HTMLElement {
	return betButton(key).querySelector<HTMLElement>('[data-bet-amount]')!;
}

function actionButton(): HTMLButtonElement {
	return document.getElementById('sic-bo-action') as HTMLButtonElement;
}

function balanceEl(): HTMLElement {
	return document.getElementById('chip-balance') as HTMLElement;
}

function totalStakeEl(): HTMLElement {
	return document.getElementById('sic-bo-total-stake') as HTMLElement;
}

function statusEl(): HTMLElement {
	return document.getElementById('sic-bo-status') as HTMLElement;
}

function installFetchSpy(): { calls: string[] } {
	const calls: string[] = [];
	Object.defineProperty(globalThis, 'fetch', {
		configurable: true,
		writable: true,
		value: async () => {
			calls.push('fetch called');
			return { ok: true, status: 200, json: async () => ({ balance: 0, duplicate: false }) };
		},
	});
	return { calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('initSicBoClient — guest bet slip wiring', () => {
	beforeEach(() => {
		restore(origFetch, 'fetch');
	});

	test('same-denomination re-click clears one bet and Clear bets clears the whole slip', () => {
		localStorage.clear();
		const root = makeSicBoRoot();
		try {
			initSicBoClient();

			denomButton(5).click();
			betButton('big').click();
			expect(betAmount('big').textContent).toBe('5');
			expect(totalStakeEl().textContent).toBe('Total stake: 5');

			// Re-clicking the same denomination clears that position only.
			betButton('big').click();
			expect(betAmount('big').textContent).toBe('');
			expect(totalStakeEl().textContent).toBe('Total stake: 0');

			// A different denomination replaces the position amount.
			betButton('big').click();
			denomButton(10).click();
			betButton('big').click();
			expect(betAmount('big').textContent).toBe('10');

			// Clear bets removes the whole slip.
			betButton('small').click();
			betButton('any-triple').click();
			expect(betAmount('small').textContent).toBe('10');
			expect(betAmount('any-triple').textContent).toBe('10');
			betButton('total:4').click();
			expect(betAmount('total:4').textContent).toBe('10');

			betButton('small').click(); // clear small (same denomination re-click)
			expect(betAmount('small').textContent).toBe('');

			betButton('big').click(); // re-add big so the slip is non-empty
			document.getElementById('sic-bo-clear-bets')!.click();
			expect(betAmount('big').textContent).toBe('');
			expect(betAmount('any-triple').textContent).toBe('');
			expect(betAmount('total:4').textContent).toBe('');
			expect(totalStakeEl().textContent).toBe('Total stake: 0');
		} finally {
			root.remove();
		}
	});

	test('Roll is disabled while the betting slip is invalid or empty', () => {
		localStorage.clear();
		const root = makeSicBoRoot();
		try {
			initSicBoClient();

			// Empty slip: Roll disabled.
			expect(actionButton().textContent).toBe('Roll');
			expect(actionButton().disabled).toBe(true);
			expect(document.getElementById('sic-bo-status')!.textContent).toContain('bet');

			// One valid bet: Roll enabled.
			denomButton(10).click();
			betButton('big').click();
			expect(actionButton().disabled).toBe(false);

			// Clearing the slip disables Roll again.
			betButton('big').click();
			expect(actionButton().disabled).toBe(true);
		} finally {
			root.remove();
		}
	});
});

describe('initSicBoClient — authenticated settlement window', () => {
	test('roll completes the round through the settlement controller; New Round stays disabled while blocked, then unlocks after balance adoption', async () => {
		localStorage.clear();
		const calls: string[] = [];
		let resolveFetch: (value: unknown) => void = () => {};
		Object.defineProperty(globalThis, 'fetch', {
			configurable: true,
			writable: true,
			value: () => {
				calls.push('fetch called');
				return new Promise((resolve) => {
					resolveFetch = resolve;
				});
			},
		});
		const origRandom = Math.random;
		// Constant 0 → dice [1,1,1] → any-triple wins 24:1.
		Math.random = () => 0;
		const root = makeSicBoRoot({ guestMode: false, initialBalance: 1000 });
		try {
			initSicBoClient();

			denomButton(1).click();
			betButton('any-triple').click();
			expect(actionButton().textContent).toBe('Roll');
			expect(actionButton().disabled).toBe(false);

			// Roll: the settlement request goes out and stays in flight.
			actionButton().click();
			expect(calls).toHaveLength(1);

			// In-flight window: New Round is painted but disabled.
			expect(actionButton().textContent).toBe('New Round');
			expect(actionButton().disabled).toBe(true);
			expect(document.getElementById('sic-bo-result')!.textContent).toBe('Won +24');

			// Server adopts the balance; the button unlocks.
			resolveFetch({
				ok: true,
				status: 200,
				json: async () => ({ balance: 1024, duplicate: false }),
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(balanceEl().textContent).toBe('1,024');
			expect(root.querySelector<HTMLElement>('[data-chip-balance]')?.textContent).toBe(
				'1,024 chips',
			);
			expect(actionButton().textContent).toBe('New Round');
			expect(actionButton().disabled).toBe(false);

			// New Round is usable again: back to betting with the retained slip.
			actionButton().click();
			expect(actionButton().textContent).toBe('Roll');
			expect(actionButton().disabled).toBe(false);
		} finally {
			Math.random = origRandom;
			root.remove();
		}
	});

	test('settlement failure renders its own copy through settlement.statusMessage and blocks New Round', async () => {
		localStorage.clear();
		const origFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
		Object.defineProperty(globalThis, 'fetch', {
			configurable: true,
			writable: true,
			value: async () => {
				throw new Error('Network error');
			},
		});
		const origRandom = Math.random;
		Math.random = () => 0;
		const root = makeSicBoRoot({ guestMode: false, initialBalance: 1000 });
		try {
			initSicBoClient();

			denomButton(1).click();
			betButton('any-triple').click();
			actionButton().click();
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(statusEl().textContent).toBe(
				'Settlement failed. Retry or reset before rolling again.',
			);
			expect(actionButton().textContent).toBe('New Round');
			expect(actionButton().disabled).toBe(true);
		} finally {
			Math.random = origRandom;
			restore(origFetchDescriptor, 'fetch');
			root.remove();
		}
	});
});

describe('initSicBoClient — guest round flow', () => {
	beforeEach(() => {
		restore(origFetch, 'fetch');
	});

	test('constructs against settlement.startingBalance (persisted guest bankroll)', () => {
		localStorage.clear();
		localStorage.setItem(`sic-bo-bankroll:${USER_ID}`, '400');
		installFetchSpy();
		const root = makeSicBoRoot({ guestMode: true, initialBalance: 1000 });
		try {
			initSicBoClient();
			expect(balanceEl().textContent).toBe('400');
		} finally {
			root.remove();
		}
	});

	test('guest win persists bankroll and sends no wallet settlement request', () => {
		localStorage.clear();
		const { calls } = installFetchSpy();
		const origRandom = Math.random;
		// Constant 0 → dice [1,1,1] → any-triple wins 24:1.
		Math.random = () => 0;
		const root = makeSicBoRoot({ guestMode: true, initialBalance: 1000 });
		try {
			initSicBoClient();

			denomButton(1).click();
			betButton('any-triple').click();
			actionButton().click();

			// Gross return 25 on a 1-chip any-triple → net +24.
			expect(balanceEl().textContent).toBe('1,024');
			expect(localStorage.getItem(`sic-bo-bankroll:${USER_ID}`)).toBe('1024');
			expect(calls).toHaveLength(0);
		} finally {
			Math.random = origRandom;
			root.remove();
		}
	});

	test('after a completed guest round the primary button becomes enabled New Round', () => {
		localStorage.clear();
		installFetchSpy();
		const origRandom = Math.random;
		Math.random = () => 0;
		const root = makeSicBoRoot({ guestMode: true, initialBalance: 1000 });
		try {
			initSicBoClient();

			denomButton(1).click();
			betButton('any-triple').click();
			actionButton().click();

			// Completed round: dice rendered, action is enabled New Round.
			for (let i = 0; i < 3; i++) {
				expect(document.getElementById(`sic-bo-die-${i}`)!.getAttribute('data-value')).toBe('1');
			}
			expect(document.getElementById('sic-bo-result')!.textContent).toBe('Won +24');
			expect(actionButton().textContent).toBe('New Round');
			expect(actionButton().disabled).toBe(false);

			// New Round returns to betting with the retained slip.
			actionButton().click();
			expect(actionButton().textContent).toBe('Roll');
			expect(actionButton().disabled).toBe(false);
			expect(betAmount('any-triple').textContent).toBe('1');
		} finally {
			Math.random = origRandom;
			root.remove();
		}
	});
});

// ---------------------------------------------------------------------------
// Bet and roll error catch paths in the action and bet-button handlers.
// ---------------------------------------------------------------------------
describe('initSicBoClient — bet and roll error handling', () => {
	beforeEach(() => {
		restore(origFetch, 'fetch');
	});

	test('bet exceeding balance shows error status without placing the bet', () => {
		localStorage.clear();
		const root = makeSicBoRoot({ guestMode: true, initialBalance: 1 });
		try {
			initSicBoClient();

			// Default denomination is 1 — place big (uses entire balance).
			betButton('big').click();
			expect(betAmount('big').textContent).toBe('1');

			// Try small — 1 (big) + 1 (small) = 2 > balance 1 → setBet throws.
			betButton('small').click();
			expect(document.getElementById('sic-bo-status')!.textContent).toBe(
				'Selected bets exceed available balance',
			);
			expect(betAmount('small').textContent).toBe('');
		} finally {
			root.remove();
		}
	});

	test('roll with empty slip shows error status via the catch path', () => {
		localStorage.clear();
		installFetchSpy();
		const root = makeSicBoRoot({ guestMode: true, initialBalance: 1000 });
		try {
			initSicBoClient();

			// Action is disabled (empty slip) — dispatch a click event directly
			// to bypass the disabled guard and exercise the roll() catch.
			actionButton().dispatchEvent(new happyWindow.Event('click'));

			expect(document.getElementById('sic-bo-status')!.textContent).toBe('Place at least one bet');
		} finally {
			root.remove();
		}
	});
});
