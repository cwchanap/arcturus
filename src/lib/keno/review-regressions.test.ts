import { describe, expect, test } from 'bun:test';
import { KenoUIRenderer } from './KenoUIRenderer';

class FakeClassList {
	private readonly values = new Set<string>();

	add(...tokens: string[]): void {
		for (const token of tokens) this.values.add(token);
	}

	remove(...tokens: string[]): void {
		for (const token of tokens) this.values.delete(token);
	}

	contains(token: string): boolean {
		return this.values.has(token);
	}
}

describe('CodeRabbit regression coverage', () => {
	test('cancels pending reveal callbacks before clearing drawn highlights', () => {
		const cell = { classList: new FakeClassList() };
		const renderer = Object.create(KenoUIRenderer.prototype) as KenoUIRenderer;
		const subject = renderer as unknown as {
			revealTimeouts: number[];
			getCell: (number: number) => HTMLButtonElement | null;
			getAllCells: () => HTMLButtonElement[];
			highlightDrawn: (drawn: number[], hits: number[]) => void;
			clearDrawnHighlight: () => void;
		};
		subject.revealTimeouts = [];
		subject.getCell = () => cell as unknown as HTMLButtonElement;
		subject.getAllCells = () => [cell as unknown as HTMLButtonElement];

		const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
		const callbacks = new Map<number, () => void>();
		let nextId = 1;
		Object.defineProperty(globalThis, 'window', {
			configurable: true,
			value: {
				setTimeout: (callback: () => void) => {
					const id = nextId++;
					callbacks.set(id, callback);
					return id;
				},
				clearTimeout: (id: number) => {
					callbacks.delete(id);
				},
			},
		});

		try {
			subject.highlightDrawn([7], [7]);
			expect(callbacks.size).toBe(1);

			subject.clearDrawnHighlight();
			for (const callback of callbacks.values()) callback();

			expect(callbacks.size).toBe(0);
			expect(cell.classList.contains('drawn')).toBe(false);
			expect(cell.classList.contains('hit')).toBe(false);
		} finally {
			if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
			else Reflect.deleteProperty(globalThis, 'window');
		}
	});
});
