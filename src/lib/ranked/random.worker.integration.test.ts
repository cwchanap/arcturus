import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'path';
import { Miniflare } from 'miniflare';

const projectRoot = process.cwd();
let miniflare: Miniflare | null = null;

afterAll(async () => {
	await miniflare?.dispose();
});

describe('ranked crypto in workerd', () => {
	test('matches pinned canonical, HMAC, commitment, and deck fixtures', async () => {
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

		const response = await miniflare.dispatchFetch('http://ranked.test/');
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			block: '26703278906b275d44e68bcccc9563a062c2364c71cd76679fe6d1a3afc86ac3',
			commitment: '53b7d7e3c3cccc4d50c84318061deca625f712619eab99f8dd1c0b66c7d9ef7e',
			canonical: '{"a":[3,{"b":true,"x":"é"}],"z":0}',
			firstTenDealt: [
				{ rank: '9', suit: 'hearts' },
				{ rank: 'A', suit: 'clubs' },
				{ rank: '7', suit: 'hearts' },
				{ rank: 'J', suit: 'clubs' },
				{ rank: '6', suit: 'spades' },
				{ rank: 'Q', suit: 'hearts' },
				{ rank: 'J', suit: 'diamonds' },
				{ rank: '4', suit: 'diamonds' },
				{ rank: '4', suit: 'hearts' },
				{ rank: 'K', suit: 'diamonds' },
			],
		});
	});
});
