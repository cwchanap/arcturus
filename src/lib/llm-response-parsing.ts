/**
 * LLM Response Parsing Utilities
 *
 * Shared utilities for parsing and extracting JSON from LLM responses.
 */

/**
 * Extract balanced JSON objects from a string.
 * Handles nested braces and ignores braces inside strings.
 */
export function extractBalancedJsonObjects(input: string): string[] {
	const results: string[] = [];
	let braceCount = 0;
	let start = -1;
	let inString = false;
	let escapeNext = false;

	for (let i = 0; i < input.length; i++) {
		const char = input[i];

		if (escapeNext) {
			escapeNext = false;
			continue;
		}

		if (char === '\\' && inString) {
			escapeNext = true;
			continue;
		}

		if (char === '"') {
			inString = !inString;
			continue;
		}

		if (!inString) {
			if (char === '{') {
				if (braceCount === 0) {
					start = i;
				}
				braceCount++;
			} else if (char === '}') {
				if (braceCount > 0) {
					braceCount--;
					if (braceCount === 0 && start !== -1) {
						results.push(input.substring(start, i + 1));
						start = -1;
					}
				} else {
					// Unmatched closing brace - reset start to maintain consistent state
					start = -1;
				}
			}
		}
	}

	return results;
}
