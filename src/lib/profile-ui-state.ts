/**
 * Profile page UI state management
 * Handles API key visibility, masking, and UI updates
 */

export interface AiState {
	provider: string;
	model: string;
	hasOpenaiKey: boolean;
	hasGeminiKey: boolean;
}

export interface UiElements {
	apiKeyInput: HTMLInputElement | null;
	apiKeyLabel: HTMLElement | null;
	apiKeyStatus: HTMLElement | null;
	apiKeyHelp: HTMLElement | null;
	clearKeyButton: HTMLButtonElement | null;
	showKeyButton: HTMLButtonElement | null;
	hideKeyButton: HTMLButtonElement | null;
	copyKeyButton: HTMLButtonElement | null;
}

export class ProfileUiState {
	private revealedApiKey: string | null = null;
	private isKeyRevealed = false;
	private openaiKeyLength = 0;
	private geminiKeyLength = 0;

	constructor(
		private elements: UiElements,
		private aiState: AiState,
	) {}

	/**
	 * Update API key input UI based on provider and saved key state
	 */
	updateApiKeyUI(provider: string, clearInput = false): void {
		const {
			apiKeyLabel,
			apiKeyInput,
			apiKeyStatus,
			apiKeyHelp,
			clearKeyButton,
			showKeyButton,
			hideKeyButton,
			copyKeyButton,
		} = this.elements;

		if (!apiKeyLabel || !apiKeyInput || !apiKeyStatus || !apiKeyHelp) return;

		const isOpenAI = provider === 'openai';
		const hasKey = isOpenAI ? this.aiState.hasOpenaiKey : this.aiState.hasGeminiKey;

		// Update label and help text
		apiKeyLabel.textContent = isOpenAI ? 'OpenAI API Key' : 'Gemini API Key';
		apiKeyHelp.textContent = isOpenAI
			? 'Required for the GPT-4o rival. Keys are stored per account and never shown back in full.'
			: 'Used for Gemini Flash rivals. Leave blank to keep the previously stored key.';

		apiKeyInput.placeholder = isOpenAI ? 'sk-...' : 'AIza...';

		// Handle input value
		if (clearInput) {
			apiKeyInput.value = '';
		} else if (this.isKeyRevealed) {
			apiKeyInput.placeholder = 'Saved key (masked)';
		} else if (hasKey) {
			const keyLength = isOpenAI ? this.openaiKeyLength : this.geminiKeyLength;
			apiKeyInput.value = '•'.repeat(keyLength || 20);
			apiKeyInput.placeholder = 'Saved key (masked)';
		} else {
			apiKeyInput.value = '';
		}

		apiKeyStatus.textContent = hasKey ? 'Saved' : 'Not saved';

		// Toggle button visibility
		if (clearKeyButton) {
			clearKeyButton.style.display = hasKey ? 'inline-block' : 'none';
		}
		if (showKeyButton) {
			showKeyButton.style.display = hasKey && !this.isKeyRevealed ? 'block' : 'none';
		}
		if (hideKeyButton) {
			hideKeyButton.style.display = hasKey && this.isKeyRevealed ? 'block' : 'none';
		}
		if (copyKeyButton) {
			copyKeyButton.style.display = hasKey ? 'block' : 'none';
		}

		// Reset revealed state when clearing
		if (clearInput) {
			this.revealedApiKey = null;
			this.isKeyRevealed = false;
		}
	}

	/**
	 * Cache fetched API key and update key length for masking
	 */
	cacheApiKey(provider: string, apiKey: string): void {
		this.revealedApiKey = apiKey;
		if (provider === 'openai') {
			this.openaiKeyLength = apiKey.length;
		} else {
			this.geminiKeyLength = apiKey.length;
		}
	}

	/**
	 * Reveal cached or newly fetched API key
	 */
	async revealApiKey(
		provider: string,
		fetchFn: (provider: string) => Promise<string | null>,
	): Promise<boolean> {
		if (!this.revealedApiKey) {
			const apiKey = await fetchFn(provider);
			if (!apiKey) {
				console.error('Failed to fetch API key');
				alert('Failed to retrieve API key');
				return false;
			}
			this.cacheApiKey(provider, apiKey);
		}

		const { apiKeyInput } = this.elements;
		if (apiKeyInput) {
			apiKeyInput.value = this.revealedApiKey!;
			apiKeyInput.type = 'text';
		}
		this.isKeyRevealed = true;
		return true;
	}

	/**
	 * Hide revealed API key with masking
	 */
	hideApiKey(provider: string): void {
		const { apiKeyInput } = this.elements;
		if (apiKeyInput) {
			const keyLength = provider === 'openai' ? this.openaiKeyLength : this.geminiKeyLength;
			apiKeyInput.value = '•'.repeat(keyLength || 20);
			apiKeyInput.type = 'password';
		}
		this.isKeyRevealed = false;
	}

	/**
	 * Copy API key to clipboard
	 */
	async copyApiKey(
		provider: string,
		fetchFn: (provider: string) => Promise<string | null>,
	): Promise<boolean> {
		if (!this.revealedApiKey) {
			const apiKey = await fetchFn(provider);
			if (!apiKey) {
				alert('Failed to retrieve API key');
				return false;
			}
			this.cacheApiKey(provider, apiKey);
		}

		try {
			await navigator.clipboard.writeText(this.revealedApiKey!);
			return true;
		} catch (error) {
			console.error('Failed to copy to clipboard:', error);
			return false;
		}
	}

	/**
	 * Clear cached revealed key
	 */
	clearRevealedKey(): void {
		this.revealedApiKey = null;
		this.isKeyRevealed = false;
	}

	/**
	 * Update AI state after form submission
	 */
	updateAiState(newState: Partial<AiState>): void {
		Object.assign(this.aiState, newState);
	}

	/**
	 * Get current revealed state
	 */
	isRevealed(): boolean {
		return this.isKeyRevealed;
	}
}
