import { formatChipBalance } from '../formatting';
import { getDocumentLocale } from '../i18n/locale';
import { formatChips } from '../i18n/messages/common';
import { slotsTranslator, getSlotsSymbolLabel, formatSlotsNet } from '../i18n/messages/slots';
import { formatWholeNumber } from '../formatting';
import {
	MAX_HISTORY,
	NUM_REELS,
	NUM_ROWS,
	PAYLINES,
	SYMBOLS,
	getSpinDurationMs,
} from './constants';
import type { LineWin, ReelGrid, SpinResult, SlotSettings } from './types';

export class SlotsUIRenderer {
	private readonly locale = getDocumentLocale();
	private readonly t = slotsTranslator(this.locale);
	private achievementHideTimer: ReturnType<typeof setTimeout> | null = null;
	setSpinEnabled(enabled: boolean): void {
		const btn = document.getElementById('btn-spin') as HTMLButtonElement | null;
		if (btn) btn.disabled = !enabled;
	}

	renderBalance(balance: number): void {
		const el = document.getElementById('chip-balance');
		if (el) el.textContent = formatChipBalance(balance, this.locale);
	}

	renderBet(bet: number): void {
		const el = document.getElementById('current-bet');
		if (el) el.textContent = formatChips(bet, this.locale);
		document.querySelectorAll<HTMLButtonElement>('.bet-chip').forEach((chip) => {
			const active = Number(chip.dataset.bet) === bet;
			chip.classList.toggle('selected', active);
			chip.setAttribute('aria-pressed', active ? 'true' : 'false');
		});
	}

	renderGrid(grid: ReelGrid): void {
		for (let reel = 0; reel < NUM_REELS; reel++) {
			for (let row = 0; row < NUM_ROWS; row++) {
				const cell = document.querySelector<HTMLElement>(
					`.symbol-cell[data-reel="${reel}"][data-row="${row}"]`,
				);
				const glyph = cell?.querySelector<HTMLElement>('.symbol-glyph');
				if (glyph) glyph.textContent = SYMBOLS[grid[reel][row]].glyph;
			}
		}
	}

	clearHighlight(): void {
		document.querySelectorAll('.symbol-cell.win').forEach((c) => c.classList.remove('win'));
	}

	highlightWins(lineWins: LineWin[]): void {
		this.clearHighlight();
		for (const win of lineWins) {
			const payline = PAYLINES[win.paylineIndex];
			for (let reel = 0; reel < win.count; reel++) {
				const row = payline[reel];
				const cell = document.querySelector<HTMLElement>(
					`.symbol-cell[data-reel="${reel}"][data-row="${row}"]`,
				);
				cell?.classList.add('win');
			}
		}
	}

	setSpinning(isSpinning: boolean): void {
		document
			.querySelectorAll<HTMLElement>('.reel')
			.forEach((r) => r.classList.toggle('spinning', isSpinning));
	}

	showStatus(message: string | null): void {
		const el = document.getElementById('game-status');
		if (!el) return;
		if (message) {
			el.textContent = message;
			el.classList.remove('hidden');
		} else {
			el.classList.add('hidden');
		}
	}

	renderResult(result: SpinResult): void {
		const lastResult = document.getElementById('last-result');
		const lastWin = document.getElementById('last-win');
		if (result.lineWins.length > 0) {
			const top = result.lineWins.reduce((a, b) => (a.multiplier > b.multiplier ? a : b));
			if (lastResult) {
				lastResult.textContent = this.t('lineResult', {
					symbol: getSlotsSymbolLabel(this.locale, top.symbol),
					count: formatWholeNumber(top.count, this.locale),
					line: formatWholeNumber(top.paylineIndex + 1, this.locale),
				});
			}
			if (lastWin) {
				lastWin.textContent = this.t('winAmount', {
					amount: formatChips(result.payout, this.locale),
				});
				lastWin.style.color = 'var(--deco-jade)';
			}
		} else {
			if (lastResult) lastResult.textContent = this.t('noWin');
			if (lastWin) {
				lastWin.textContent = '';
			}
		}
	}

	renderRecent(history: SpinResult[]): void {
		const el = document.getElementById('recent-spins');
		if (!el) return;
		const recent = history.slice(0, MAX_HISTORY);
		el.replaceChildren();
		for (const h of recent) {
			const dot = document.createElement('span');
			dot.className = 'px-2 py-1 rounded text-xs font-semibold';
			dot.textContent = formatSlotsNet(this.locale, h.netDelta);
			if (h.netDelta > 0) {
				dot.style.color = 'var(--deco-jade)';
			} else if (h.netDelta < 0) {
				dot.style.color = 'var(--deco-oxblood-bright)';
			} else {
				dot.style.color = 'var(--deco-muted)';
			}
			el.appendChild(dot);
		}
	}

	getSpinDurationMs(settings: SlotSettings): number {
		return getSpinDurationMs(settings.spinSpeed);
	}

	showAchievement(text: string): void {
		const toast = document.getElementById('achievement-toast');
		if (!toast) return;
		toast.textContent = text;
		toast.classList.remove('hidden');
		// Clear the previous hide timer so a newer achievement isn't hidden
		// early by the older timer firing.
		if (this.achievementHideTimer !== null) {
			clearTimeout(this.achievementHideTimer);
		}
		this.achievementHideTimer = setTimeout(() => {
			toast.classList.add('hidden');
			this.achievementHideTimer = null;
		}, 4000);
	}
}
