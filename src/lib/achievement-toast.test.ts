import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { initAchievementToast } from './achievement-toast';

type MockElement = {
	textContent: string;
	isConnected: boolean;
	classList: {
		add: (...classes: string[]) => void;
		remove: (...classes: string[]) => void;
		has: (cls: string) => boolean;
	};
};

const createMockElement = (): MockElement => {
	const classes = new Set<string>();
	return {
		textContent: '',
		isConnected: true,
		classList: {
			add: (...newClasses: string[]) => {
				for (const cls of newClasses) classes.add(cls);
			},
			remove: (...removeClasses: string[]) => {
				for (const cls of removeClasses) classes.delete(cls);
			},
			has: (cls: string) => classes.has(cls),
		},
	};
};

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const happyWindow = new Window();

beforeAll(() => {
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		writable: true,
		value: happyWindow,
	});
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		writable: true,
		value: happyWindow.document,
	});
});

afterAll(() => {
	happyWindow.close();
	if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
	else Reflect.deleteProperty(globalThis, 'window');
	if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
	else Reflect.deleteProperty(globalThis, 'document');
});

describe('initAchievementToast', () => {
	test('shows toast and sets text on enqueue', () => {
		const originalSetTimeout = global.setTimeout;
		const timers: Array<() => void> = [];
		global.setTimeout = ((callback: () => void) => {
			timers.push(callback);
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;

		try {
			const toast = createMockElement();
			const icon = createMockElement();
			const name = createMockElement();

			const { enqueue } = initAchievementToast(() => ({
				toast: toast as unknown as HTMLElement,
				icon: icon as unknown as HTMLElement,
				name: name as unknown as HTMLElement,
			}));

			enqueue([{ id: 'high_roller', icon: '🏆' }]);

			expect(icon.textContent).toBe('🏆');
			expect(name.textContent).toBe('High Roller');
			expect(toast.classList.has('opacity-100')).toBe(true);
			expect(toast.classList.has('translate-y-0')).toBe(true);
		} finally {
			global.setTimeout = originalSetTimeout;
		}
	});

	test('resolves the displayed name from the document locale using id/icon-only entries', () => {
		const originalSetTimeout = global.setTimeout;
		const timers: Array<() => void> = [];
		global.setTimeout = ((callback: () => void) => {
			timers.push(callback);
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		happyWindow.document.documentElement.dataset.locale = 'ja';

		try {
			const toast = createMockElement();
			const icon = createMockElement();
			const name = createMockElement();

			const { enqueue } = initAchievementToast(() => ({
				toast: toast as unknown as HTMLElement,
				icon: icon as unknown as HTMLElement,
				name: name as unknown as HTMLElement,
			}));

			enqueue([{ id: 'high_roller', icon: '🏆' }]);

			expect(icon.textContent).toBe('🏆');
			expect(name.textContent).toBe('ハイローラー');
		} finally {
			delete happyWindow.document.documentElement.dataset.locale;
			global.setTimeout = originalSetTimeout;
		}
	});

	test('hides toast after timeout callbacks run', () => {
		const originalSetTimeout = global.setTimeout;
		const timers: Array<() => void> = [];
		global.setTimeout = ((callback: () => void) => {
			timers.push(callback);
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;

		try {
			const toast = createMockElement();
			const icon = createMockElement();
			const name = createMockElement();

			const { enqueue } = initAchievementToast(() => ({
				toast: toast as unknown as HTMLElement,
				icon: icon as unknown as HTMLElement,
				name: name as unknown as HTMLElement,
			}));

			enqueue([{ id: 'high_roller', icon: '🏆' }]);

			const calledTimers = new Set<number>();
			let hideToastIndex = -1;
			for (let i = 0; i < timers.length; i++) {
				const hadHidden = toast.classList.has('opacity-0');
				timers[i]();
				calledTimers.add(i);
				if (!hadHidden && toast.classList.has('opacity-0')) {
					hideToastIndex = i;
					break;
				}
			}

			expect(hideToastIndex).not.toBe(-1);
			expect(toast.classList.has('opacity-0')).toBe(true);
			expect(toast.classList.has('translate-y-4')).toBe(true);

			expect(timers.length).toBe(2);
			// Find a timer that hasn't been called yet
			let finishToastIndex = -1;
			for (let i = 0; i < timers.length; i++) {
				if (!calledTimers.has(i)) {
					finishToastIndex = i;
					break;
				}
			}
			// If all timers were called, there's nothing to finish
			if (finishToastIndex !== -1) {
				const finishToast = timers[finishToastIndex];
				expect(finishToast).toBeDefined();
				finishToast();
			}

			expect(icon.textContent).toBe('');
			expect(name.textContent).toBe('');
			expect(toast.classList.has('opacity-100')).toBe(false);
			expect(toast.classList.has('translate-y-0')).toBe(false);
		} finally {
			global.setTimeout = originalSetTimeout;
		}
	});
});
