/**
 * Profile page form handlers
 * Manages form submission, validation, and UI feedback
 */

import { clearAiSettings, loadAiSettings, saveAiSettings, type AiSettings } from './ai';

export function readCurrentAiSettings(): AiSettings | null {
	return loadAiSettings();
}

export function saveAiSettingsFromForm(
	provider: AiSettings['provider'],
	model: string,
	apiKeyInput: string,
	previous: AiSettings | null,
): AiSettings {
	const masked = /^•+$/.test(apiKeyInput);
	if (masked) {
		// A masked field is a display artifact, never persistence data. It is
		// only valid when it represents the previous key for the same provider.
		if (previous?.provider === provider) {
			const next = { provider, model, apiKey: previous.apiKey };
			saveAiSettings(next);
			return next;
		}
		throw new Error('API key required');
	}
	const next = { provider, model, apiKey: apiKeyInput.trim() };
	saveAiSettings(next);
	return next;
}

export function clearAiSettingsFromForm(): void {
	clearAiSettings();
}

/**
 * Show toast notification
 */
export function showToast(
	toastEl: HTMLElement | null,
	toastMessage: HTMLElement | null,
	message: string,
): void {
	if (!toastEl || !toastMessage) return;

	toastMessage.textContent = message;
	toastEl.classList.remove('opacity-0', 'pointer-events-none', 'translate-y-2');
	toastEl.classList.add('opacity-100', 'translate-y-0');

	setTimeout(() => {
		toastEl.classList.add('opacity-0', 'pointer-events-none', 'translate-y-2');
		toastEl.classList.remove('opacity-100', 'translate-y-0');
	}, 3000);
}

/**
 * Set feedback message with tone
 */
export function setFeedback(
	feedbackEl: HTMLElement | null,
	message: string,
	tone: 'neutral' | 'success' | 'error' = 'neutral',
): void {
	if (!feedbackEl) return;

	feedbackEl.textContent = message;
	feedbackEl.classList.remove(
		'deco-muted-text',
		'text-[var(--deco-mint)]',
		'text-[var(--deco-rose)]',
		'text-[var(--deco-ivory-dim)]',
	);
	if (tone === 'success') {
		feedbackEl.classList.add('text-[var(--deco-mint)]');
	} else if (tone === 'error') {
		feedbackEl.classList.add('text-[var(--deco-rose)]');
	} else {
		feedbackEl.classList.add('text-[var(--deco-ivory-dim)]');
	}
}

/**
 * Populate model dropdown based on provider
 */
export function populateModels(
	modelSelect: HTMLSelectElement | null,
	provider: string,
	desiredModel: string,
	modelOptions: Readonly<Record<string, readonly string[]>>,
	modelLabels: Record<string, string>,
): void {
	if (!modelSelect) return;

	const models = Array.isArray(modelOptions?.[provider]) ? modelOptions[provider] : [];
	modelSelect.replaceChildren();

	models.forEach((model) => {
		const option = document.createElement('option');
		option.value = model;
		option.textContent = modelLabels?.[model] ?? model;
		if (model === desiredModel) {
			option.selected = true;
		}
		modelSelect.appendChild(option);
	});

	if (models.length > 0 && !models.includes(desiredModel)) {
		modelSelect.value = models[0];
	}
}
