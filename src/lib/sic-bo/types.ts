/**
 * Sic Bo local type definitions
 */

export type DieFace = 1 | 2 | 3 | 4 | 5 | 6;

export type SicBoRoll = readonly [DieFace, DieFace, DieFace];

export type SicBoExactTotal = 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17;

export type SicBoBetKey =
	| 'big'
	| 'small'
	| 'odd'
	| 'even'
	| 'any-triple'
	| `total:${SicBoExactTotal}`;

export type SicBoBet = { key: SicBoBetKey; amount: number };

export type SicBoBetResult = {
	key: SicBoBetKey;
	amount: number;
	odds: number;
	won: boolean;
	grossReturn: number;
};
