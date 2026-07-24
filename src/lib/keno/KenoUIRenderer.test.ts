// src/lib/keno/KenoUIRenderer.test.ts
import { Window } from 'happy-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { KENO_POOL, PAYTABLE } from './constants';
import { KenoUIRenderer } from './KenoUIRenderer';
import type { DrawResult } from './types';

// happy-dom provides a full DOM implementation without a browser.
// Install it for this suite only, then restore the original globals so this
// file cannot leak DOM state into tests that intentionally exercise no-DOM paths.
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
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
});
afterAll(() => {
	happyWindow.close();
	if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
	else Reflect.deleteProperty(globalThis, 'window');
	if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
	else Reflect.deleteProperty(globalThis, 'document');
});

function makeResult(over: Partial<DrawResult> = {}): DrawResult {
	return {
		syncId: 'sync-1',
		picks: [1, 2, 3],
		drawn: Array.from({ length: 20 }, (_, i) => i + 1),
		hits: [1, 2, 3],
		hitCount: 3,
		spots: 3,
		bet: 5,
		multiplier: 45,
		payout: 225,
		netDelta: 220,
		outcome: 'win',
		paytableVersion: '2026-07-standard-v1',
		timestamp: 0,
		...over,
	};
}

// Build a root element matching the data-testid contract in keno.astro.
function makeRoot(): HTMLElement {
	const root = document.createElement('div');
	root.setAttribute('data-testid', 'keno-root');
	root.innerHTML = `
		<span data-testid="chip-balance">0</span>
		<span data-testid="game-status"></span>
		<span data-testid="last-result"></span>
		<div data-testid="keno-grid"></div>
		<span data-testid="spot-count">0/10</span>
		<span data-testid="current-bet">1</span>
		<div data-testid="bet-chips">
			<button class="bet-chip" data-bet="1" aria-pressed="true">1</button>
			<button class="bet-chip" data-bet="2" aria-pressed="false">2</button>
			<button class="bet-chip" data-bet="5" aria-pressed="false">5</button>
		</div>
		<button data-testid="btn-quickpick">Quick Pick</button>
		<button data-testid="btn-clear">Clear</button>
		<button data-testid="btn-repeat">Repeat</button>
		<button data-testid="btn-draw" disabled>Draw</button>
		<div data-testid="recent-tickets"></div>
		<div data-testid="paytable-body"></div>
		<span data-chip-balance></span>
		<button data-testid="btn-settings">Settings</button>
		<div data-testid="settings-modal" class="hidden">
			<button data-testid="btn-settings-close">&times;</button>
			<button class="speed-opt" data-speed="slow">Slow</button>
			<button class="speed-opt" data-speed="normal">Normal</button>
			<button class="speed-opt" data-speed="fast">Fast</button>
			<input type="checkbox" id="setting-sound" data-testid="setting-sound" checked />
		</div>
		<button data-testid="btn-paytable">Paytable</button>
		<div data-testid="paytable-modal" class="hidden">
			<button data-testid="btn-paytable-close">&times;</button>
			<div data-testid="paytable-modal-body"></div>
		</div>
	`;
	document.body.appendChild(root);
	return root;
}

describe('KenoUIRenderer', () => {
	let root: HTMLElement;
	let renderer: KenoUIRenderer;

	beforeEach(() => {
		root = makeRoot();
		renderer = new KenoUIRenderer(root);
	});
	afterEach(() => {
		root.remove();
	});

	describe('constructor / buildGrid', () => {
		test('throws when a required data-testid is missing', () => {
			const bad = document.createElement('div');
			expect(() => new KenoUIRenderer(bad)).toThrow(/missing \[data-testid/);
		});
		test('builds exactly KENO_POOL grid cells', () => {
			expect(renderer.getAllCells()).toHaveLength(KENO_POOL);
		});
		test('each cell is a numbered button with a pick-order badge', () => {
			const cell = renderer.getCell(1);
			expect(cell).not.toBeNull();
			expect(cell?.tagName).toBe('BUTTON');
			expect(cell?.dataset.number).toBe('1');
			expect(cell?.getAttribute('aria-pressed')).toBe('false');
			expect(cell?.querySelector('.pick-order')).not.toBeNull();
		});
		test('getCell returns null for out-of-range numbers', () => {
			expect(renderer.getCell(0)).toBeNull();
			expect(renderer.getCell(KENO_POOL + 1)).toBeNull();
		});
	});

	describe('button getters', () => {
		test('exposes draw/clear/quickpick/repeat buttons', () => {
			expect(renderer.getDrawButton().dataset.testid).toBe('btn-draw');
			expect(renderer.getClearButton().dataset.testid).toBe('btn-clear');
			expect(renderer.getQuickPickButton().dataset.testid).toBe('btn-quickpick');
			expect(renderer.getRepeatButton().dataset.testid).toBe('btn-repeat');
		});
	});

	describe('settings modal', () => {
		test('exposes settings and close buttons', () => {
			expect(renderer.getSettingsButton().dataset.testid).toBe('btn-settings');
			expect(renderer.getSettingsCloseButton().dataset.testid).toBe('btn-settings-close');
		});
		test('exposes three speed option buttons', () => {
			const opts = renderer.getSpeedOptions();
			expect(opts).toHaveLength(3);
			expect(opts.map((o) => o.dataset.speed).sort()).toEqual(['fast', 'normal', 'slow']);
		});
		test('showSettingsModal removes hidden class; hideSettingsModal adds it back', () => {
			renderer.showSettingsModal();
			expect(
				root
					.querySelector<HTMLElement>('[data-testid="settings-modal"]')
					?.classList.contains('hidden'),
			).toBe(false);
			expect(renderer.getSettingsButton().getAttribute('aria-expanded')).toBe('true');
			renderer.hideSettingsModal();
			expect(
				root
					.querySelector<HTMLElement>('[data-testid="settings-modal"]')
					?.classList.contains('hidden'),
			).toBe(true);
			expect(renderer.getSettingsButton().getAttribute('aria-expanded')).toBe('false');
		});
		test('renderSettingsSpeed marks only the matching option as selected', () => {
			renderer.renderSettingsSpeed('fast');
			const opts = renderer.getSpeedOptions();
			expect(opts[0].classList.contains('selected')).toBe(false); // slow
			expect(opts[1].classList.contains('selected')).toBe(false); // normal
			expect(opts[2].classList.contains('selected')).toBe(true); // fast
			expect(opts[2].getAttribute('aria-pressed')).toBe('true');
			expect(opts[0].getAttribute('aria-pressed')).toBe('false');
		});
	});

	describe('renderBalance', () => {
		test('updates the chip-balance element and all [data-chip-balance] nodes', () => {
			renderer.renderBalance(12345);
			expect(root.querySelector<HTMLElement>('[data-testid="chip-balance"]')?.textContent).toBe(
				'12,345',
			);
			expect(root.querySelector<HTMLElement>('[data-chip-balance]')?.textContent).toBe(
				'12,345 chips',
			);
		});
	});

	describe('renderBet', () => {
		test('updates current-bet text and toggles .selected on matching bet-chip', () => {
			renderer.renderBet(2);
			expect(root.querySelector<HTMLElement>('[data-testid="current-bet"]')?.textContent).toBe('2');
			const chips = root.querySelectorAll<HTMLButtonElement>('.bet-chip');
			expect(chips[0].classList.contains('selected')).toBe(false);
			expect(chips[1].classList.contains('selected')).toBe(true);
			expect(chips[1].getAttribute('aria-pressed')).toBe('true');
			expect(chips[0].getAttribute('aria-pressed')).toBe('false');
		});
	});

	describe('renderPicks', () => {
		test('marks selected cells, sets aria-pressed, and writes pick-order badges', () => {
			renderer.renderPicks([3, 1]);
			const cell1 = renderer.getCell(1)!;
			const cell3 = renderer.getCell(3)!;
			const cell2 = renderer.getCell(2)!;
			expect(cell1.classList.contains('selected')).toBe(true);
			expect(cell1.getAttribute('aria-pressed')).toBe('true');
			expect(cell1.querySelector('.pick-order')?.textContent).toBe('2');
			expect(cell3.querySelector('.pick-order')?.textContent).toBe('1');
			expect(cell2.classList.contains('selected')).toBe(false);
			expect(cell2.querySelector('.pick-order')?.textContent).toBe('');
			expect(root.querySelector<HTMLElement>('[data-testid="spot-count"]')?.textContent).toBe(
				'2/10',
			);
		});
		test('empty picks clears all badges and selection', () => {
			renderer.renderPicks([1]);
			renderer.renderPicks([]);
			expect(renderer.getCell(1)?.classList.contains('selected')).toBe(false);
			expect(renderer.getCell(1)?.querySelector('.pick-order')?.textContent).toBe('');
			expect(root.querySelector<HTMLElement>('[data-testid="spot-count"]')?.textContent).toBe(
				'0/10',
			);
		});
	});

	describe('renderCanDraw / setStatus', () => {
		test('renderCanDraw toggles the draw button disabled state', () => {
			renderer.renderCanDraw(true);
			expect(renderer.getDrawButton().disabled).toBe(false);
			renderer.renderCanDraw(false);
			expect(renderer.getDrawButton().disabled).toBe(true);
		});
		test('setStatus writes text to the status element', () => {
			renderer.setStatus('Pick your numbers');
			expect(root.querySelector<HTMLElement>('[data-testid="game-status"]')?.textContent).toBe(
				'Pick your numbers',
			);
		});
	});

	describe('renderLastResult', () => {
		test('win outcome uses "won" and netDelta', () => {
			renderer.renderLastResult(
				makeResult({ outcome: 'win', netDelta: 220, hitCount: 3, spots: 3 }),
			);
			expect(root.querySelector<HTMLElement>('[data-testid="last-result"]')?.textContent).toBe(
				'3 of 3 won 220',
			);
		});
		test('loss outcome uses "lost" and bet amount', () => {
			renderer.renderLastResult(
				makeResult({ outcome: 'loss', netDelta: -5, bet: 5, hitCount: 0, spots: 3 }),
			);
			expect(root.querySelector<HTMLElement>('[data-testid="last-result"]')?.textContent).toBe(
				'0 of 3 lost 5',
			);
		});
		test('push outcome uses "pushed" with bet-returned note', () => {
			renderer.renderLastResult(
				makeResult({ outcome: 'push', netDelta: 0, bet: 5, hitCount: 2, spots: 4 }),
			);
			expect(root.querySelector<HTMLElement>('[data-testid="last-result"]')?.textContent).toBe(
				'2 of 4 — pushed (bet returned)',
			);
		});
	});

	describe('highlightDrawn / clearDrawnHighlight', () => {
		test('clearDrawnHighlight removes drawn/hit classes and cancels pending timeouts', () => {
			const timeouts: number[] = [];
			const origSet = window.setTimeout;
			const origClear = window.clearTimeout;
			(happyWindow as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
				cb: TimerHandler,
			) => {
				const id = timeouts.length + 1;
				timeouts.push(id);
				cb();
				return id;
			}) as typeof setTimeout;
			(happyWindow as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = (() => {
				// no-op
			}) as typeof clearTimeout;

			try {
				renderer.highlightDrawn([1, 2], [1]);
				expect(renderer.getCell(1)?.classList.contains('drawn')).toBe(true);
				expect(renderer.getCell(1)?.classList.contains('hit')).toBe(true);
				expect(renderer.getCell(2)?.classList.contains('drawn')).toBe(true);
				expect(renderer.getCell(2)?.classList.contains('hit')).toBe(false);

				renderer.clearDrawnHighlight();
				expect(renderer.getCell(1)?.classList.contains('drawn')).toBe(false);
				expect(renderer.getCell(1)?.classList.contains('hit')).toBe(false);
				expect(renderer.getCell(2)?.classList.contains('drawn')).toBe(false);
			} finally {
				(happyWindow as unknown as { setTimeout: typeof setTimeout }).setTimeout = origSet;
				(happyWindow as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = origClear;
			}
		});
		test('highlightDrawn skips unknown numbers gracefully', () => {
			renderer.highlightDrawn([999], []);
			expect(renderer.getAllCells().every((c) => !c.classList.contains('drawn'))).toBe(true);
			renderer.clearDrawnHighlight();
		});
	});

	describe('renderRecent', () => {
		test('renders up to 10 recent-ticket rows with sign prefix', () => {
			const history = [
				makeResult({ spots: 3, hitCount: 3, netDelta: 220 }),
				makeResult({ spots: 4, hitCount: 0, netDelta: -5 }),
			];
			renderer.renderRecent(history);
			const rows = root.querySelectorAll('.recent-ticket');
			expect(rows).toHaveLength(2);
			expect(rows[0].textContent).toBe('3p 3hit +220');
			expect(rows[1].textContent).toBe('4p 0hit -5');
		});
		test('slices to the most recent 10', () => {
			const history = Array.from({ length: 15 }, (_, i) =>
				makeResult({ syncId: `s-${i}`, netDelta: i }),
			);
			renderer.renderRecent(history);
			expect(root.querySelectorAll('.recent-ticket')).toHaveLength(10);
		});
		test('empty history clears the container', () => {
			renderer.renderRecent([makeResult()]);
			renderer.renderRecent([]);
			expect(root.querySelectorAll('.recent-ticket')).toHaveLength(0);
		});
	});

	describe('renderPaytable', () => {
		test('renders a row per paying tier for the given spot count', () => {
			renderer.renderPaytable(5);
			const body = root.querySelector<HTMLElement>('[data-testid="paytable-body"]')!;
			expect(body.innerHTML).toContain('<table');
			const tiers = PAYTABLE[5];
			for (const [catchStr] of Object.entries(tiers)) {
				expect(body.innerHTML).toContain(`Catch ${catchStr}`);
			}
		});
		test('unknown spot count renders an empty table body', () => {
			renderer.renderPaytable(99);
			const body = root.querySelector<HTMLElement>('[data-testid="paytable-body"]')!;
			expect(body.innerHTML).toContain('<table');
			expect(body.innerHTML).not.toContain('Catch');
		});
		test('clearPaytable empties the paytable body', () => {
			renderer.renderPaytable(5);
			const body = root.querySelector<HTMLElement>('[data-testid="paytable-body"]')!;
			expect(body.innerHTML).toContain('<table');
			renderer.clearPaytable();
			expect(body.innerHTML).toBe('');
		});
		test('renderPaytable also populates the modal body and keeps it in sync', () => {
			renderer.renderPaytable(7);
			const sidebar = root.querySelector<HTMLElement>('[data-testid="paytable-body"]')!;
			const modalBody = root.querySelector<HTMLElement>('[data-testid="paytable-modal-body"]')!;
			expect(modalBody.innerHTML).toContain('<table');
			expect(modalBody.innerHTML).toContain('Catch 7');
			// Both bodies reflect the same spot count.
			expect(modalBody.innerHTML).toContain('×5000');
			expect(sidebar.innerHTML).toContain('×5000');
			// Re-rendering with a different spot count updates both.
			renderer.renderPaytable(1);
			expect(modalBody.innerHTML).not.toContain('Catch 7');
			expect(sidebar.innerHTML).not.toContain('Catch 7');
			// clearPaytable empties both.
			renderer.clearPaytable();
			expect(modalBody.innerHTML).toBe('');
			expect(sidebar.innerHTML).toBe('');
		});
	});

	describe('paytable modal', () => {
		test('exposes paytable and close buttons', () => {
			expect(renderer.getPaytableButton().dataset.testid).toBe('btn-paytable');
			expect(renderer.getPaytableCloseButton().dataset.testid).toBe('btn-paytable-close');
		});
		test('showPaytableModal removes hidden class; hidePaytableModal adds it back', () => {
			renderer.showPaytableModal();
			expect(
				root
					.querySelector<HTMLElement>('[data-testid="paytable-modal"]')
					?.classList.contains('hidden'),
			).toBe(false);
			expect(renderer.getPaytableButton().getAttribute('aria-expanded')).toBe('true');
			renderer.hidePaytableModal();
			expect(
				root
					.querySelector<HTMLElement>('[data-testid="paytable-modal"]')
					?.classList.contains('hidden'),
			).toBe(true);
			expect(renderer.getPaytableButton().getAttribute('aria-expanded')).toBe('false');
		});
	});
});
