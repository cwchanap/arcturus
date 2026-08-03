import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { sha256Hex } from '../ranked/canonical';
import { encodeUint64BigEndian } from '../ranked/random';

const UTF8 = new TextEncoder();
const SEED_LENGTH = 32;

interface DailyChallengeSeedVersion {
	readonly seedCommitmentDomain: Uint8Array;
	readonly roundDerivationDomain: Uint8Array;
}

const SEED_VERSIONS: Readonly<Record<string, DailyChallengeSeedVersion>> = Object.freeze({
	'blackjack-daily-v1': Object.freeze({
		seedCommitmentDomain: UTF8.encode('arcturus:blackjack-daily-v1:seed:'),
		roundDerivationDomain: UTF8.encode('arcturus:blackjack-daily-v1:round:'),
	}),
});

function assertDailyChallengeSeed(seed: Uint8Array): void {
	if (!(seed instanceof Uint8Array) || seed.length !== SEED_LENGTH) {
		throw new TypeError('Daily Challenge seed must be exactly 32 bytes');
	}
}

function requireSeedVersion(version: string): DailyChallengeSeedVersion {
	// Use an own-key check so inherited Object.prototype names (constructor, toString,
	// valueOf, etc.) do not resolve to prototype methods and bypass the unsupported check.
	if (!Object.prototype.hasOwnProperty.call(SEED_VERSIONS, version)) {
		throw new RangeError(`Unsupported Daily Challenge seed version: ${version}`);
	}
	return SEED_VERSIONS[version];
}

export function createDailyChallengeSeedCommitment(version: string, seed: Uint8Array): string {
	assertDailyChallengeSeed(seed);
	const resolved = requireSeedVersion(version);
	return sha256Hex(concatBytes(resolved.seedCommitmentDomain, seed));
}

export function deriveDailyChallengeRoundSeed(
	version: string,
	masterSeed: Uint8Array,
	roundIndex: number,
): Uint8Array {
	assertDailyChallengeSeed(masterSeed);
	if (!Number.isSafeInteger(roundIndex) || roundIndex < 0) {
		throw new RangeError('Round index must be a non-negative safe integer');
	}
	const resolved = requireSeedVersion(version);
	return hmac(
		sha256,
		masterSeed,
		concatBytes(resolved.roundDerivationDomain, encodeUint64BigEndian(BigInt(roundIndex))),
	);
}
