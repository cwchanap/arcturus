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
 * Create a bet chip display element. The amount text is pre-formatted by the
 * caller (localized chip phrase) so this shared helper stays locale-free.
 */
export function createBetChip(typeLabel: string, amountText: string): HTMLDivElement {
	const chip = document.createElement('div');
	chip.className = 'bet-chip';

	const labelSpan = document.createElement('span');
	labelSpan.textContent = typeLabel;

	const amountSpan = document.createElement('span');
	amountSpan.className = 'text-yellow-400';
	amountSpan.textContent = amountText;

	chip.appendChild(labelSpan);
	chip.appendChild(amountSpan);
	return chip;
}

/**
 * Create a bet result element for baccarat. Outcome word and payout text are
 * pre-formatted by the caller (localized); the outcome code still selects the
 * result color.
 */
export function createBetResult(
	typeLabel: string,
	outcomeCode: 'win' | 'lose' | 'push',
	outcomeText: string,
	payoutText: string,
): HTMLDivElement {
	const outcomeClassMap = {
		win: 'text-green-400',
		lose: 'text-red-400',
		push: 'text-yellow-400',
	};
	const outcomeClass = outcomeClassMap[outcomeCode];

	const result = document.createElement('div');
	result.className = 'bet-result';

	const typeSpan = document.createElement('span');
	typeSpan.textContent = typeLabel;

	const outcomeSpan = document.createElement('span');
	outcomeSpan.className = outcomeClass;
	outcomeSpan.textContent = outcomeText;

	const payoutSpan = document.createElement('span');
	payoutSpan.className = outcomeClass;
	payoutSpan.textContent = payoutText;

	result.appendChild(typeSpan);
	result.appendChild(outcomeSpan);
	result.appendChild(payoutSpan);
	return result;
}
