import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'path';
import { Miniflare } from 'miniflare';
import { canonicalizeRanked } from './canonical';
import { createSeedCommitment, deriveRankedCounterBlock, shuffleRankedDeck } from './random';

const projectRoot = process.cwd();
let miniflare: Miniflare | null = null;

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

afterAll(async () => {
	await miniflare?.dispose();
});

describe('ranked crypto in workerd', () => {
	test('matches Bun canonical, HMAC, commitment, and deck fixtures', async () => {
		const entrypoint = 'ranked-worker-fixture';
		const randomPath = join(projectRoot, 'src/lib/ranked/random.ts');
		const canonicalPath = join(projectRoot, 'src/lib/ranked/canonical.ts');
		const build = await Bun.build({
			entrypoints: [entrypoint],
			target: 'browser',
			format: 'esm',
			write: false,
			plugins: [
				{
					name: 'ranked-worker-fixture',
					setup(builder) {
						builder.onResolve({ filter: /^ranked-worker-fixture$/ }, () => ({
							path: entrypoint,
							namespace: 'ranked-worker-fixture',
						}));
						builder.onLoad({ filter: /.*/, namespace: 'ranked-worker-fixture' }, () => ({
							loader: 'ts',
							contents: `
									import {
										createSeedCommitment,
										deriveRankedCounterBlock,
										shuffleRankedDeck,
									} from ${JSON.stringify(randomPath)};
									import { canonicalizeRanked } from ${JSON.stringify(canonicalPath)};
									const bytesToHex = (bytes: Uint8Array) =>
										Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
									export default {
										fetch() {
											const seed = Uint8Array.from({ length: 32 }, (_, index) => index);
											return Response.json({
												block: bytesToHex(deriveRankedCounterBlock(seed, 0n)),
												commitment: createSeedCommitment(seed),
												canonical: canonicalizeRanked({ z: 0, a: [3, { x: 'é', b: true }] }),
												firstTenDealt: shuffleRankedDeck(seed).slice(-10).reverse(),
											});
										},
									};
								`,
						}));
					},
				},
			],
		});

		expect(build.success).toBe(true);
		expect(build.logs).toEqual([]);
		const workerSource = await build.outputs[0].text();
		miniflare = new Miniflare({
			modules: [
				{
					type: 'ESModule',
					path: 'file:///ranked-worker-fixture.js',
					contents: workerSource,
				},
			],
		});

		const seed = Uint8Array.from({ length: 32 }, (_, index) => index);
		const response = await miniflare.dispatchFetch('http://ranked.test/');
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			block: bytesToHex(deriveRankedCounterBlock(seed, 0n)),
			commitment: createSeedCommitment(seed),
			canonical: canonicalizeRanked({ z: 0, a: [3, { x: 'é', b: true }] }),
			firstTenDealt: shuffleRankedDeck(seed).slice(-10).reverse(),
		});
	});
});
