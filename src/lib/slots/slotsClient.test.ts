import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { SettlementGate } from '../wallet';
import {
	buildSlotsSettlementCommand,
	canStartSlotsSpin,
	initSlotsClient,
	retrySlotsSettlement,
} from './slotsClient';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const slotsWindow = new Window();

function restoreGlobal(desc: PropertyDescriptor | undefined, key: string): void {
	if (desc) Object.defineProperty(globalThis, key, desc);
	else Reflect.deleteProperty(globalThis, key);
}

beforeAll(() => {
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		writable: true,
		value: slotsWindow,
	});
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		writable: true,
		value: slotsWindow.document,
	});
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		writable: true,
		value: slotsWindow.localStorage,
	});
});

afterAll(() => {
	slotsWindow.close();
	restoreGlobal(originalWindow, 'window');
	restoreGlobal(originalDocument, 'document');
	restoreGlobal(originalLocalStorage, 'localStorage');
});

function makeSlotsRoot(): HTMLElement {
	const root = document.createElement('div');
	root.id = 'slots-root';
	root.dataset.userId = 'slots-test-user';
	root.dataset.guestMode = 'true';
	root.dataset.initialBalance = '1000';
	root.innerHTML = `
		<span id="chip-balance">1000</span>
		<span id="current-bet">1</span>
		<button id="btn-spin">Spin</button>
		<div id="game-status" class="hidden"></div>
		<div id="last-result"></div>
		<div id="last-win"></div>
		<div id="recent-spins"></div>
		<div id="reel-window">
			${Array.from(
				{ length: 5 },
				(_, reel) => `
				<div class="reel" data-reel="${reel}">
					${Array.from(
						{ length: 3 },
						(_, row) => `
						<div class="symbol-cell" data-reel="${reel}" data-row="${row}">
							<span class="symbol-glyph"></span>
						</div>
					`,
					).join('')}
				</div>
			`,
			).join('')}
		</div>
		<div id="settings-panel" class="hidden"></div>
		<div id="paytable-panel" class="hidden"></div>
	`;
	document.body.appendChild(root);
	return root;
}

describe('Slots wallet settlement client', () => {
	test('builds one wallet command from a spin result', () => {
		expect(buildSlotsSettlementCommand('slots-win', { netDelta: 120 })).toEqual({
			settlementId: 'slots-win',
			game: 'slots',
			delta: 120,
			stats: { rounds: 1, wins: 1, losses: 0, biggestWin: 120 },
		});
	});

	test('blocks an authenticated spin while the shared gate is blocked', () => {
		const gate = { isBlocked: true } as SettlementGate;
		expect(canStartSlotsSpin({ isGuestMode: false, gate })).toBe(false);
	});

	test('does not block guest spins on an authenticated settlement gate', () => {
		const gate = { isBlocked: true } as SettlementGate;
		expect(canStartSlotsSpin({ isGuestMode: true, gate })).toBe(true);
	});

	test('delegates Retry to the shared settlement gate', async () => {
		let retryCalls = 0;
		const result = await retrySlotsSettlement({
			retry: async () => {
				retryCalls += 1;
				return { balance: 1_025, duplicate: false };
			},
		});

		expect(retryCalls).toBe(1);
		expect(result).toEqual({ balance: 1_025, duplicate: false });
	});

	test('guest spin re-enables the control after completion for a second spin', () => {
		localStorage.clear();
		localStorage.setItem(
			'arcturus:slots:settings:slots-test-user',
			JSON.stringify({ quickSpin: true }),
		);
		const root = makeSlotsRoot();
		try {
			initSlotsClient();
			const spinButton = document.getElementById('btn-spin') as HTMLButtonElement;
			expect(spinButton.disabled).toBe(false);

			spinButton.click();
			expect(spinButton.disabled).toBe(false);

			spinButton.click();
			expect(spinButton.disabled).toBe(false);
		} finally {
			root.remove();
		}
	});
});
