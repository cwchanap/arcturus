import { describe, expect, test } from 'bun:test';
import { readHand } from './handReadout';
import {
	pickHandOutcomeTalk,
	pickRivalLine,
	type RivalHandOutcome,
	type RivalTalkEvent,
} from './rivalTalk';
import type { AIPersonality, Card } from './types';

const PERSONALITIES: AIPersonality[] = [
	'tight-aggressive',
	'loose-aggressive',
	'tight-passive',
	'loose-passive',
];
const EVENTS: RivalTalkEvent[] = ['bigPotWin', 'bluffWin', 'badBeat', 'allIn', 'sngOut'];

function c(code: string): Card {
	const value = code.slice(0, -1);
	const suit = ({ h: 'hearts', d: 'diamonds', c: 'clubs', s: 'spades' } as const)[
		code.slice(-1) as 'h' | 'd' | 'c' | 's'
	];
	const rank = { J: 11, Q: 12, K: 13, A: 14 }[value] ?? Number(value);
	return { value, suit, rank };
}

function rival(
	id: number,
	overrides: Partial<Omit<RivalHandOutcome, 'id'>> = {},
): RivalHandOutcome {
	return {
		id,
		personality: 'tight-aggressive',
		contestedWinnings: 0,
		raised: false,
		readout: null,
		folded: false,
		startStack: 500,
		chips: 500,
		...overrides,
	};
}

const TWO_PAIR = readHand([c('Ah'), c('Kh')], [c('Ac'), c('Kd'), c('7h'), c('2s'), c('9c')])!;
const BOARD_TWO_PAIR = readHand([c('2c'), c('3d')], [c('Ah'), c('Ac'), c('Kh'), c('Kd'), c('9s')])!;
const ONE_PAIR = readHand([c('Ah'), c('Kh')], [c('Ac'), c('7d'), c('4h'), c('2s'), c('9c')])!;

describe('pickRivalLine', () => {
	test('splits the A/B variants at exactly 0.5', () => {
		expect(pickRivalLine('tight-aggressive', 'allIn', () => 0.4999).messageKey).toBe(
			'rivalTalkSharkAllInA',
		);
		expect(pickRivalLine('tight-aggressive', 'allIn', () => 0.5).messageKey).toBe(
			'rivalTalkSharkAllInB',
		);
		expect(pickRivalLine('tight-aggressive', 'allIn', () => 0.5)).toMatchObject({
			emoji: expect.any(String),
		});
	});

	test('every personality/event pair has two distinct message keys', () => {
		for (const personality of PERSONALITIES) {
			for (const event of EVENTS) {
				const first = pickRivalLine(personality, event, () => 0);
				const second = pickRivalLine(personality, event, () => 0.5);
				expect(first.messageKey).not.toBe(second.messageKey);
			}
		}
	});
});

describe('pickHandOutcomeTalk', () => {
	test('bigPotWin begins inclusively at 20 big blinds of net profit', () => {
		const talk = (overrides: Partial<Omit<RivalHandOutcome, 'id'>>) =>
			pickHandOutcomeTalk({
				rivals: [rival(2, overrides)],
				showdown: false,
				mode: 'cash',
				bigBlind: 10,
			});

		expect(talk({ contestedWinnings: 400, startStack: 500, chips: 699 })).toBeNull();
		expect(talk({ contestedWinnings: 400, startStack: 500, chips: 700 })).toEqual({
			playerId: 2,
			event: 'bigPotWin',
		});
		// A 20-BB gross contested pot that only nets 10 BB does not qualify.
		expect(talk({ contestedWinnings: 200, startStack: 500, chips: 600 })).toBeNull();
	});

	test('an all-uncalled return is zero contested winnings, not a win', () => {
		expect(
			pickHandOutcomeTalk({
				rivals: [rival(3, { contestedWinnings: 0, raised: true })],
				showdown: false,
				mode: 'cash',
				bigBlind: 10,
			}),
		).toBeNull();
	});

	test('a raised walkover talks; a blind-only walkover stays quiet', () => {
		const walkover = (raised: boolean) =>
			pickHandOutcomeTalk({
				rivals: [rival(2, { contestedWinnings: 30, raised })],
				showdown: false,
				mode: 'cash',
				bigBlind: 10,
			});

		expect(walkover(true)).toEqual({ playerId: 2, event: 'bluffWin' });
		expect(walkover(false)).toBeNull();
	});

	test('a two-pair showdown loser gets a bad beat line', () => {
		expect(
			pickHandOutcomeTalk({
				rivals: [rival(4, { readout: TWO_PAIR })],
				showdown: true,
				mode: 'cash',
				bigBlind: 10,
			}),
		).toEqual({ playerId: 4, event: 'badBeat' });
	});

	test('a split or side-pot winner taking any contested award is not a bad beat', () => {
		expect(
			pickHandOutcomeTalk({
				rivals: [rival(4, { readout: TWO_PAIR, contestedWinnings: 5 })],
				showdown: true,
				mode: 'cash',
				bigBlind: 10,
			}),
		).toBeNull();
	});

	test('a board-only two pair and a weak losing hand are not bad beats', () => {
		expect(BOARD_TWO_PAIR.usesHoleCards).toBe(false);
		const boardOnly = pickHandOutcomeTalk({
			rivals: [rival(4, { readout: BOARD_TWO_PAIR })],
			showdown: true,
			mode: 'cash',
			bigBlind: 10,
		});
		const onePair = pickHandOutcomeTalk({
			rivals: [rival(4, { readout: ONE_PAIR })],
			showdown: true,
			mode: 'cash',
			bigBlind: 10,
		});
		expect(boardOnly).toBeNull();
		expect(onePair).toBeNull();
	});

	test('a board-playing straight is not a bad beat', () => {
		// The best-five picker can choose the hole 9 over the board 9 in the
		// equivalent straight, so usesHoleCards alone is not proof the hand
		// improves on the board.
		const boardStraight = readHand(
			[c('9s'), c('Qh')],
			[c('5h'), c('6d'), c('7c'), c('8s'), c('9h')],
		)!;
		expect(boardStraight).toMatchObject({
			key: 'STRAIGHT',
			usesHoleCards: true,
			boardPlays: true,
		});
		expect(
			pickHandOutcomeTalk({
				rivals: [rival(4, { readout: boardStraight })],
				showdown: true,
				mode: 'cash',
				bigBlind: 10,
			}),
		).toBeNull();
	});

	test('a folded rival cannot claim a bad beat', () => {
		expect(
			pickHandOutcomeTalk({
				rivals: [rival(4, { readout: TWO_PAIR, folded: true })],
				showdown: true,
				mode: 'cash',
				bigBlind: 10,
			}),
		).toBeNull();
	});

	test('a funded Sit & Go bust gets the exit line after awards', () => {
		expect(
			pickHandOutcomeTalk({
				rivals: [rival(5, { startStack: 120, chips: 0 })],
				showdown: false,
				mode: 'sng',
				bigBlind: 10,
			}),
		).toEqual({ playerId: 5, event: 'sngOut' });
	});

	test('cash rebuys, unfunded seats and all-ins still holding chips stay quiet', () => {
		const cashBust = pickHandOutcomeTalk({
			rivals: [rival(5, { startStack: 120, chips: 0 })],
			showdown: false,
			mode: 'cash',
			bigBlind: 10,
		});
		const seatAlreadyOut = pickHandOutcomeTalk({
			rivals: [rival(5, { startStack: 0, chips: 0 })],
			showdown: false,
			mode: 'sng',
			bigBlind: 10,
		});
		const allInSurvivor = pickHandOutcomeTalk({
			rivals: [rival(5, { startStack: 500, chips: 500 })],
			showdown: false,
			mode: 'sng',
			bigBlind: 10,
		});
		expect(cashBust).toBeNull();
		expect(seatAlreadyOut).toBeNull();
		expect(allInSurvivor).toBeNull();
	});

	test('sngOut outranks badBeat and bigPotWin across seats', () => {
		expect(
			pickHandOutcomeTalk({
				rivals: [
					rival(1, { readout: TWO_PAIR }),
					rival(2, { contestedWinnings: 999, chips: 1000 }),
					rival(5, { startStack: 100, chips: 0 }),
				],
				showdown: true,
				mode: 'sng',
				bigBlind: 10,
			}),
		).toEqual({ playerId: 5, event: 'sngOut' });
	});

	test('badBeat outranks bigPotWin, which outranks bluffWin', () => {
		const badBeatOverBigPot = pickHandOutcomeTalk({
			rivals: [rival(3, { contestedWinnings: 500, chips: 1000 }), rival(4, { readout: TWO_PAIR })],
			showdown: true,
			mode: 'cash',
			bigBlind: 10,
		});
		const bigPotOverBluff = pickHandOutcomeTalk({
			rivals: [
				rival(1, { contestedWinnings: 50, raised: true, chips: 550 }),
				rival(2, { contestedWinnings: 500, chips: 1000 }),
			],
			showdown: false,
			mode: 'cash',
			bigBlind: 10,
		});
		expect(badBeatOverBigPot).toEqual({ playerId: 4, event: 'badBeat' });
		expect(bigPotOverBluff).toEqual({ playerId: 2, event: 'bigPotWin' });
	});

	test('the lowest seat id breaks a same-event tie regardless of input order', () => {
		expect(
			pickHandOutcomeTalk({
				rivals: [
					rival(4, { contestedWinnings: 400, chips: 900 }),
					rival(2, { contestedWinnings: 300, chips: 800 }),
					rival(3, { contestedWinnings: 350, chips: 850 }),
				],
				showdown: false,
				mode: 'cash',
				bigBlind: 10,
			}),
		).toEqual({ playerId: 2, event: 'bigPotWin' });
	});

	test('no eligible rival produces no candidate', () => {
		expect(
			pickHandOutcomeTalk({
				rivals: [
					rival(1, { contestedWinnings: 10, raised: true }),
					rival(2, { readout: ONE_PAIR }),
				],
				showdown: true,
				mode: 'sng',
				bigBlind: 10,
			}),
		).toBeNull();
	});
});
