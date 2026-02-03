export type AchievementToastEntry = {
	id: string;
	name: string;
	icon: string;
};

export type AchievementToastElements = {
	toast: HTMLElement | null;
	icon: HTMLElement | null;
	name: HTMLElement | null;
};

export type AchievementToastOptions = {
	showDurationMs?: number;
	transitionDurationMs?: number;
};

export function initAchievementToast(
	getElements: () => AchievementToastElements,
	options: AchievementToastOptions = {},
): { enqueue: (achievements: AchievementToastEntry[]) => void } {
	const { showDurationMs = 4000, transitionDurationMs = 300 } = options;
	const { toast, icon, name } = getElements();

	const queue: AchievementToastEntry[] = [];
	let isShowing = false;

	const showNextToast = () => {
		if (isShowing || queue.length === 0) return;

		isShowing = true;
		const achievement = queue.shift();
		if (!achievement) return;

		if (icon) icon.textContent = achievement.icon;
		if (name) name.textContent = achievement.name;

		if (toast) {
			toast.classList.remove('opacity-0', 'pointer-events-none', 'translate-y-4');
			toast.classList.add('opacity-100', 'translate-y-0');
		}

		setTimeout(() => {
			if (toast) {
				toast.classList.add('opacity-0', 'pointer-events-none', 'translate-y-4');
				toast.classList.remove('opacity-100', 'translate-y-0');
			}

			setTimeout(() => {
				isShowing = false;
				showNextToast();
			}, transitionDurationMs);
		}, showDurationMs);
	};

	return {
		enqueue: (achievements: AchievementToastEntry[]) => {
			queue.push(...achievements);
			showNextToast();
		},
	};
}
