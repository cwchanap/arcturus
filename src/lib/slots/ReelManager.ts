import { NUM_REELS, NUM_ROWS, SYMBOL_ORDER, SYMBOLS } from './constants';
import type { ReelGrid, SymbolId } from './types';

export type Rng = () => number;

export class ReelManager {
	private readonly cumulative: ReadonlyArray<{ symbol: SymbolId; threshold: number }>;
	private readonly totalWeight: number;

	constructor() {
		let acc = 0;
		const list: { symbol: SymbolId; threshold: number }[] = [];
		for (const id of SYMBOL_ORDER) {
			acc += SYMBOLS[id].weight;
			list.push({ symbol: id, threshold: acc });
		}
		this.cumulative = list;
		this.totalWeight = acc;
	}

	spin(rng: Rng = Math.random): ReelGrid {
		const grid: ReelGrid = [];
		for (let reel = 0; reel < NUM_REELS; reel++) {
			const column: SymbolId[] = [];
			for (let row = 0; row < NUM_ROWS; row++) {
				column.push(this.pickSymbol(rng));
			}
			grid.push(column);
		}
		return grid;
	}

	private pickSymbol(rng: Rng): SymbolId {
		const roll = rng() * this.totalWeight;
		for (const entry of this.cumulative) {
			if (roll < entry.threshold) return entry.symbol;
		}
		return this.cumulative[this.cumulative.length - 1].symbol;
	}
}
