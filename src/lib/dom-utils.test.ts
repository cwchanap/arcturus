/**
 * Unit tests for dom-utils
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import {
	clearChildren,
	createTextSpan,
	createScoreboardDot,
	createBetChip,
	createBetResult,
} from './dom-utils';

// Mock document.createElement and related DOM APIs
const mockElements: any[] = [];

beforeEach(() => {
	// Clear mock elements array
	mockElements.length = 0;

	// Mock document.createElement
	global.document = {
		createElement: (tagName: string) => {
			const element: any = {
				tagName: tagName.toUpperCase(),
				className: '',
				textContent: '',
				children: [],
				classList: {
					add: function (...classes: string[]) {
						this.className = classes.join(' ');
					},
					contains: function (cls: string) {
						return this.className.split(' ').includes(cls);
					},
					remove: function (...classes: string[]) {
						const currentClasses = this.className.split(' ');
						this.className = currentClasses.filter((cls) => !classes.includes(cls)).join(' ');
					},
				},
				appendChild: function (child: any) {
					this.children.push(child);
				},
				replaceChildren: function () {
					this.children.length = 0;
				},
				querySelector: function (selector: string) {
					// Handle nth-child selector
					if (selector.includes(':nth-child(2)')) {
						return this.children[1] || null;
					}
					// Simple mock - just return first child if any
					return this.children[0] || null;
				},
				querySelectorAll: function (selector: string) {
					return this.children;
				},
			};

			mockElements.push(element);
			return element;
		},
	} as any;
});

describe('dom-utils', () => {
	describe('clearChildren', () => {
		test('should clear all children from element', () => {
			const element = document.createElement('div');

			// Add some children
			element.appendChild(document.createElement('span'));
			element.appendChild(document.createElement('div'));

			expect(element.children.length).toBe(2);

			clearChildren(element);

			expect(element.children.length).toBe(0);
		});

		test('should handle empty element', () => {
			const element = document.createElement('div');

			expect(() => clearChildren(element)).not.toThrow();
			expect(element.children.length).toBe(0);
		});
	});

	describe('createTextSpan', () => {
		test('should create span with text content', () => {
			const span = createTextSpan('Hello World');

			expect(span.tagName).toBe('SPAN');
			expect(span.textContent).toBe('Hello World');
			expect(span.className).toBe('');
		});

		test('should create span with className', () => {
			const span = createTextSpan('Test', 'test-class another-class');

			expect(span.tagName).toBe('SPAN');
			expect(span.textContent).toBe('Test');
			expect(span.className).toBe('test-class another-class');
		});

		test('should handle empty text', () => {
			const span = createTextSpan('');

			expect(span.textContent).toBe('');
		});

		test('should handle special characters', () => {
			const span = createTextSpan('<script>alert("xss")</script>');

			expect(span.textContent).toBe('<script>alert("xss")</script>');
		});
	});

	describe('createScoreboardDot', () => {
		test('should create player dot', () => {
			const dot = createScoreboardDot('player');

			expect(dot.tagName).toBe('SPAN');
			expect(dot.textContent).toBe('P');
			expect(dot.className).toBe('scoreboard-dot bg-blue-500');
		});

		test('should create banker dot', () => {
			const dot = createScoreboardDot('banker');

			expect(dot.tagName).toBe('SPAN');
			expect(dot.textContent).toBe('B');
			expect(dot.className).toBe('scoreboard-dot bg-red-500');
		});

		test('should create tie dot', () => {
			const dot = createScoreboardDot('tie');

			expect(dot.tagName).toBe('SPAN');
			expect(dot.textContent).toBe('T');
			expect(dot.className).toBe('scoreboard-dot bg-green-500');
		});
	});

	describe('createBetChip', () => {
		test('should create bet chip with amount', () => {
			const chip = createBetChip('Player', 100);

			expect(chip.tagName).toBe('DIV');
			expect(chip.className).toBe('bet-chip');

			const spans = chip.querySelectorAll('span');
			expect(spans.length).toBe(2);

			expect(spans[0].textContent).toBe('Player');
			expect(spans[0].className).toBe('');

			expect(spans[1].textContent).toBe('$100');
			expect(spans[1].className).toBe('text-yellow-400');
		});

		test('should handle zero amount', () => {
			const chip = createBetChip('Banker', 0);

			const amountSpan = chip.querySelector('span:nth-child(2)') as HTMLSpanElement;
			expect(amountSpan.textContent).toBe('$0');
		});

		test('should handle large amount', () => {
			const chip = createBetChip('Tie', 1000000);

			const amountSpan = chip.querySelector('span:nth-child(2)') as HTMLSpanElement;
			expect(amountSpan.textContent).toBe('$1000000');
		});
	});

	describe('createBetResult', () => {
		test('should create win result', () => {
			const result = createBetResult('Player', 'win', 200);

			expect(result.tagName).toBe('DIV');
			expect(result.className).toBe('bet-result');

			const spans = result.querySelectorAll('span');
			expect(spans.length).toBe(3);

			expect(spans[0].textContent).toBe('Player');
			expect(spans[0].className).toBe('');

			expect(spans[1].textContent).toBe('WIN');
			expect(spans[1].className).toBe('text-green-400');

			expect(spans[2].textContent).toBe('+$200');
			expect(spans[2].className).toBe('text-green-400');
		});

		test('should create lose result', () => {
			const result = createBetResult('Banker', 'lose', -100);

			const spans = result.querySelectorAll('span');

			expect(spans[0].textContent).toBe('Banker');
			expect(spans[1].textContent).toBe('LOSE');
			expect(spans[1].className).toBe('text-red-400');

			expect(spans[2].textContent).toBe('-$100');
			expect(spans[2].className).toBe('text-red-400');
		});

		test('should create push result', () => {
			const result = createBetResult('Tie', 'push', 0);

			const spans = result.querySelectorAll('span');

			expect(spans[0].textContent).toBe('Tie');
			expect(spans[1].textContent).toBe('PUSH');
			expect(spans[1].className).toBe('text-yellow-400');

			expect(spans[2].textContent).toBe('+$0');
			expect(spans[2].className).toBe('text-yellow-400');
		});

		test('should handle negative payout for win (edge case)', () => {
			const result = createBetResult('Player', 'win', -50);

			const spans = result.querySelectorAll('span');
			expect(spans[2].textContent).toBe('-$50');
			expect(spans[2].className).toBe('text-green-400');
		});

		test('should handle positive payout for lose (edge case)', () => {
			const result = createBetResult('Banker', 'lose', 50);

			const spans = result.querySelectorAll('span');
			expect(spans[2].textContent).toBe('+$50');
			expect(spans[2].className).toBe('text-red-400');
		});

		test('should handle large payout amounts', () => {
			const result = createBetResult('Player', 'win', 500000);

			const spans = result.querySelectorAll('span');
			expect(spans[2].textContent).toBe('+$500000');
		});

		test('should handle decimal payout amounts', () => {
			const result = createBetResult('Banker', 'win', 95.5);

			const spans = result.querySelectorAll('span');
			expect(spans[2].textContent).toBe('+$95.5');
		});
	});
});
