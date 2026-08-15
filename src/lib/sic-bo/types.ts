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

/** The two phases of a Sic Bo round: place bets, then the round is complete. */
export type SicBoPhase = 'betting' | 'complete';

/** The resolved outcome of one rolled round. */
export type SicBoRoundResult = {
	roll: SicBoRoll;
	totalStake: number;
	grossReturn: number;
	netDelta: number;
	results: readonly SicBoBetResult[];
};

/** Immutable-by-convention snapshot of the game. `bets` is one per-position amount per key. */
export type SicBoState = {
	phase: SicBoPhase;
	balance: number;
	bets: Partial<Record<SicBoBetKey, number>>;
	result: SicBoRoundResult | null;
};
