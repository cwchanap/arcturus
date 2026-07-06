import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { SlotsUIRenderer } from './SlotsUIRenderer';
import {
	MAX_HISTORY,
	NUM_REELS,
	NUM_ROWS,
	SYMBOL_ORDER,
	SYMBOLS,
	getSpinDurationMs as constantsGetSpinDurationMs,
} from './constants';
import type { LineWin, ReelGrid, SlotSettings, SpinResult, SymbolId } from './types';

class FakeElement {
	tagName: string;
	id = '';
	textContent = '';
	private _innerHTML = '';
	className = '';
	disabled = false;
	dataset: Record<string, string> = {};
	style: Record<string, string> = {};
	attributes: Record<string, string> = {};
	children: FakeElement[] = [];
	parent: FakeElement | null = null;
	private classes = new Set<string>();

	classList = {
		add: (...c: string[]) => {
			for (const x of c) this.classes.add(x);
		},
		remove: (...c: string[]) => {
			for (const x of c) this.classes.delete(x);
		},
		toggle: (c: string, force?: boolean) => {
			if (force === true) this.classes.add(c);
			else if (force === false) this.classes.delete(c);
			else if (this.classes.has(c)) this.classes.delete(c);
			else this.classes.add(c);
		},
		contains: (c: string) => this.classes.has(c),
	};

	constructor(tagName = 'div') {
		this.tagName = tagName.toUpperCase();
	}

	set innerHTML(v: string) {
		this._innerHTML = v;
		if (v === '') this.children = [];
	}
	get innerHTML() {
		return this._innerHTML;
	}

	setAttribute(name: string, value: string) {
		this.attributes[name] = value;
	}
	getAttribute(name: string) {
		return this.attributes[name] ?? null;
	}

	appendChild<T extends FakeElement>(child: T): T {
		this.children.push(child);
		child.parent = this;
		return child;
	}

	hasClass(c: string) {
		return this.classes.has(c);
	}

	*descendants(): IterableIterator<FakeElement> {
		for (const c of this.children) {
			yield c;
			yield* c.descendants();
		}
	}

	querySelector(selector: string): FakeElement | null {
		return this.querySelectorAll(selector)[0] ?? null;
	}

	querySelectorAll(selector: string): FakeElement[] {
		const parsed = parseSelector(selector);
		const out: FakeElement[] = [];
		for (const el of this.descendants()) {
			if (matchesParsed(el, parsed)) out.push(el);
		}
		return out;
	}
}

interface ParsedSelector {
	classes: string[];
	attrs: { name: string; value: string }[];
	tag: string | null;
}

function parseSelector(sel: string): ParsedSelector {
	const classes = [...sel.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]);
	const attrs = [...sel.matchAll(/\[([\w-]+)="([^"]*)"\]/g)].map((m) => ({
		name: m[1],
		value: m[2],
	}));
	const tagMatch = sel.match(/^[a-zA-Z][\w-]*/);
	return { classes, attrs, tag: tagMatch ? tagMatch[0] : null };
}

function matchesParsed(el: FakeElement, p: ParsedSelector): boolean {
	if (p.tag && el.tagName.toLowerCase() !== p.tag.toLowerCase()) return false;
	for (const c of p.classes) if (!el.hasClass(c)) return false;
	for (const a of p.attrs) {
		const key = a.name.startsWith('data-') ? a.name.slice(5) : a.name;
		if (el.dataset[key] !== a.value) return false;
	}
	return true;
}

interface DomFixtures {
	all: FakeElement[];
	betChips: FakeElement[];
	reels: FakeElement[];
	spinBtn: FakeElement;
	balance: FakeElement;
	bet: FakeElement;
	lastResult: FakeElement;
	lastWin: FakeElement;
	recent: FakeElement;
	status: FakeElement;
	toast: FakeElement;
	cell: (reel: number, row: number) => FakeElement | null;
	glyph: (reel: number, row: number) => FakeElement | null;
}

function setupSlotsDom(betIncrements: number[] = [1, 5, 10, 25, 50, 100]): DomFixtures {
	const all: FakeElement[] = [];

	const make = (
		tag: string,
		init?: { id?: string; dataset?: Record<string, string>; classes?: string[] },
	): FakeElement => {
		const el = new FakeElement(tag);
		if (init?.id) el.id = init.id;
		if (init?.dataset) el.dataset = { ...init.dataset };
		if (init?.classes) for (const c of init.classes) el.classList.add(c);
		all.push(el);
		return el;
	};

	const spinBtn = make('button', { id: 'btn-spin' });
	const balance = make('div', { id: 'chip-balance' });
	const bet = make('span', { id: 'current-bet' });
	const lastResult = make('div', { id: 'last-result' });
	const lastWin = make('div', { id: 'last-win' });
	const recent = make('div', { id: 'recent-spins' });
	const status = make('div', { id: 'game-status', classes: ['hidden'] });
	const toast = make('div', { id: 'achievement-toast', classes: ['hidden'] });

	const betChips = betIncrements.map((amount) =>
		make('button', { dataset: { bet: String(amount) }, classes: ['bet-chip'] }),
	);

	const reels: FakeElement[] = [];
	for (let r = 0; r < NUM_REELS; r++) {
		const reel = make('div', { classes: ['reel'] });
		reels.push(reel);
		for (let row = 0; row < NUM_ROWS; row++) {
			const cell = make('div', {
				classes: ['symbol-cell'],
				dataset: { reel: String(r), row: String(row) },
			});
			const glyph = make('span', { classes: ['symbol-glyph'] });
			cell.appendChild(glyph);
			reel.appendChild(cell);
		}
	}

	(globalThis as any).document = {
		getElementById: (id: string) => all.find((e) => e.id === id) ?? null,
		querySelector: (sel: string) => {
			const parsed = parseSelector(sel);
			return all.find((e) => matchesParsed(e, parsed)) ?? null;
		},
		querySelectorAll: (sel: string) => {
			const parsed = parseSelector(sel);
			return all.filter((e) => matchesParsed(e, parsed));
		},
		createElement: (tag: string) => {
			const el = new FakeElement(tag);
			all.push(el);
			return el;
		},
	};

	const findCell = (reel: number, row: number) =>
		all.find(
			(e) =>
				e.hasClass('symbol-cell') &&
				e.dataset.reel === String(reel) &&
				e.dataset.row === String(row),
		) ?? null;

	return {
		all,
		betChips,
		reels,
		spinBtn,
		balance,
		bet,
		lastResult,
		lastWin,
		recent,
		status,
		toast,
		cell: findCell,
		glyph: (reel, row) => {
			const c = findCell(reel, row);
			return c?.children.find((ch) => ch.hasClass('symbol-glyph')) ?? null;
		},
	};
}

let fx: DomFixtures;
beforeEach(() => {
	fx = setupSlotsDom();
});
afterEach(() => {
	delete (globalThis as any).document;
});

function makeWin(partial: Partial<LineWin>): LineWin {
	return {
		paylineIndex: 0,
		symbol: 'cherry',
		count: 3,
		multiplier: 10,
		payout: 20,
		...partial,
	};
}

function makeResult(partial: Partial<SpinResult>): SpinResult {
	return {
		bet: 10,
		grid: [],
		payout: 0,
		netDelta: 0,
		timestamp: 0,
		syncId: 's1',
		lineWins: [],
		...partial,
	};
}

function gridWhereEachCellIsUnique(): ReelGrid {
	const reels: ReelGrid = [];
	for (let r = 0; r < NUM_REELS; r++) {
		const col: SymbolId[] = [];
		for (let row = 0; row < NUM_ROWS; row++) {
			col.push(SYMBOL_ORDER[(r + row * NUM_REELS) % SYMBOL_ORDER.length]);
		}
		reels.push(col);
	}
	return reels;
}

describe('SlotsUIRenderer', () => {
	test('setSpinEnabled toggles the spin button disabled state', () => {
		const r = new SlotsUIRenderer();
		expect(fx.spinBtn.disabled).toBe(false);
		r.setSpinEnabled(false);
		expect(fx.spinBtn.disabled).toBe(true);
		r.setSpinEnabled(true);
		expect(fx.spinBtn.disabled).toBe(false);
	});

	test('setSpinEnabled is a no-op when the button is absent', () => {
		(globalThis as any).document.getElementById = () => null;
		const r = new SlotsUIRenderer();
		expect(() => r.setSpinEnabled(false)).not.toThrow();
	});

	test('renderBalance formats the balance with locale separators', () => {
		const r = new SlotsUIRenderer();
		r.renderBalance(1234567);
		expect(fx.balance.textContent).toBe((1234567).toLocaleString());
	});

	test('renderBet updates the bet label, selects the matching chip, and sets aria-pressed', () => {
		const r = new SlotsUIRenderer();
		r.renderBet(10);
		expect(fx.bet.textContent).toBe('10');
		const selected = fx.betChips.find((c) => c.dataset.bet === '10')!;
		const other = fx.betChips.find((c) => c.dataset.bet === '1')!;
		expect(selected.hasClass('selected')).toBe(true);
		expect(selected.getAttribute('aria-pressed')).toBe('true');
		expect(other.hasClass('selected')).toBe(false);
		expect(other.getAttribute('aria-pressed')).toBe('false');
	});

	test('renderBet clears the previous selection when the bet changes', () => {
		const r = new SlotsUIRenderer();
		r.renderBet(1);
		expect(fx.betChips.find((c) => c.dataset.bet === '1')!.hasClass('selected')).toBe(true);
		r.renderBet(100);
		expect(fx.betChips.find((c) => c.dataset.bet === '1')!.hasClass('selected')).toBe(false);
		expect(fx.betChips.find((c) => c.dataset.bet === '100')!.hasClass('selected')).toBe(true);
	});

	test('renderGrid writes the matching glyph into every cell using grid[reel][row]', () => {
		const r = new SlotsUIRenderer();
		const grid = gridWhereEachCellIsUnique();
		r.renderGrid(grid);
		for (let reel = 0; reel < NUM_REELS; reel++) {
			for (let row = 0; row < NUM_ROWS; row++) {
				const g = fx.glyph(reel, row);
				expect(g?.textContent).toBe(SYMBOLS[grid[reel][row]].glyph);
			}
		}
	});

	test('clearHighlight removes the win class from all winning cells', () => {
		const r = new SlotsUIRenderer();
		fx.cell(0, 1)!.classList.add('win');
		fx.cell(2, 2)!.classList.add('win');
		r.clearHighlight();
		expect(fx.cell(0, 1)!.hasClass('win')).toBe(false);
		expect(fx.cell(2, 2)!.hasClass('win')).toBe(false);
	});

	test('highlightWins marks the first `count` cells along the chosen payline', () => {
		const r = new SlotsUIRenderer();
		r.highlightWins([makeWin({ paylineIndex: 0, count: 3 })]);
		expect(fx.cell(0, 1)!.hasClass('win')).toBe(true);
		expect(fx.cell(1, 1)!.hasClass('win')).toBe(true);
		expect(fx.cell(2, 1)!.hasClass('win')).toBe(true);
		expect(fx.cell(3, 1)!.hasClass('win')).toBe(false);
		expect(fx.cell(4, 1)!.hasClass('win')).toBe(false);
	});

	test('highlightWins follows V-shaped payline 4 across all five reels', () => {
		const r = new SlotsUIRenderer();
		r.highlightWins([makeWin({ paylineIndex: 3, count: 5 })]);
		const expected = [
			[0, 0],
			[1, 1],
			[2, 2],
			[3, 1],
			[4, 0],
		];
		for (const [reel, row] of expected) {
			expect(fx.cell(reel, row)!.hasClass('win')).toBe(true);
		}
	});

	test('highlightWins clears previous highlights before applying new ones', () => {
		const r = new SlotsUIRenderer();
		fx.cell(4, 4 % NUM_ROWS)!.classList.add('win');
		r.highlightWins([makeWin({ paylineIndex: 0, count: 3 })]);
		expect(fx.cell(0, 1)!.hasClass('win')).toBe(true);
	});

	test('setSpinning toggles the spinning class on every reel wrapper', () => {
		const r = new SlotsUIRenderer();
		r.setSpinning(true);
		for (const reel of fx.reels) expect(reel.hasClass('spinning')).toBe(true);
		r.setSpinning(false);
		for (const reel of fx.reels) expect(reel.hasClass('spinning')).toBe(false);
	});

	test('showStatus reveals the status banner with the message', () => {
		const r = new SlotsUIRenderer();
		r.showStatus('Place your bet');
		expect(fx.status.textContent).toBe('Place your bet');
		expect(fx.status.hasClass('hidden')).toBe(false);
	});

	test('showStatus(null) hides the status banner', () => {
		const r = new SlotsUIRenderer();
		r.showStatus('hi');
		r.showStatus(null);
		expect(fx.status.hasClass('hidden')).toBe(true);
	});

	test('renderResult with wins shows the top line and the payout', () => {
		const r = new SlotsUIRenderer();
		const result = makeResult({
			payout: 250,
			lineWins: [
				makeWin({ symbol: 'cherry', count: 3, multiplier: 10, paylineIndex: 1 }),
				makeWin({ symbol: 'seven', count: 5, multiplier: 1000, paylineIndex: 0 }),
			],
		});
		r.renderResult(result);
		expect(fx.lastResult.textContent).toBe('Seven ×5 on line 1');
		expect(fx.lastWin.textContent).toBe('WIN +250');
		expect(fx.lastWin.style.color).toBe('var(--deco-jade)');
	});

	test('renderResult without wins shows "No win" and clears the win line', () => {
		const r = new SlotsUIRenderer();
		fx.lastWin.textContent = 'WIN +99';
		r.renderResult(makeResult({ lineWins: [] }));
		expect(fx.lastResult.textContent).toBe('No win');
		expect(fx.lastWin.textContent).toBe('');
	});

	test('renderRecent appends colored dots for positive, negative, and zero deltas', () => {
		const r = new SlotsUIRenderer();
		const history = [
			makeResult({ netDelta: 50 }),
			makeResult({ netDelta: -30 }),
			makeResult({ netDelta: 0 }),
		];
		r.renderRecent(history);
		expect(fx.recent.children).toHaveLength(3);
		expect(fx.recent.children[0].textContent).toBe('+50');
		expect(fx.recent.children[0].style.color).toBe('var(--deco-jade)');
		expect(fx.recent.children[1].textContent).toBe('-30');
		expect(fx.recent.children[1].style.color).toBe('var(--deco-oxblood-bright)');
		expect(fx.recent.children[2].textContent).toBe('0');
		expect(fx.recent.children[2].style.color).toBe('var(--deco-muted)');
	});

	test(`renderRecent truncates history to MAX_HISTORY (${MAX_HISTORY}) entries`, () => {
		const r = new SlotsUIRenderer();
		const history: SpinResult[] = [];
		for (let i = 0; i < MAX_HISTORY + 5; i++) history.push(makeResult({ netDelta: i }));
		r.renderRecent(history);
		expect(fx.recent.children).toHaveLength(MAX_HISTORY);
	});

	test('renderRecent replaces previous entries on re-render', () => {
		const r = new SlotsUIRenderer();
		r.renderRecent([makeResult({ netDelta: 1 })]);
		expect(fx.recent.children).toHaveLength(1);
		r.renderRecent([makeResult({ netDelta: 2 }), makeResult({ netDelta: 3 })]);
		expect(fx.recent.children).toHaveLength(2);
		expect(fx.recent.children[0].textContent).toBe('+2');
	});

	test('getSpinDurationMs delegates to constants for each speed', () => {
		const r = new SlotsUIRenderer();
		for (const speed of ['slow', 'normal', 'fast'] as const) {
			const settings: SlotSettings = { spinSpeed: speed, soundEnabled: true, quickSpin: false };
			expect(r.getSpinDurationMs(settings)).toBe(constantsGetSpinDurationMs(speed));
		}
	});

	test('showAchievement reveals the toast with the provided text', () => {
		const r = new SlotsUIRenderer();
		r.showAchievement('Big win!');
		expect(fx.toast.textContent).toBe('Big win!');
		expect(fx.toast.hasClass('hidden')).toBe(false);
	});
});
