import { describe, expect, test } from 'bun:test';
import {
	CanonicalizationError,
	canonicalizeRanked,
	decodeCanonicalBase64Url,
	encodeBase64Url,
	hashCanonical,
	sha256Hex,
} from './canonical';

describe('ranked canonical JSON', () => {
	test('canonicalizes the restricted JCS value byte-for-byte', () => {
		expect(canonicalizeRanked({ z: 0, a: [3, { x: 'é', b: true }] })).toBe(
			'{"a":[3,{"b":true,"x":"é"}],"z":0}',
		);
	});

	test.each([
		['NaN', Number.NaN],
		['positive infinity', Number.POSITIVE_INFINITY],
		['negative infinity', Number.NEGATIVE_INFINITY],
		['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
		['negative zero', -0],
		['undefined', undefined],
	])('rejects %s', (_description, value) => {
		expect(() => canonicalizeRanked(value as never)).toThrow(CanonicalizationError);
	});

	test('rejects sparse arrays and arrays with non-index properties', () => {
		const sparse = Array(2) as never;
		const extended = [1, 2] as number[] & { extra?: number };
		extended.extra = 3;

		expect(() => canonicalizeRanked(sparse)).toThrow(CanonicalizationError);
		expect(() => canonicalizeRanked(extended)).toThrow(CanonicalizationError);
	});

	test('rejects non-plain objects', () => {
		expect(() => canonicalizeRanked(new Date(0) as never)).toThrow(CanonicalizationError);
		expect(() => canonicalizeRanked(Object.create(null) as never)).toThrow(CanonicalizationError);
	});

	test('pins SHA-256 and canonical-object hashes', () => {
		expect(sha256Hex('abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		);
		expect(hashCanonical({ z: 0, a: [3, { x: 'é', b: true }] })).toBe(
			'7f7fc4ec869dd426e14de1788752467352086cacc091894e699ba2fbb91ddd14',
		);
	});
});

describe('canonical base64url', () => {
	test('round-trips bytes without padding', () => {
		const bytes = Uint8Array.of(0, 1, 2, 253, 254, 255);
		const encoded = encodeBase64Url(bytes);

		expect(encoded).toBe('AAEC_f7_');
		expect(decodeCanonicalBase64Url(encoded)).toEqual(bytes);
	});

	test.each(['AA==', 'AA=', 'A+', 'A/', 'A', 'AB', 'AA\n', ' AA'])(
		'rejects malformed or non-canonical base64url %p',
		(value) => {
			expect(() => decodeCanonicalBase64Url(value)).toThrow();
		},
	);
});
