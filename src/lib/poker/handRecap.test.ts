import { describe, expect, test } from 'bun:test';
import { HandRecapRecorder } from './handRecap';
import type { Card } from './types';

const c = (rank: number, suit: Card['suit']): Card => ({ rank, suit, value: String(rank) });

describe('HandRecapRecorder', () => {
	test('records actions under the street they happened on', () => {
		const recorder = new HandRecapRecorder();
		const hole = [c(14, 'spades'), c(13, 'spades')];
		recorder.start(7, hole);
		recorder.act({ playerId: 1, action: 'raise', amount: 20, allIn: false });
		recorder.act({ playerId: 0, action: 'call', amount: 20, allIn: false });
		recorder.street('flop', [c(2, 'hearts'), c(9, 'clubs'), c(12, 'spades')]);
		recorder.act({ playerId: 1, action: 'check', amount: 0, allIn: false });
		const recap = recorder.finish({
			reveals: [{ playerId: 0, cards: hole, handKey: 'HIGH_CARD', won: 40 }],
			showdown: true,
			delta: 20,
		});

		expect(recap?.handNumber).toBe(7);
		expect(recap?.hole).toEqual(hole);
		expect(recap?.streets.map((s) => [s.street, s.events.length])).toEqual([
			['preflop', 2],
			['flop', 1],
		]);
		expect(recap?.streets[1].board).toHaveLength(3);
		expect(recorder.last).toBe(recap);
	});

	test('ignores actions outside a hand and keeps the last finished hand', () => {
		const recorder = new HandRecapRecorder();
		recorder.act({ playerId: 0, action: 'fold', amount: 0, allIn: false });
		expect(recorder.finish({ reveals: [], showdown: false, delta: null })).toBeNull();

		recorder.start(1, []);
		const first = recorder.finish({ reveals: [], showdown: false, delta: -10 });
		recorder.start(2, []);
		expect(recorder.last).toBe(first);
	});

	test('copies inputs so later game mutations do not rewrite the story', () => {
		const recorder = new HandRecapRecorder();
		const hole = [c(5, 'hearts'), c(6, 'hearts')];
		const board = [c(7, 'hearts'), c(8, 'hearts'), c(9, 'clubs')];
		recorder.start(1, hole);
		recorder.street('flop', board);
		hole.pop();
		board.push(c(10, 'clubs'));
		const recap = recorder.finish({ reveals: [], showdown: false, delta: 0 });
		expect(recap?.hole).toHaveLength(2);
		expect(recap?.streets[1].board).toHaveLength(3);
	});
});
