// src/lib/keno/KenoUIRenderer.ts
import { KENO_POOL, PAYTABLE } from './constants';
import type { DrawResult } from './types';

type El = HTMLElement;

export class KenoUIRenderer {
	private readonly root: El;
	private readonly grid: El;
	private readonly balanceEl: El;
	private readonly betEl: El;
	private readonly spotCountEl: El;
	private readonly statusEl: El;
	private readonly lastResultEl: El;
	private readonly drawBtn: HTMLButtonElement;
	private readonly clearBtn: HTMLButtonElement;
	private readonly quickPickBtn: HTMLButtonElement;
	private readonly repeatBtn: HTMLButtonElement;
	private readonly recentEl: El;
	private readonly paytableBody: El;
	private readonly settingsBtn: HTMLButtonElement;
	private readonly settingsModal: El;
	private readonly settingsCloseBtn: HTMLButtonElement;
	private readonly speedOptions: HTMLButtonElement[];
	private revealTimeouts: number[] = [];

	constructor(root: El) {
		this.root = root;
		this.grid = req<El>(root, 'keno-grid');
		this.balanceEl = req<El>(root, 'chip-balance');
		this.betEl = req<El>(root, 'current-bet');
		this.spotCountEl = req<El>(root, 'spot-count');
		this.statusEl = req<El>(root, 'game-status');
		this.lastResultEl = req<El>(root, 'last-result');
		this.drawBtn = req<HTMLButtonElement>(root, 'btn-draw');
		this.clearBtn = req<HTMLButtonElement>(root, 'btn-clear');
		this.quickPickBtn = req<HTMLButtonElement>(root, 'btn-quickpick');
		this.repeatBtn = req<HTMLButtonElement>(root, 'btn-repeat');
		this.recentEl = req<El>(root, 'recent-tickets');
		this.paytableBody = req<El>(root, 'paytable-body');
		this.settingsBtn = req<HTMLButtonElement>(root, 'btn-settings');
		this.settingsModal = req<El>(root, 'settings-modal');
		this.settingsCloseBtn = req<HTMLButtonElement>(root, 'btn-settings-close');
		this.speedOptions = Array.from(root.querySelectorAll<HTMLButtonElement>('button.speed-opt'));
		this.buildGrid();
	}

	private buildGrid(): void {
		for (let n = 1; n <= KENO_POOL; n++) {
			const cell = document.createElement('button');
			cell.type = 'button';
			cell.className = 'keno-cell';
			cell.dataset.number = String(n);
			cell.setAttribute('aria-pressed', 'false');
			const label = document.createElement('span');
			label.textContent = String(n);
			const badge = document.createElement('span');
			badge.className = 'pick-order';
			badge.setAttribute('aria-hidden', 'true');
			cell.append(label, badge);
			this.grid.appendChild(cell);
		}
	}

	getCell(n: number): HTMLButtonElement | null {
		return this.grid.querySelector<HTMLButtonElement>(`button.keno-cell[data-number="${n}"]`);
	}
	getAllCells(): HTMLButtonElement[] {
		return Array.from(this.grid.querySelectorAll<HTMLButtonElement>('button.keno-cell'));
	}

	// Buttons the client wires events to:
	getDrawButton(): HTMLButtonElement {
		return this.drawBtn;
	}
	getClearButton(): HTMLButtonElement {
		return this.clearBtn;
	}
	getQuickPickButton(): HTMLButtonElement {
		return this.quickPickBtn;
	}
	getRepeatButton(): HTMLButtonElement {
		return this.repeatBtn;
	}
	getSettingsButton(): HTMLButtonElement {
		return this.settingsBtn;
	}
	getSettingsCloseButton(): HTMLButtonElement {
		return this.settingsCloseBtn;
	}
	getSpeedOptions(): HTMLButtonElement[] {
		return this.speedOptions;
	}
	showSettingsModal(): void {
		this.settingsModal.classList.remove('hidden');
		this.settingsBtn.setAttribute('aria-expanded', 'true');
	}
	hideSettingsModal(): void {
		this.settingsModal.classList.add('hidden');
		this.settingsBtn.setAttribute('aria-expanded', 'false');
	}
	renderSettingsSpeed(speed: string): void {
		this.speedOptions.forEach((b) => {
			const active = b.dataset.speed === speed;
			b.classList.toggle('selected', active);
			b.setAttribute('aria-pressed', active ? 'true' : 'false');
		});
	}

	renderBalance(balance: number): void {
		this.balanceEl.textContent = balance.toLocaleString();
		document.querySelectorAll<HTMLElement>('[data-chip-balance]').forEach((el) => {
			el.textContent = `${balance.toLocaleString()} chips`;
		});
	}
	renderBet(bet: number): void {
		this.betEl.textContent = String(bet);
		this.root.querySelectorAll<HTMLButtonElement>('.bet-chip').forEach((b) => {
			const active = Number(b.dataset.bet) === bet;
			b.classList.toggle('selected', active);
			b.setAttribute('aria-pressed', active ? 'true' : 'false');
		});
	}
	renderPicks(picks: number[]): void {
		const set = new Set(picks);
		this.getAllCells().forEach((cell) => {
			const n = Number(cell.dataset.number);
			const order = picks.indexOf(n) + 1;
			cell.classList.toggle('selected', set.has(n));
			cell.setAttribute('aria-pressed', set.has(n) ? 'true' : 'false');
			const badge = cell.querySelector('.pick-order');
			if (set.has(n) && badge) badge.textContent = String(order);
			else if (badge) badge.textContent = '';
		});
		this.spotCountEl.textContent = `${picks.length}/10`;
	}
	renderCanDraw(can: boolean): void {
		this.drawBtn.disabled = !can;
	}
	setStatus(text: string): void {
		this.statusEl.textContent = text;
	}
	renderLastResult(r: DrawResult): void {
		const verb = r.outcome === 'win' ? 'won' : r.outcome === 'push' ? 'pushed' : 'lost';
		const amt = r.outcome === 'win' ? r.netDelta : r.outcome === 'loss' ? r.bet : 0;
		this.lastResultEl.textContent = `${r.hitCount} of ${r.spots} ${verb} ${amt.toLocaleString()}`;
	}
	highlightDrawn(drawn: number[], hits: number[]): void {
		const hitSet = new Set(hits);
		drawn.forEach((n, i) => {
			const cell = this.getCell(n);
			if (!cell) return;
			const timeout = window.setTimeout(() => {
				cell.classList.add('drawn');
				if (hitSet.has(n)) cell.classList.add('hit');
			}, i * 60);
			this.revealTimeouts.push(timeout);
		});
	}
	clearDrawnHighlight(): void {
		for (const timeout of this.revealTimeouts) window.clearTimeout(timeout);
		this.revealTimeouts = [];
		this.getAllCells().forEach((cell) => {
			cell.classList.remove('drawn', 'hit');
		});
	}
	renderRecent(history: DrawResult[]): void {
		this.recentEl.replaceChildren();
		history.slice(0, 10).forEach((r) => {
			const row = document.createElement('div');
			row.className = 'recent-ticket';
			const sign = r.netDelta > 0 ? '+' : '';
			row.textContent = `${r.spots}p ${r.hitCount}hit ${sign}${r.netDelta}`;
			this.recentEl.appendChild(row);
		});
	}
	renderPaytable(spots: number): void {
		const tiers = PAYTABLE[spots] ?? {};
		const table = document.createElement('table');
		table.className = 'w-full text-sm';
		const tbody = document.createElement('tbody');
		for (const [k, v] of Object.entries(tiers)) {
			const tr = document.createElement('tr');
			const tdLabel = document.createElement('td');
			tdLabel.className = 'py-2';
			tdLabel.textContent = `Catch ${k}`;
			const tdMult = document.createElement('td');
			tdMult.className = 'text-right py-2 text-[var(--deco-brass)]';
			tdMult.textContent = `×${v}`;
			tr.append(tdLabel, tdMult);
			tbody.appendChild(tr);
		}
		table.appendChild(tbody);
		this.paytableBody.replaceChildren(table);
	}
}

function req<T extends El>(root: El, testId: string): T {
	const el = root.querySelector<El>(`[data-testid="${testId}"]`);
	if (!el) throw new Error(`KenoUIRenderer: missing [data-testid="${testId}"]`);
	return el as T;
}
