/**
 * DOM utility functions for safe element creation without innerHTML
 * Note: Card creation has moved to card-slot-utils.ts which uses pre-rendered slots
 */

/**
 * Clear all children from an element safely
 */
export function clearChildren(element: Element): void {
	element.replaceChildren();
}

/**
 * Create a text span element
 */
export function createTextSpan(text: string, className?: string): HTMLSpanElement {
	const span = document.createElement('span');
	if (className) span.className = className;
	span.textContent = text;
	return span;
}

/**
 * Create a scoreboard dot for baccarat
 */
export function createScoreboardDot(winner: 'player' | 'banker' | 'tie'): HTMLSpanElement {
	const colorMap = {
		player: 'bg-blue-500',
		banker: 'bg-red-500',
		tie: 'bg-green-500',
	};
	const labelMap = {
		player: 'P',
		banker: 'B',
		tie: 'T',
	};

	const dot = document.createElement('span');
	dot.className = `scoreboard-dot ${colorMap[winner]}`;
	dot.textContent = labelMap[winner];
	return dot;
}

/**
 * Create a bet chip display element
 */
export function createBetChip(typeLabel: string, amount: number): HTMLDivElement {
	const chip = document.createElement('div');
	chip.className = 'bet-chip';

	const labelSpan = document.createElement('span');
	labelSpan.textContent = typeLabel;

	const amountSpan = document.createElement('span');
	amountSpan.className = 'text-yellow-400';
	amountSpan.textContent = `$${amount}`;

	chip.appendChild(labelSpan);
	chip.appendChild(amountSpan);
	return chip;
}

/**
 * Create a bet result element for baccarat
 */
export function createBetResult(
	typeLabel: string,
	outcome: 'win' | 'lose' | 'push',
	payout: number,
): HTMLDivElement {
	const outcomeClassMap = {
		win: 'text-green-400',
		lose: 'text-red-400',
		push: 'text-yellow-400',
	};
	const outcomeClass = outcomeClassMap[outcome];
	const payoutPrefix = payout >= 0 ? '+' : '';

	const result = document.createElement('div');
	result.className = 'bet-result';

	const typeSpan = document.createElement('span');
	typeSpan.textContent = typeLabel;

	const outcomeSpan = document.createElement('span');
	outcomeSpan.className = outcomeClass;
	outcomeSpan.textContent = outcome.toUpperCase();

	const payoutSpan = document.createElement('span');
	payoutSpan.className = outcomeClass;
	payoutSpan.textContent = `${payoutPrefix}$${payout}`;

	result.appendChild(typeSpan);
	result.appendChild(outcomeSpan);
	result.appendChild(payoutSpan);
	return result;
}
