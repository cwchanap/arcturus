import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

async function collectFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry) => {
			const path = join(directory, entry.name);
			return entry.isDirectory() ? collectFiles(path) : [path];
		}),
	);
	return files.flat();
}

describe('Astro filesystem routes', () => {
	test('keeps test modules outside src/pages', async () => {
		const pagesDirectory = join(process.cwd(), 'src', 'pages');
		const routedTestModules = (await collectFiles(pagesDirectory))
			.map((path) => relative(process.cwd(), path).split(sep).join('/'))
			.filter((path) => /\.(?:test|spec)\.[^/]+$/.test(path) || path.includes('/__tests__/'))
			.sort();

		expect(routedTestModules).toEqual([]);
	});
});
