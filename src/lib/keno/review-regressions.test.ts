import { describe, expect, test } from 'bun:test';
import { KenoSyncOutbox } from './outbox';
import type { PendingReceipt } from './outbox';
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

function receipt(): PendingReceipt {
	return {
		syncId: 'rate-limit-regression',
		previousBalance: 1000,
		delta: -5,
		gameType: 'keno',
		outcome: 'loss',
		handCount: 1,
		biggestWinCandidate: undefined,
	};
}

describe('CodeRabbit regression coverage', () => {
	test('bounds HTTP 429 retries and falls back for an invalid Retry-After header', async () => {
		let fetchCalls = 0;
		const delays: number[] = [];
		const outbox = new KenoSyncOutbox({
			fetchImpl: async () => {
				fetchCalls++;
				return {
					ok: false,
					status: 429,
					headers: { get: () => 'invalid' },
					json: async () => ({ error: 'RATE_LIMITED' }),
				};
			},
			endpoint: '/api/chips/update',
			persist: () => {},
			load: () => [],
			setServerSyncedBalance: () => {},
			setGameBalance: () => {},
			onHardError: () => {},
			onToast: () => {},
			maxNetworkRetries: 1,
			sleep: async (ms) => {
				delays.push(ms);
				if (delays.length > 1) throw new Error('429 retry was not bounded');
			},
		});

		await expect(outbox.enqueueAndDrain(receipt())).resolves.toBeUndefined();
		expect(fetchCalls).toBe(2);
		expect(delays).toEqual([1000]);
	});

	test('cancels pending reveal callbacks before clearing drawn highlights', () => {
		const cell = { classList: new FakeClassList() };
		const renderer = Object.create(KenoUIRenderer.prototype) as KenoUIRenderer;
		const subject = renderer as unknown as {
			getCell: (number: number) => HTMLButtonElement | null;
			getAllCells: () => HTMLButtonElement[];
			highlightDrawn: (drawn: number[], hits: number[]) => void;
			clearDrawnHighlight: () => void;
		};
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
