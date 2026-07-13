import type { RouletteGameState, SpinResult, RouletteBet } from './types';
import { WHEEL_ORDER, RED_NUMBERS } from './constants';

export class RouletteUIRenderer {
	private wheelEl: HTMLElement;
	private resultEl: HTMLElement;
	private balanceEl: HTMLElement;
	private totalBetEl: HTMLElement;
	private activeBetsEl: HTMLElement;
	private spinBtn: HTMLButtonElement;
	private clearBtn: HTMLButtonElement;
	private newRoundBtn: HTMLButtonElement;
	private phaseEl: HTMLElement;
	private wheelRotation = 0;

	constructor() {
		this.wheelEl = document.getElementById('roulette-wheel')!;
		this.resultEl = document.getElementById('wheel-result')!;
		this.balanceEl = document.getElementById('chip-balance')!;
		this.totalBetEl = document.getElementById('total-bet')!;
		this.activeBetsEl = document.getElementById('active-bets')!;
		this.spinBtn = document.getElementById('spin-button') as HTMLButtonElement;
		this.clearBtn = document.getElementById('clear-bets-button') as HTMLButtonElement;
		this.newRoundBtn = document.getElementById('new-round-button') as HTMLButtonElement;
		this.phaseEl = document.getElementById('game-phase')!;
	}

	update(state: RouletteGameState): void {
		this.balanceEl.textContent = `$${state.chipBalance.toLocaleString()}`;
		const totalBet = state.activeBets.reduce((s, b) => s + b.amount, 0);
		this.totalBetEl.textContent = `$${totalBet.toLocaleString()}`;

		this.renderActiveBets(state.activeBets);

		const canSpin = state.activeBets.length > 0 && state.phase === 'betting';
		this.spinBtn.disabled = !canSpin;
		this.clearBtn.disabled = state.activeBets.length === 0 || state.phase !== 'betting';

		if (state.phase === 'settled') {
			this.newRoundBtn.hidden = false;
			this.spinBtn.hidden = true;
		} else {
			this.newRoundBtn.hidden = true;
			this.spinBtn.hidden = false;
		}

		this.phaseEl.textContent =
			state.phase === 'betting'
				? 'Place Your Bets'
				: state.phase === 'spinning'
					? 'No More Bets'
					: state.phase === 'settled'
						? 'Round Complete'
						: '';

		if (state.phase === 'spinning') {
			this.spinBtn.disabled = true;
		}
	}

	private renderActiveBets(bets: RouletteBet[]): void {
		this.activeBetsEl.innerHTML = '';
		for (const bet of bets) {
			const div = document.createElement('div');
			div.id = `active-bet-${bet.id}`;
			div.className = 'flex items-center justify-between py-1 text-sm';
			const label = this.betLabel(bet);
			div.innerHTML = `<span>${label}</span><span class="text-[var(--deco-brass)]">$${bet.amount}</span>`;
			this.activeBetsEl.appendChild(div);
		}
	}

	private betLabel(bet: RouletteBet): string {
		switch (bet.type) {
			case 'straight':
				return `Straight ${bet.target}`;
			case 'red':
				return 'Red';
			case 'black':
				return 'Black';
			case 'odd':
				return 'Odd';
			case 'even':
				return 'Even';
			case 'low':
				return '1–18';
			case 'high':
				return '19–36';
			case 'dozen':
				return `${['1st', '2nd', '3rd'][bet.target!]} 12`;
			case 'column':
				return `Column ${bet.target! + 1}`;
		}
	}

	animateWheel(winningNumber: number): void {
		const SEGMENT = 360 / 37;
		const pocketIndex = (WHEEL_ORDER as readonly number[]).indexOf(winningNumber);
		const desiredAngle = -(pocketIndex * SEGMENT);
		const currentAngle = this.wheelRotation % 360;
		let forwardDelta = desiredAngle - currentAngle;
		while (forwardDelta < 0) forwardDelta += 360;
		this.wheelRotation += 5 * 360 + forwardDelta;
		this.wheelEl.style.transform = `rotate(${this.wheelRotation}deg)`;
	}

	showResult(spinResult: SpinResult): void {
		const n = spinResult.winningNumber;
		const color = n === 0 ? 'Green' : RED_NUMBERS.has(n) ? 'Red' : 'Black';
		this.resultEl.textContent = `${n} ${color}`;
		this.resultEl.setAttribute('aria-label', `Winning number: ${n} ${color}`);
	}

	getSelectedChipAmount(): number {
		const selected = document.querySelector('.chip-select.selected') as HTMLElement | null;
		if (selected) return Number(selected.dataset.amount);
		return 5;
	}

	setSelectedChip(amount: number): void {
		document.querySelectorAll('.chip-select').forEach((el) => {
			el.classList.toggle('selected', Number((el as HTMLElement).dataset.amount) === amount);
			(el as HTMLElement).setAttribute(
				'aria-pressed',
				String(Number((el as HTMLElement).dataset.amount) === amount),
			);
		});
	}
}
