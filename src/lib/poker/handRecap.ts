/**
 * The story of one hand for the recap panel: the cards each street brought,
 * who did what on it, and the hands shown down. Recording only; the renderer
 * draws it and the game decides when each line happens.
 */

import type { Card } from './types';
import type { PokerHandNameKey } from './constants';

export type RecapStreet = 'preflop' | 'flop' | 'turn' | 'river';
export type RecapAction = 'fold' | 'check' | 'call' | 'raise';

export interface RecapEvent {
	playerId: number;
	action: RecapAction;
	/** Chips put in (call) or raised by (raise); 0 for fold/check. */
	amount: number;
	allIn: boolean;
}

export interface RecapStreetLog {
	street: RecapStreet;
	/** Cards this street added to the board. */
	board: Card[];
	events: RecapEvent[];
}

export interface RecapReveal {
	playerId: number;
	cards: Card[];
	handKey: PokerHandNameKey | null;
	/** Chips won from contested pots this hand. */
	won: number;
}

export interface HandRecap {
	handNumber: number;
	/** The human's hole cards. */
	hole: Card[];
	streets: RecapStreetLog[];
	/** Showdown hands (or the lone winner of a walkover, cards hidden). */
	reveals: RecapReveal[];
	showdown: boolean;
	/** The human's net change; null when they sat the hand out. */
	delta: number | null;
}

export class HandRecapRecorder {
	private recap: HandRecap | null = null;
	private finished: HandRecap | null = null;

	start(handNumber: number, hole: Card[]): void {
		this.recap = {
			handNumber,
			hole: [...hole],
			streets: [{ street: 'preflop', board: [], events: [] }],
			reveals: [],
			showdown: false,
			delta: null,
		};
	}

	street(street: RecapStreet, board: Card[]): void {
		this.recap?.streets.push({ street, board: [...board], events: [] });
	}

	act(event: RecapEvent): void {
		this.recap?.streets.at(-1)?.events.push({ ...event });
	}

	finish(result: Pick<HandRecap, 'reveals' | 'showdown' | 'delta'>): HandRecap | null {
		if (!this.recap) return null;
		this.finished = {
			...this.recap,
			reveals: result.reveals.map((reveal) => ({ ...reveal, cards: [...reveal.cards] })),
			showdown: result.showdown,
			delta: result.delta,
		};
		this.recap = null;
		return this.finished;
	}

	/** The last finished hand, for reopening the recap. */
	get last(): HandRecap | null {
		return this.finished;
	}
}
