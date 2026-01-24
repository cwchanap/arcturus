/**
 * API Key Placeholder Logic
 *
 * Returns the appropriate API key placeholder based on the AI provider.
 * Used in profile settings for LLM configuration.
 */

/**
 * Gets the API key placeholder text for a given AI provider.
 *
 * @param provider - The AI provider ('openai' or 'gemini')
 * @returns The placeholder text for the API key input
 */
export function getApiKeyPlaceholder(provider: 'openai' | 'gemini'): string {
	return provider === 'openai' ? 'sk-...' : 'AIza...';
}
