/**
 * Profile page API client
 * Handles server communication for LLM settings and API key management
 */

export interface LlmSettingsPayload {
	provider: string;
	model: string;
	openaiApiKey?: string;
	geminiApiKey?: string;
}

export interface LlmSettingsResponse {
	settings: {
		provider: string;
		model: string;
		hasOpenaiKey: boolean;
		hasGeminiKey: boolean;
	};
}

/**
 * Fetch the actual API key from server (only called when user wants to see/copy it)
 */
export async function fetchApiKey(provider: string): Promise<string | null> {
	try {
		const response = await fetch('/api/profile/reveal-api-key', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
			},
			body: JSON.stringify({ provider }),
		});

		if (!response.ok) {
			throw new Error('Failed to retrieve API key');
		}

		const data: unknown = await response.json();

		// Type guard: ensure data has apiKey property
		if (data && typeof data === 'object' && 'apiKey' in data && typeof data.apiKey === 'string') {
			return data.apiKey;
		}

		return null;
	} catch (error) {
		console.error('Error fetching API key:', error);
		return null;
	}
}

/**
 * Save LLM settings to server
 */
export async function saveLlmSettings(payload: LlmSettingsPayload): Promise<LlmSettingsResponse> {
	const response = await fetch('/api/profile/llm-settings', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
		},
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(errorText || `Request failed with status ${response.status}`);
	}

	return response.json();
}
