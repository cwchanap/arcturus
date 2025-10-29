/**
 * Profile page form handlers
 * Manages form submission, validation, and UI feedback
 */

import type { AiState } from './profile-ui-state';
import type { LlmSettingsPayload } from './profile-api';
import { saveLlmSettings } from './profile-api';

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
	feedbackEl.classList.remove('text-emerald-400', 'text-rose-400', 'text-slate-400');
	if (tone === 'success') {
		feedbackEl.classList.add('text-emerald-400');
	} else if (tone === 'error') {
		feedbackEl.classList.add('text-rose-400');
	} else {
		feedbackEl.classList.add('text-slate-400');
	}
}

/**
 * Populate model dropdown based on provider
 */
export function populateModels(
	modelSelect: HTMLSelectElement | null,
	provider: string,
	desiredModel: string,
	modelOptions: Record<string, string[]>,
	modelLabels: Record<string, string>,
): void {
	if (!modelSelect) return;

	const models = Array.isArray(modelOptions?.[provider]) ? modelOptions[provider] : [];
	modelSelect.innerHTML = '';

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

/**
 * Handle form submission for AI settings
 */
export async function handleAiSettingsSubmit(
	event: SubmitEvent,
	aiState: AiState,
	providerSelect: HTMLSelectElement | null,
	modelSelect: HTMLSelectElement | null,
	apiKeyInput: HTMLInputElement | null,
	clearKeyRequested: boolean,
	feedbackEl: HTMLElement | null,
	onSuccess: (updatedState: Partial<AiState>) => void,
): Promise<void> {
	event.preventDefault();
	if (!providerSelect || !modelSelect) return;

	const currentProvider = providerSelect.value;
	const apiKeyValue = apiKeyInput?.value.trim() ?? '';

	// Ignore masked placeholder - treat it as empty
	const isMaskedPlaceholder = apiKeyValue.length > 0 && /^•+$/.test(apiKeyValue);
	const actualKeyValue = isMaskedPlaceholder ? '' : apiKeyValue;

	// Build payload
	const payload: LlmSettingsPayload = {
		provider: currentProvider,
		model: modelSelect.value,
	};

	// Include API key if: user entered a new value OR explicitly requested to clear
	if ((actualKeyValue.length > 0 && !isMaskedPlaceholder) || clearKeyRequested) {
		if (currentProvider === 'openai') {
			payload.openaiApiKey = actualKeyValue;
		} else if (currentProvider === 'gemini') {
			payload.geminiApiKey = actualKeyValue;
		}
	}

	setFeedback(feedbackEl, 'Saving…', 'neutral');

	try {
		const data = await saveLlmSettings(payload);
		const updated = data?.settings ?? {};

		const updatedState: Partial<AiState> = {
			provider: updated.provider ?? payload.provider,
			model: updated.model ?? payload.model,
			hasOpenaiKey: Boolean(updated.hasOpenaiKey),
			hasGeminiKey: Boolean(updated.hasGeminiKey),
		};

		onSuccess(updatedState);
		setFeedback(feedbackEl, 'Rival preferences saved', 'success');
	} catch (error) {
		console.error('Failed to save AI rival settings:', error);
		setFeedback(feedbackEl, 'Could not save preferences', 'error');
	}
}
