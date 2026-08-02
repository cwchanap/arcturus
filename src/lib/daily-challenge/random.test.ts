import { describe, expect, test } from 'bun:test';
import { createSeedCommitment } from '../ranked/random';
import { createDailyChallengeSeedCommitment, deriveDailyChallengeRoundSeed } from './random';

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const seed = Uint8Array.from({ length: 32 }, (_, index) => index);
const VERSION = 'blackjack-daily-v1';

describe('createDailyChallengeSeedCommitment', () => {
	test('pins the v1 seed commitment hex vector', () => {
		expect(createDailyChallengeSeedCommitment(VERSION, seed)).toBe(
			'3e59d323ee6d9259e6f2e3ed9bed68bc5c242cefb2a800323fc21d9edcf1dc56',
		);
	});

	test('returns a 64-character lowercase hex digest', () => {
		const commitment = createDailyChallengeSeedCommitment(VERSION, seed);
		expect(commitment).toHaveLength(64);
		expect(/^[0-9a-f]{64}$/.test(commitment)).toBe(true);
	});

	test('is independent of the ranked seed commitment for the same seed material', () => {
		expect(createDailyChallengeSeedCommitment(VERSION, seed)).not.toBe(createSeedCommitment(seed));
	});

	test('rejects an unsupported ruleset version', () => {
		expect(() => createDailyChallengeSeedCommitment('blackjack-daily-v2', seed)).toThrow();
	});

	test.each([new Uint8Array(), new Uint8Array(31), new Uint8Array(33)])(
		'rejects a seed that is not exactly 32 bytes (%p bytes)',
		(invalidSeed) => {
			expect(() => createDailyChallengeSeedCommitment(VERSION, invalidSeed)).toThrow();
		},
	);
});

describe('deriveDailyChallengeRoundSeed', () => {
	test('pins the v1 round-seed hex vectors for known indexes', () => {
		expect(bytesToHex(deriveDailyChallengeRoundSeed(VERSION, seed, 0))).toBe(
			'154580a9d084625add0c87de9d1c4eb39111e87174c48e839d9ce0ee927bc7c7',
		);
		expect(bytesToHex(deriveDailyChallengeRoundSeed(VERSION, seed, 1))).toBe(
			'c38f60b05888787b90ac09c128864c4bfa8a067c8501596160f96ab332d57a32',
		);
		expect(bytesToHex(deriveDailyChallengeRoundSeed(VERSION, seed, 9))).toBe(
			'bfd398731393c0ecc74fe86d8e47e0bf5d2ec72d56b8f392590a3887a97fae43',
		);
	});

	test('produces distinct 32-byte round seeds across consecutive indexes', () => {
		const zero = bytesToHex(deriveDailyChallengeRoundSeed(VERSION, seed, 0));
		const one = bytesToHex(deriveDailyChallengeRoundSeed(VERSION, seed, 1));
		const nine = bytesToHex(deriveDailyChallengeRoundSeed(VERSION, seed, 9));
		expect(zero).not.toBe(one);
		expect(one).not.toBe(nine);
		expect(deriveDailyChallengeRoundSeed(VERSION, seed, 0)).toHaveLength(32);
	});

	test('derives identical output for the same inputs (deterministic)', () => {
		expect(deriveDailyChallengeRoundSeed(VERSION, seed, 4)).toEqual(
			deriveDailyChallengeRoundSeed(VERSION, seed, 4),
		);
	});

	test('rejects an unsupported ruleset version', () => {
		expect(() => deriveDailyChallengeRoundSeed('blackjack-daily-v9', seed, 0)).toThrow();
	});

	test.each([new Uint8Array(), new Uint8Array(31), new Uint8Array(33)])(
		'rejects a master seed that is not exactly 32 bytes (%p bytes)',
		(invalidSeed) => {
			expect(() => deriveDailyChallengeRoundSeed(VERSION, invalidSeed, 0)).toThrow();
		},
	);

	test.each([-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
		'rejects an invalid round index %p',
		(roundIndex) => {
			expect(() => deriveDailyChallengeRoundSeed(VERSION, seed, roundIndex)).toThrow();
		},
	);
});
