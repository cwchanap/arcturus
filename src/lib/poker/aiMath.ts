/**
 * Shared math helpers for the poker AI modules.
 *
 * Previously each AI module (aiDifficulty, aiStrategy, aiEquity, aiBetSizing,
 * aiBoardTexture) declared its own identical `clamp`. Centralizing it here
 * prevents drift as new AI modules are added.
 */

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
