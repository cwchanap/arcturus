import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes } from '@noble/hashes/utils.js';
import type { Card, Rank, Suit } from '../blackjack/types';
import { sha256Hex } from './canonical';

const SEED_LENGTH = 32;
const UINT32_RANGE = 0x1_0000_0000;
const MAX_UINT64 = 0xffff_ffff_ffff_ffffn;
const DECK_DOMAIN = new TextEncoder().encode('arcturus:blackjack-ranked-v1:deck');
const SEED_COMMITMENT_DOMAIN = new TextEncoder().encode('arcturus:blackjack-ranked-v1:seed:');
const SUITS: readonly Suit[] = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS: readonly Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

export interface RankedRandomSource {
	nextInt(exclusiveUpperBound: number): number;
}

function assertSeed(seed: Uint8Array): void {
	if (!(seed instanceof Uint8Array) || seed.length !== SEED_LENGTH) {
		throw new TypeError('Ranked seed must be exactly 32 bytes');
	}
}

function assertUpperBound(exclusiveUpperBound: number): void {
	if (
		!Number.isSafeInteger(exclusiveUpperBound) ||
		exclusiveUpperBound <= 0 ||
		exclusiveUpperBound > UINT32_RANGE
	) {
		throw new RangeError('Exclusive upper bound must be an integer from 1 through 2^32');
	}
}

function encodeUint64BigEndian(counter: bigint): Uint8Array {
	if (typeof counter !== 'bigint' || counter < 0n || counter > MAX_UINT64) {
		throw new RangeError('Counter must be an unsigned 64-bit integer');
	}
	const encoded = new Uint8Array(8);
	let remaining = counter;
	for (let offset = encoded.length - 1; offset >= 0; offset -= 1) {
		encoded[offset] = Number(remaining & 0xffn);
		remaining >>= 8n;
	}
	return encoded;
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
	return (
		bytes[offset] * 0x1_000_000 +
		bytes[offset + 1] * 0x1_0000 +
		bytes[offset + 2] * 0x100 +
		bytes[offset + 3]
	);
}

export function createRankedSeed(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(SEED_LENGTH));
}

export function createSeedCommitment(seed: Uint8Array): string {
	assertSeed(seed);
	return sha256Hex(concatBytes(SEED_COMMITMENT_DOMAIN, seed));
}

export function deriveRankedCounterBlock(seed: Uint8Array, counter: bigint): Uint8Array {
	assertSeed(seed);
	return hmac(sha256, seed, concatBytes(DECK_DOMAIN, encodeUint64BigEndian(counter)));
}

export function createRankedRandomSource(seed: Uint8Array): RankedRandomSource {
	assertSeed(seed);
	const ownedSeed = seed.slice();
	let counter = 0n;
	let block = new Uint8Array();
	let offset = 0;

	const nextUint32 = (): number => {
		if (offset + 4 > block.length) {
			block = deriveRankedCounterBlock(ownedSeed, counter);
			counter += 1n;
			offset = 0;
		}
		const value = readUint32BigEndian(block, offset);
		offset += 4;
		return value;
	};

	return {
		nextInt(exclusiveUpperBound: number): number {
			assertUpperBound(exclusiveUpperBound);
			const limit = Math.floor(UINT32_RANGE / exclusiveUpperBound) * exclusiveUpperBound;
			for (;;) {
				const value = nextUint32();
				if (value < limit) return value % exclusiveUpperBound;
			}
		},
	};
}

export function shuffleRankedDeck(seed: Uint8Array): Card[] {
	const random = createRankedRandomSource(seed);
	const deck: Card[] = [];
	for (const suit of SUITS) {
		for (const rank of RANKS) {
			deck.push({ rank, suit });
		}
	}
	for (let index = deck.length - 1; index > 0; index -= 1) {
		const swapIndex = random.nextInt(index + 1);
		[deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
	}
	return deck;
}
