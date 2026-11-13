/**
 * Decorative rival table talk: an exhaustively typed personality/event line
 * table and two pure pickers. No DOM, timers, RNG state or poker rule changes
 * live here — the game makes the probability rolls and the renderer owns the
 * bubble. Emoji stay out of the translations so text and decoration can be
 * styled separately.
 */

import type { POKER_MESSAGES } from '../i18n/messages/poker';
import type { MessageKey } from '../i18n/translate';
import { HAND_RANKINGS } from './constants';
import type { HandReadout } from './handReadout';
import type { PokerMode } from './sitAndGo';
import type { AIPersonality } from './types';

export type RivalTalkEvent = 'bigPotWin' | 'bluffWin' | 'badBeat' | 'allIn' | 'sngOut';

export interface RivalLine {
	emoji: string;
	messageKey: MessageKey<typeof POKER_MESSAGES>;
}

/** Every personality/event pair has exactly two shared line variants. */
export type RivalTalkLines = Record<
	AIPersonality,
	Record<RivalTalkEvent, readonly [RivalLine, RivalLine]>
>;

export const RIVAL_TALK_LINES: RivalTalkLines = {
	'tight-aggressive': {
		allIn: [
			{ emoji: '🦈', messageKey: 'rivalTalkSharkAllInA' },
			{ emoji: '🔥', messageKey: 'rivalTalkSharkAllInB' },
		],
		bigPotWin: [
			{ emoji: '🤑', messageKey: 'rivalTalkSharkBigPotWinA' },
			{ emoji: '💰', messageKey: 'rivalTalkSharkBigPotWinB' },
		],
		bluffWin: [
			{ emoji: '😏', messageKey: 'rivalTalkSharkBluffWinA' },
			{ emoji: '😎', messageKey: 'rivalTalkSharkBluffWinB' },
		],
		badBeat: [
			{ emoji: '😤', messageKey: 'rivalTalkSharkBadBeatA' },
			{ emoji: '💀', messageKey: 'rivalTalkSharkBadBeatB' },
		],
		sngOut: [
			{ emoji: '🫡', messageKey: 'rivalTalkSharkSngOutA' },
			{ emoji: '👏', messageKey: 'rivalTalkSharkSngOutB' },
		],
	},
	'loose-aggressive': {
		allIn: [
			{ emoji: '🔥', messageKey: 'rivalTalkManiacAllInA' },
			{ emoji: '😈', messageKey: 'rivalTalkManiacAllInB' },
		],
		bigPotWin: [
			{ emoji: '🚀', messageKey: 'rivalTalkManiacBigPotWinA' },
			{ emoji: '🤑', messageKey: 'rivalTalkManiacBigPotWinB' },
		],
		bluffWin: [
			{ emoji: '😜', messageKey: 'rivalTalkManiacBluffWinA' },
			{ emoji: '🤫', messageKey: 'rivalTalkManiacBluffWinB' },
		],
		badBeat: [
			{ emoji: '🤬', messageKey: 'rivalTalkManiacBadBeatA' },
			{ emoji: '😱', messageKey: 'rivalTalkManiacBadBeatB' },
		],
		sngOut: [
			{ emoji: '👋', messageKey: 'rivalTalkManiacSngOutA' },
			{ emoji: '😵', messageKey: 'rivalTalkManiacSngOutB' },
		],
	},
	'tight-passive': {
		allIn: [
			{ emoji: '🪨', messageKey: 'rivalTalkRockAllInA' },
			{ emoji: '😐', messageKey: 'rivalTalkRockAllInB' },
		],
		bigPotWin: [
			{ emoji: '💰', messageKey: 'rivalTalkRockBigPotWinA' },
			{ emoji: '🙂', messageKey: 'rivalTalkRockBigPotWinB' },
		],
		bluffWin: [
			{ emoji: '🙏', messageKey: 'rivalTalkRockBluffWinA' },
			{ emoji: '🤔', messageKey: 'rivalTalkRockBluffWinB' },
		],
		badBeat: [
			{ emoji: '😑', messageKey: 'rivalTalkRockBadBeatA' },
			{ emoji: '💀', messageKey: 'rivalTalkRockBadBeatB' },
		],
		sngOut: [
			{ emoji: '🫡', messageKey: 'rivalTalkRockSngOutA' },
			{ emoji: '🤝', messageKey: 'rivalTalkRockSngOutB' },
		],
	},
	'loose-passive': {
		allIn: [
			{ emoji: '😅', messageKey: 'rivalTalkStationAllInA' },
			{ emoji: '🫣', messageKey: 'rivalTalkStationAllInB' },
		],
		bigPotWin: [
			{ emoji: '🎉', messageKey: 'rivalTalkStationBigPotWinA' },
			{ emoji: '😄', messageKey: 'rivalTalkStationBigPotWinB' },
		],
		bluffWin: [
			{ emoji: '😲', messageKey: 'rivalTalkStationBluffWinA' },
			{ emoji: '🤷', messageKey: 'rivalTalkStationBluffWinB' },
		],
		badBeat: [
			{ emoji: '😢', messageKey: 'rivalTalkStationBadBeatA' },
			{ emoji: '😞', messageKey: 'rivalTalkStationBadBeatB' },
		],
		sngOut: [
			{ emoji: '👋', messageKey: 'rivalTalkStationSngOutA' },
			{ emoji: '🥲', messageKey: 'rivalTalkStationSngOutB' },
		],
	},
};

/** Pick the first or second shared line variant; `random` is the game's talk RNG. */
export function pickRivalLine(
	personality: AIPersonality,
	event: RivalTalkEvent,
	random: () => number,
): RivalLine {
	const [first, second] = RIVAL_TALK_LINES[personality][event];
	return random() < 0.5 ? first : second;
}

/** One rival's finalized end-of-hand facts; contested winnings exclude returned bets. */
export interface RivalHandOutcome {
	/** Seat/player id. */
	id: number;
	personality: AIPersonality;
	/** Chips won from contested pots only; uncalled returns stay at zero. */
	contestedWinnings: number;
	/** The rival made at least one recorded raise this hand. */
	raised: boolean;
	readout: HandReadout | null;
	folded: boolean;
	/** Stack before blinds; 0 means the seat was not funded for this hand. */
	startStack: number;
	/** Chips after every award for the hand. */
	chips: number;
}

export interface HandOutcomeTalkInput {
	rivals: readonly RivalHandOutcome[];
	showdown: boolean;
	mode: PokerMode;
	bigBlind: number;
}

export interface RivalTalkCandidate {
	playerId: number;
	event: RivalTalkEvent;
}

type HandOutcomeEvent = Exclude<RivalTalkEvent, 'allIn'>;

/** Strongest reaction first; the seat id only breaks ties within one event. */
const EVENT_PRIORITY: readonly HandOutcomeEvent[] = ['sngOut', 'badBeat', 'bigPotWin', 'bluffWin'];

function qualifies(
	rival: RivalHandOutcome,
	event: HandOutcomeEvent,
	input: HandOutcomeTalkInput,
): boolean {
	switch (event) {
		case 'sngOut':
			return input.mode === 'sng' && rival.startStack > 0 && rival.chips === 0;
		case 'badBeat':
			return (
				input.showdown &&
				!rival.folded &&
				rival.contestedWinnings === 0 &&
				rival.readout !== null &&
				rival.readout.usesHoleCards &&
				!rival.readout.boardPlays &&
				HAND_RANKINGS[rival.readout.key] >= HAND_RANKINGS.TWO_PAIR
			);
		case 'bigPotWin':
			return (
				input.bigBlind > 0 &&
				rival.startStack > 0 &&
				rival.contestedWinnings > 0 &&
				rival.chips - rival.startStack >= 20 * input.bigBlind
			);
		case 'bluffWin':
			return !input.showdown && !rival.folded && rival.raised && rival.contestedWinnings > 0;
	}
}

/**
 * The single rival reaction for a finished hand, chosen across every rival at
 * once: `sngOut` > `badBeat` > `bigPotWin` > `bluffWin`, lowest seat id on a
 * same-event tie. No probability roll happens here; the game rolls once for
 * the returned candidate.
 */
export function pickHandOutcomeTalk(input: HandOutcomeTalkInput): RivalTalkCandidate | null {
	const bySeat = [...input.rivals].sort((a, b) => a.id - b.id);
	for (const event of EVENT_PRIORITY) {
		const rival = bySeat.find((candidate) => qualifies(candidate, event, input));
		if (rival) return { playerId: rival.id, event };
	}
	return null;
}
