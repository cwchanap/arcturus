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

export type AchievementToastController = {
	enqueue: (achievements: AchievementToastEntry[]) => void;
	dispose: () => void;
};

export function initAchievementToast(
	getElements: () => AchievementToastElements,
	options: AchievementToastOptions = {},
): AchievementToastController {
	const { showDurationMs = 4000, transitionDurationMs = 300 } = options;
	const queue: AchievementToastEntry[] = [];
	let isShowing = false;
	let isDisposed = false;
	const timeoutIds: number[] = [];

	const clearPendingTimeouts = () => {
		timeoutIds.forEach((id) => clearTimeout(id));
		timeoutIds.length = 0;
	};

	const safeGetElements = (): AchievementToastElements | null => {
		const elements = getElements();
		if (
			!elements.toast?.isConnected ||
			!elements.icon?.isConnected ||
			!elements.name?.isConnected
		) {
			return null;
		}
		return elements;
	};

	const showNextToast = () => {
		if (isDisposed || isShowing || queue.length === 0) return;

		const elements = safeGetElements();
		if (!elements) {
			queue.length = 0;
			isShowing = false;
			return;
		}

		const { toast, icon, name } = elements;
		const achievement = queue.shift();
		if (!achievement) return;
		isShowing = true;

		icon.textContent = achievement.icon;
		name.textContent = achievement.name;

		toast.classList.remove('opacity-0', 'pointer-events-none', 'translate-y-4');
		toast.classList.add('opacity-100', 'translate-y-0');

		const hideTimeoutId = setTimeout(() => {
			if (isDisposed) return;

			const currentElements = safeGetElements();
			if (!currentElements) {
				isShowing = false;
				queue.length = 0;
				return;
			}

			const { toast: currentToast, icon: _currentIcon, name: _currentName } = currentElements;

			currentToast.classList.add('opacity-0', 'pointer-events-none', 'translate-y-4');
			currentToast.classList.remove('opacity-100', 'translate-y-0');

			const nextTimeoutId = setTimeout(() => {
				if (isDisposed) return;

				isShowing = false;
				if (queue.length === 0) {
					const finalElements = safeGetElements();
					if (finalElements) {
						finalElements.icon.textContent = '';
						finalElements.name.textContent = '';
						finalElements.toast.classList.add('opacity-0', 'pointer-events-none', 'translate-y-4');
						finalElements.toast.classList.remove('opacity-100', 'translate-y-0');
					}
				}
				showNextToast();
			}, transitionDurationMs);
			timeoutIds.push(nextTimeoutId);
		}, showDurationMs);
		timeoutIds.push(hideTimeoutId);
	};

	return {
		enqueue: (achievements: AchievementToastEntry[]) => {
			if (isDisposed) return;
			queue.push(...achievements);
			showNextToast();
		},
		dispose: () => {
			isDisposed = true;
			clearPendingTimeouts();
			queue.length = 0;
			isShowing = false;
		},
	};
}
