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
	private readonly soundCheckbox: HTMLInputElement;
	private readonly paytableBtn: HTMLButtonElement;
	private readonly paytableModal: El;
	private readonly paytableCloseBtn: HTMLButtonElement;
	private readonly paytableModalBody: El;
	private revealTimeouts: number[] = [];
	private settingsFocusBefore: HTMLElement | null = null;
	private boundSettingsKeydown: ((e: KeyboardEvent) => void) | null = null;
	private paytableFocusBefore: HTMLElement | null = null;
	private boundPaytableKeydown: ((e: KeyboardEvent) => void) | null = null;

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
		this.soundCheckbox =
			root.querySelector<HTMLInputElement>('#setting-sound') ??
			(() => {
				throw new Error('KenoUIRenderer: missing #setting-sound');
			})();
		this.paytableBtn = req<HTMLButtonElement>(root, 'btn-paytable');
		this.paytableModal = req<El>(root, 'paytable-modal');
		this.paytableCloseBtn = req<HTMLButtonElement>(root, 'btn-paytable-close');
		this.paytableModalBody = req<El>(root, 'paytable-modal-body');
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
	getSoundCheckbox(): HTMLInputElement {
		return this.soundCheckbox;
	}
	getPaytableButton(): HTMLButtonElement {
		return this.paytableBtn;
	}
	getPaytableCloseButton(): HTMLButtonElement {
		return this.paytableCloseBtn;
	}
	renderSettingsSound(enabled: boolean): void {
		this.soundCheckbox.checked = enabled;
	}
	showSettingsModal(): void {
		this.settingsFocusBefore = document.activeElement as HTMLElement | null;
		this.settingsModal.classList.remove('hidden');
		this.settingsBtn.setAttribute('aria-expanded', 'true');
		// Focus the first focusable control so keyboard users land inside the modal.
		const focusable = this.settingsFocusables();
		focusable[0]?.focus();
		this.boundSettingsKeydown = (e: KeyboardEvent) => this.onSettingsKeydown(e);
		this.settingsModal.addEventListener('keydown', this.boundSettingsKeydown);
	}
	hideSettingsModal(): void {
		this.settingsModal.classList.add('hidden');
		this.settingsBtn.setAttribute('aria-expanded', 'false');
		if (this.boundSettingsKeydown) {
			this.settingsModal.removeEventListener('keydown', this.boundSettingsKeydown);
			this.boundSettingsKeydown = null;
		}
		// Restore focus to the trigger so keyboard users don't get stranded.
		this.settingsFocusBefore?.focus();
		this.settingsFocusBefore = null;
	}
	private settingsFocusables(): HTMLElement[] {
		return Array.from(
			this.settingsModal.querySelectorAll<HTMLElement>(
				'button, input, [tabindex]:not([tabindex="-1"])',
			),
		).filter((el) => !el.hasAttribute('disabled'));
	}
	private onSettingsKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') {
			e.preventDefault();
			this.hideSettingsModal();
			return;
		}
		if (e.key !== 'Tab') return;
		const focusable = this.settingsFocusables();
		if (focusable.length === 0) return;
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (e.shiftKey) {
			if (document.activeElement === first) {
				e.preventDefault();
				last.focus();
			}
		} else {
			if (document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		}
	}
	showPaytableModal(): void {
		this.paytableFocusBefore = document.activeElement as HTMLElement | null;
		this.paytableModal.classList.remove('hidden');
		this.paytableBtn.setAttribute('aria-expanded', 'true');
		// Focus the close button so keyboard users land inside the modal.
		this.paytableCloseBtn.focus();
		this.boundPaytableKeydown = (e: KeyboardEvent) => this.onPaytableKeydown(e);
		this.paytableModal.addEventListener('keydown', this.boundPaytableKeydown);
	}
	hidePaytableModal(): void {
		this.paytableModal.classList.add('hidden');
		this.paytableBtn.setAttribute('aria-expanded', 'false');
		if (this.boundPaytableKeydown) {
			this.paytableModal.removeEventListener('keydown', this.boundPaytableKeydown);
			this.boundPaytableKeydown = null;
		}
		// Restore focus to the trigger so keyboard users don't get stranded.
		this.paytableFocusBefore?.focus();
		this.paytableFocusBefore = null;
	}
	private paytableFocusables(): HTMLElement[] {
		return Array.from(
			this.paytableModal.querySelectorAll<HTMLElement>('button, [tabindex]:not([tabindex="-1"])'),
		).filter((el) => !el.hasAttribute('disabled'));
	}
	private onPaytableKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') {
			e.preventDefault();
			this.hidePaytableModal();
			return;
		}
		if (e.key !== 'Tab') return;
		const focusable = this.paytableFocusables();
		if (focusable.length === 0) return;
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (e.shiftKey) {
			if (document.activeElement === first) {
				e.preventDefault();
				last.focus();
			}
		} else {
			if (document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		}
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
		const amt = r.outcome === 'win' ? r.netDelta : r.outcome === 'loss' ? r.bet : null;
		this.lastResultEl.textContent =
			amt === null
				? `${r.hitCount} of ${r.spots} — ${verb} (bet returned)`
				: `${r.hitCount} of ${r.spots} ${verb} ${amt.toLocaleString()}`;
	}
	highlightDrawn(drawn: number[], hits: number[], staggerMs = 60): void {
		const hitSet = new Set(hits);
		drawn.forEach((n, i) => {
			const cell = this.getCell(n);
			if (!cell) return;
			const timeout = window.setTimeout(() => {
				cell.classList.add('drawn');
				if (hitSet.has(n)) cell.classList.add('hit');
			}, i * staggerMs);
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
		// Sidebar table (always visible) + modal table (shown on demand). The
		// clone keeps them in sync when the spot count changes while the modal
		// is open.
		this.paytableBody.replaceChildren(table);
		this.paytableModalBody.replaceChildren(table.cloneNode(true));
	}
	clearPaytable(): void {
		this.paytableBody.replaceChildren();
		this.paytableModalBody.replaceChildren();
	}
}

function req<T extends El>(root: El, testId: string): T {
	const el = root.querySelector<El>(`[data-testid="${testId}"]`);
	if (!el) throw new Error(`KenoUIRenderer: missing [data-testid="${testId}"]`);
	return el as T;
}
