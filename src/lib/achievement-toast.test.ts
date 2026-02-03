import { describe, expect, test } from 'bun:test';
import { initAchievementToast } from './achievement-toast';

type MockElement = {
	textContent: string;
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

			enqueue([{ id: 'winner', name: 'High Roller', icon: '🏆' }]);

			expect(icon.textContent).toBe('🏆');
			expect(name.textContent).toBe('High Roller');
			expect(toast.classList.has('opacity-100')).toBe(true);
			expect(toast.classList.has('translate-y-0')).toBe(true);
		} finally {
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

			enqueue([{ id: 'winner', name: 'High Roller', icon: '🏆' }]);

			const [hideToast, finishToast] = timers;
			hideToast?.();
			expect(toast.classList.has('opacity-0')).toBe(true);
			expect(toast.classList.has('translate-y-4')).toBe(true);

			finishToast?.();
		} finally {
			global.setTimeout = originalSetTimeout;
		}
	});
});
