import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE64URL_PATTERN = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2}|[A-Za-z0-9_-]{3})?$/;
const textEncoder = new TextEncoder();

export type RankedJson =
	| null
	| boolean
	| string
	| number
	| readonly RankedJson[]
	| { readonly [key: string]: RankedJson };

export class CanonicalizationError extends TypeError {
	constructor() {
		super('Value is not valid ranked canonical JSON');
		this.name = 'CanonicalizationError';
	}
}

export function canonicalizeRanked(value: RankedJson): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') {
		return JSON.stringify(value);
	}
	if (typeof value === 'number') {
		if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
			throw new CanonicalizationError();
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		const keys = Object.keys(value);
		if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
			throw new CanonicalizationError();
		}
		return `[${value.map(canonicalizeRanked).join(',')}]`;
	}
	if (
		typeof value !== 'object' ||
		value === null ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		throw new CanonicalizationError();
	}
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalizeRanked(value[key])}`)
		.join(',')}}`;
}

export function sha256Hex(bytes: Uint8Array | string): string {
	return bytesToHex(sha256(typeof bytes === 'string' ? textEncoder.encode(bytes) : bytes));
}

export function hashCanonical(value: RankedJson): string {
	return sha256Hex(canonicalizeRanked(value));
}

export function encodeBase64Url(bytes: Uint8Array): string {
	let encoded = '';
	for (let offset = 0; offset < bytes.length; offset += 3) {
		const remaining = bytes.length - offset;
		const first = bytes[offset];
		const second = remaining > 1 ? bytes[offset + 1] : 0;
		const third = remaining > 2 ? bytes[offset + 2] : 0;
		const value = first * 0x1_0000 + second * 0x100 + third;

		encoded += BASE64URL_ALPHABET[Math.floor(value / 0x4_0000) & 0x3f];
		encoded += BASE64URL_ALPHABET[Math.floor(value / 0x1000) & 0x3f];
		if (remaining > 1) encoded += BASE64URL_ALPHABET[Math.floor(value / 0x40) & 0x3f];
		if (remaining > 2) encoded += BASE64URL_ALPHABET[value & 0x3f];
	}
	return encoded;
}

export function decodeCanonicalBase64Url(encoded: string): Uint8Array {
	if (!BASE64URL_PATTERN.test(encoded)) {
		throw new TypeError('Value is not canonical base64url');
	}
	const decodedLength = Math.floor((encoded.length * 6) / 8);
	const decoded = new Uint8Array(decodedLength);
	let accumulator = 0;
	let bits = 0;
	let outputOffset = 0;

	for (const character of encoded) {
		const value = BASE64URL_ALPHABET.indexOf(character);
		accumulator = accumulator * 64 + value;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			decoded[outputOffset] = Math.floor(accumulator / 2 ** bits) & 0xff;
			outputOffset += 1;
			accumulator %= 2 ** bits;
		}
	}

	if (encodeBase64Url(decoded) !== encoded) {
		throw new TypeError('Value is not canonical base64url');
	}
	return decoded;
}
