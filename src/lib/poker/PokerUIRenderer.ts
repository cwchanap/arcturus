/**
 * PokerUIRenderer - Handles all DOM manipulation and UI updates
 */

import type { AIPersonality, Card, GamePhase, Player } from './types';
import type { AIDifficulty } from './aiDifficulty';
import { HAND_RANKINGS, NUM_PLAYERS, type PokerHandNameKey } from './constants';
import { estimateDrawingOuts } from './handEvaluator';
import { isSameCard, readHand } from './handReadout';
import type { PokerSessionStats } from './sessionStats';
import { formatWholeNumber } from '../formatting';
import { renderCardsToContainer, setSlotState } from '../card-slot-utils';
import { getDocumentLocale, type Locale } from '../i18n/locale';
import { formatChips } from '../i18n/messages/common';
import {
	getPokerCardName,
	getPokerHandName,
	pokerTranslator,
	type POKER_MESSAGES,
} from '../i18n/messages/poker';
import type { MessageKey } from '../i18n/translate';

type Translator = ReturnType<typeof pokerTranslator>;

const PHASE_KEYS: Record<GamePhase, MessageKey<typeof POKER_MESSAGES>> = {
	idle: 'phaseIdle',
	dealing: 'phaseDealing',
	preflop: 'phasePreflop',
	flop: 'phaseFlop',
	turn: 'phaseTurn',
	river: 'phaseRiver',
	showdown: 'phaseShowdown',
	complete: 'phaseComplete',
};

const RIVAL_KEYS: Record<
	AIPersonality,
	{ name: MessageKey<typeof POKER_MESSAGES>; hint: MessageKey<typeof POKER_MESSAGES> }
> = {
	'tight-aggressive': { name: 'rivalShark', hint: 'rivalSharkHint' },
	'loose-aggressive': { name: 'rivalManiac', hint: 'rivalManiacHint' },
	'tight-passive': { name: 'rivalRock', hint: 'rivalRockHint' },
	'loose-passive': { name: 'rivalStation', hint: 'rivalStationHint' },
};

const DIFFICULTY_KEYS: Record<AIDifficulty, MessageKey<typeof POKER_MESSAGES>> = {
	easy: 'difficultyEasy',
	medium: 'difficultyMedium',
	hard: 'difficultyHard',
};

/** Seat label that outlives a single render: the street's last action or a showdown hand. */
type SeatLabel = { text: string; kind: 'fold' | 'check' | 'call' | 'raise' | 'hand' | 'winner' };

export type HandResultTone = 'win' | 'loss' | 'neutral';

export interface HandResultView {
	title: string;
	detail: string;
	tone: HandResultTone;
	/** The human's chip change for the hand; null hides the delta chip. */
	delta: number | null;
}

/**
 * Presentational hand-strength classification for the human's combined cards.
 * Returns a closed `PokerHandNameKey` (or null below two cards); display
 * labels are translated through `messages/poker.ts`, never raw English names.
 */
export function evaluateHandKey(
	humanPlayer: Player,
	communityCards: Card[],
): PokerHandNameKey | null {
	const allCards = [...humanPlayer.hand, ...communityCards];
	if (allCards.length < 2) return null;

	const valueCounts: Record<number, number> = {};
	const suitCounts: Record<string, number> = {};
	for (const card of allCards) {
		valueCounts[card.rank] = (valueCounts[card.rank] || 0) + 1;
		suitCounts[card.suit] = (suitCounts[card.suit] || 0) + 1;
	}

	const counts = Object.values(valueCounts).sort((a, b) => b - a);
	const maxSuitCount = Math.max(...Object.values(suitCounts));
	const hasFlush = maxSuitCount >= 5;

	// Straight detection across the combined ranks, including the A-2-3-4-5
	// wheel where the ace plays low. Simplified presentation heuristic, not an
	// authoritative ranking — showdowns use `determineShowdownWinners`.
	const sortedRanks = [...new Set(allCards.map((c) => c.rank))].sort((a, b) => b - a);
	let straightHigh = 0;
	if (sortedRanks.length >= 5) {
		for (let i = 0; i <= sortedRanks.length - 5; i++) {
			if (sortedRanks[i] - sortedRanks[i + 4] === 4) {
				straightHigh = sortedRanks[i];
				break;
			}
		}
		if (
			straightHigh === 0 &&
			sortedRanks.includes(14) &&
			sortedRanks.includes(5) &&
			sortedRanks.includes(4) &&
			sortedRanks.includes(3) &&
			sortedRanks.includes(2)
		) {
			straightHigh = 5;
		}
	}

	// A straight flush requires the straight to be in the flush suit.
	// hasFlush && straightHigh can both be true when the flush and straight
	// use different cards, so verify the flush-suit ranks contain a straight.
	let straightFlushHigh = 0;
	if (hasFlush && straightHigh > 0) {
		const flushSuit = Object.entries(suitCounts).find(([, count]) => count >= 5)?.[0];
		if (flushSuit) {
			const flushRanks = allCards.filter((c) => c.suit === flushSuit).map((c) => c.rank);
			const sortedFlushRanks = [...new Set(flushRanks)].sort((a, b) => b - a);
			for (let i = 0; i <= sortedFlushRanks.length - 5; i++) {
				if (sortedFlushRanks[i] - sortedFlushRanks[i + 4] === 4) {
					straightFlushHigh = sortedFlushRanks[i];
					break;
				}
			}
			if (
				straightFlushHigh === 0 &&
				sortedFlushRanks.includes(14) &&
				sortedFlushRanks.includes(5) &&
				sortedFlushRanks.includes(4) &&
				sortedFlushRanks.includes(3) &&
				sortedFlushRanks.includes(2)
			) {
				straightFlushHigh = 5;
			}
		}
	}

	if (straightFlushHigh > 0) {
		return straightFlushHigh === 14 ? 'ROYAL_FLUSH' : 'STRAIGHT_FLUSH';
	}
	if (counts[0] === 4) return 'FOUR_OF_A_KIND';
	if (counts[0] === 3 && counts[1] >= 2) return 'FULL_HOUSE';
	if (hasFlush) return 'FLUSH';
	if (straightHigh > 0) return 'STRAIGHT';
	if (counts[0] === 3) return 'THREE_OF_A_KIND';
	if (counts[0] === 2 && counts[1] === 2) return 'TWO_PAIR';
	if (counts[0] === 2) return 'PAIR';
	return 'HIGH_CARD';
}

export class PokerUIRenderer {
	private readonly locale: Locale;
	private readonly t: Translator;
	private readonly seatLabels = new Map<number, SeatLabel>();
	private currentHandLog: HTMLElement | null = null;

	constructor() {
		// AppLayout writes data-locale on <html>; the renderer reads it so the
		// browser and SSR share one locale handoff.
		this.locale = getDocumentLocale();
		this.t = pokerTranslator(this.locale);
	}

	public renderPlayerCards(humanPlayer: Player, communityCards: Card[]) {
		// Convert Card type to CardData format expected by card-slot-utils
		const cards = humanPlayer.hand.map((card) => ({ rank: card.value, suit: card.suit }));
		renderCardsToContainer('player-cards', cards, { showPlaceholders: 0 });

		const container = document.getElementById('player-cards');
		const slots = container?.querySelectorAll('.card-slot');
		slots?.forEach((slot, index) => {
			const card = humanPlayer.hand[index];
			if (card) {
				this.setCardA11y(slot, card);
			} else {
				this.clearCardA11y(slot);
			}
		});

		this.evaluateHand(humanPlayer, communityCards);
	}

	public renderCommunityCards(communityCards: Card[]) {
		const container = document.getElementById('community-cards');
		if (!container) return;

		// Convert Card type to CardData format
		const cards = communityCards.map((card) => ({ rank: card.value, suit: card.suit }));

		// Update slots - show cards for dealt cards, placeholders for undealt
		const slots = container.querySelectorAll('.card-slot');
		slots.forEach((slot, index) => {
			if (index < cards.length) {
				setSlotState(slot, 'card', cards[index]);
				this.setCardA11y(slot, communityCards[index]);
			} else {
				setSlotState(slot, 'placeholder');
				this.clearCardA11y(slot);
			}
		});
	}

	public updateOpponentUI(players: Player[]) {
		for (const player of players.slice(1)) {
			const chips = document.getElementById(`opponent${player.id}-chips`);
			if (chips) chips.textContent = formatWholeNumber(player.chips, this.locale);
			this.updateFoldedState(player.id, player.folded);
		}
	}

	/**
	 * Update folded state indicator for opponent
	 */
	private updateFoldedState(playerIndex: number, folded: boolean) {
		const container = document.getElementById(`opponent${playerIndex}-cards`);
		if (!container) return;

		const parent = container.parentElement;
		if (!parent) return;

		if (folded) {
			parent.classList.add('opacity-40');
			parent.classList.add('grayscale');
			// Add folded badge if not exists
			if (!parent.querySelector('.folded-badge')) {
				const badge = document.createElement('div');
				badge.className =
					'folded-badge absolute top-0 right-0 bg-[var(--deco-oxblood-bright)] text-white text-xs px-2 py-1 rounded';
				badge.textContent = this.t('foldedBadge');
				parent.style.position = 'relative';
				parent.appendChild(badge);
			}
		} else {
			parent.classList.remove('opacity-40');
			parent.classList.remove('grayscale');
			// Remove folded badge if exists
			const badge = parent.querySelector('.folded-badge');
			if (badge) {
				badge.remove();
			}
		}
	}

	/**
	 * Show an AI decision on its seat. The label stays for the rest of the
	 * street (cleared by `clearSeatActions`) so a glance away never loses who
	 * raised; colour comes from `data-action`.
	 */
	public showAIDecision(playerIndex: number, action: string, amount?: number) {
		const kind = action.toLowerCase();
		const amountText = formatWholeNumber(amount || 0, this.locale);
		let label: SeatLabel;
		switch (kind) {
			case 'fold':
				label = { kind, text: this.t('badgeFold') };
				break;
			case 'check':
				label = { kind, text: this.t('badgeCheck') };
				break;
			case 'call':
				label = { kind, text: this.t('badgeCall', { amount: amountText }) };
				break;
			case 'raise':
				label = { kind, text: this.t('badgeRaise', { amount: amountText }) };
				break;
			default:
				return;
		}
		this.seatLabels.set(playerIndex, label);
		const element = document.getElementById(`opponent${playerIndex}-action`);
		if (element) {
			element.textContent = label.text;
			element.dataset.action = kind;
		}
	}

	/** Forget per-street seat actions (new street or new hand). */
	public clearSeatActions() {
		this.seatLabels.clear();
	}

	/** Pin a showdown hand name under a seat; winners get the gold treatment. */
	public setSeatHand(playerId: number, handKey: PokerHandNameKey, isWinner: boolean) {
		this.seatLabels.set(playerId, {
			kind: isWinner ? 'winner' : 'hand',
			text: getPokerHandName(this.locale, handKey),
		});
	}

	public revealOpponentHands(players: Player[], winners: Player[]) {
		for (const player of players.slice(1)) {
			if (player.folded) continue;
			const container = document.getElementById(`opponent${player.id}-cards`);
			const isWinner = winners.some((winner) => winner.id === player.id);
			container?.querySelectorAll('.card-slot').forEach((slot, index) => {
				const card = player.hand[index];
				if (card) {
					setSlotState(slot, 'card', { rank: card.value, suit: card.suit });
					this.setCardA11y(slot, card);
					if (isWinner) slot.classList.add('ring-2', 'ring-[var(--deco-brass-bright)]');
				} else {
					setSlotState(slot, 'hidden');
					this.clearCardA11y(slot);
				}
			});
		}
	}

	public hideOpponentHands() {
		// Reset to face-down cards for opponents
		Array.from({ length: NUM_PLAYERS - 1 }, (_, i) =>
			document.getElementById(`opponent${i + 1}-cards`),
		).forEach((container) => {
			if (!container) return;
			const slots = container.querySelectorAll('.card-slot');
			slots.forEach((slot, index) => {
				// Remove any winner highlight
				slot.classList.remove('ring-2', 'ring-[var(--deco-brass-bright)]');
				if (index < 2) {
					setSlotState(slot, 'facedown');
					this.setCardA11y(slot, null);
				} else {
					setSlotState(slot, 'hidden');
					this.clearCardA11y(slot);
				}
			});
		});
	}

	/** Localized accessible name for a shown card; null for a face-down card. */
	private setCardA11y(slot: Element, card: Card | null): void {
		if (card) {
			slot.setAttribute('role', 'img');
			slot.setAttribute('aria-label', getPokerCardName(this.locale, card));
		} else {
			slot.setAttribute('role', 'img');
			slot.setAttribute('aria-label', this.t('cardFaceDown'));
		}
	}

	private clearCardA11y(slot: Element): void {
		slot.removeAttribute('role');
		slot.removeAttribute('aria-label');
	}

	private evaluateHand(humanPlayer: Player, communityCards: Card[]) {
		const strengthEl = document.getElementById('hand-strength');
		if (!strengthEl) return;

		const readout = readHand(humanPlayer.hand, communityCards);
		const key = readout?.key ?? null;
		strengthEl.textContent = key ? getPokerHandName(this.locale, key) : '--';
		// One bar per ranking step, so High Card and Pair no longer look alike.
		document.querySelectorAll<HTMLElement>('.poker-strength-bars span').forEach((bar, index) => {
			bar.dataset.lit = String(key !== null && index <= HAND_RANKINGS[key]);
		});

		const detail = document.getElementById('hand-detail');
		if (detail) {
			const outs =
				communityCards.length === 3 || communityCards.length === 4
					? estimateDrawingOuts(humanPlayer.hand, communityCards)
					: 0;
			detail.textContent = readout?.boardPlays
				? this.t('boardPlays')
				: outs >= 4
					? this.t('drawOuts', { outs })
					: '';
		}

		// Outline the cards that make a pair or better while the hand is live.
		this.clearCardHighlights();
		if (
			readout &&
			!humanPlayer.folded &&
			communityCards.length > 0 &&
			readout.usesHoleCards &&
			HAND_RANKINGS[readout.key] >= HAND_RANKINGS.PAIR
		) {
			this.markCards('player-cards', humanPlayer.hand, readout.coreCards, 'play');
			this.markCards('community-cards', communityCards, readout.coreCards, 'play');
		}
	}

	/** Mark slots whose card is in `core`; with `win`, the rest of the row dims. */
	private markCards(containerId: string, cards: Card[], core: Card[], mode: 'play' | 'win') {
		const slots = document.getElementById(containerId)?.querySelectorAll<HTMLElement>('.card-slot');
		slots?.forEach((slot, index) => {
			const card = cards[index];
			if (!card) return;
			const inCore = core.some((coreCard) => isSameCard(coreCard, card));
			if (inCore) slot.dataset.highlight = mode;
			else if (mode === 'win') slot.dataset.highlight = 'dim';
		});
	}

	public clearCardHighlights() {
		const ids = ['player-cards', 'community-cards'];
		for (let id = 1; id < NUM_PLAYERS; id++) ids.push(`opponent${id}-cards`);
		for (const id of ids) {
			document
				.getElementById(id)
				?.querySelectorAll<HTMLElement>('.card-slot')
				.forEach((slot) => delete slot.dataset.highlight);
		}
	}

	/** Light up the winning best five — kickers decide pots, so they glow too. */
	public highlightWinningCards(communityCards: Card[], winners: Player[]) {
		this.clearCardHighlights();
		const core: Card[] = [];
		for (const winner of winners) {
			const readout = readHand(winner.hand, communityCards);
			if (readout) core.push(...readout.bestCards);
		}
		this.markCards('community-cards', communityCards, core, 'win');
		for (const winner of winners) {
			const id = winner.id === 0 ? 'player-cards' : `opponent${winner.id}-cards`;
			this.markCards(id, winner.hand, core, 'win');
		}
	}

	/** Show the end-of-hand banner in the pot's place. */
	public showHandResult(result: HandResultView) {
		const banner = document.getElementById('poker-result');
		if (!banner) return;
		const title = document.getElementById('poker-result-title');
		const detail = document.getElementById('poker-result-detail');
		const delta = document.getElementById('poker-result-delta');
		if (title) title.textContent = result.title;
		if (detail) detail.textContent = result.detail;
		if (delta) {
			delta.hidden = result.delta === null;
			delta.textContent =
				result.delta === null
					? ''
					: `${this.t('resultYourHand')} ${this.formatDelta(result.delta)}`;
		}
		banner.dataset.tone = result.tone;
		banner.hidden = false;
		const human = document.getElementById('poker-seat-0');
		if (human) human.dataset.result = result.tone;
	}

	public clearHandResult() {
		const banner = document.getElementById('poker-result');
		if (banner) banner.hidden = true;
		const human = document.getElementById('poker-seat-0');
		if (human) delete human.dataset.result;
		const callout = document.getElementById('poker-callout');
		if (callout) callout.hidden = true;
		for (let id = 0; id < NUM_PLAYERS; id++) {
			const float = document.getElementById(`seat-delta-${id}`);
			if (float) float.hidden = true;
		}
		this.clearCardHighlights();
	}

	/** Signed chip change with a true minus sign, e.g. "+140" / "−30". */
	public formatDelta(delta: number): string {
		const amount = formatWholeNumber(Math.abs(delta), this.locale);
		return delta > 0 ? `+${amount}` : delta < 0 ? `\u2212${amount}` : `±${amount}`;
	}

	/** Float a chip change over a seat (seat 0 is the human bankroll). */
	public showChipDelta(playerId: number, delta: number) {
		const float = document.getElementById(`seat-delta-${playerId}`);
		if (!float || delta === 0) return;
		float.textContent = this.formatDelta(delta);
		float.dataset.tone = delta > 0 ? 'win' : 'loss';
		this.replayFlash(float);
	}

	/** Brief flourish over the board when the human improves to a strong hand. */
	public showCallout(handKey: PokerHandNameKey) {
		const callout = document.getElementById('poker-callout');
		if (!callout) return;
		const eyebrow = document.getElementById('poker-callout-eyebrow');
		const hand = document.getElementById('poker-callout-hand');
		if (eyebrow) eyebrow.textContent = this.t('calloutMade');
		if (hand) hand.textContent = getPokerHandName(this.locale, handKey);
		this.replayFlash(callout);
	}

	/** Show an element whose one-shot CSS animation fades it out, restarting it if visible. */
	private replayFlash(element: HTMLElement) {
		element.hidden = true;
		void element.offsetWidth; // flush styles so the animation restarts on re-show
		element.hidden = false;
	}

	/** "To call 20 · Pot 70 · Pot odds 22%" while it is the human's turn. */
	public renderBetSummary(visible: boolean, call: number, pot: number) {
		const summary = document.getElementById('poker-to-call');
		if (!summary) return;
		summary.hidden = !visible;
		if (!visible) return;
		const potText = this.t('potSummary', { amount: formatWholeNumber(pot, this.locale) });
		summary.textContent =
			call > 0
				? [
						this.t('toCall', { amount: formatWholeNumber(call, this.locale) }),
						potText,
						this.t('potOdds', { percent: Math.round((call / (pot + call)) * 100) }),
					].join(' · ')
				: `${this.t('checkFree')} · ${potText}`;
	}

	public renderSessionStats(stats: PokerSessionStats) {
		const hands = document.getElementById('session-hands');
		const net = document.getElementById('session-net');
		const best = document.getElementById('session-best');
		const streak = document.getElementById('session-streak');
		if (hands) hands.textContent = formatWholeNumber(stats.hands, this.locale);
		if (net) {
			net.textContent = this.formatDelta(stats.net);
			net.dataset.tone = stats.net > 0 ? 'win' : stats.net < 0 ? 'loss' : 'neutral';
		}
		if (best)
			best.textContent = stats.bestHand ? getPokerHandName(this.locale, stats.bestHand) : '—';
		if (streak) {
			streak.hidden = stats.streak < 2;
			streak.textContent = this.t('sessionStreak', { count: stats.streak });
		}
	}

	/** Name each AI seat by its playing style so reads feel earned. */
	public renderRivals(
		rivals: Array<{ id: number; personality: AIPersonality; difficulty: AIDifficulty }>,
	) {
		for (const rival of rivals) {
			const tag = document.getElementById(`rival-${rival.id}`);
			if (!tag) continue;
			const keys = RIVAL_KEYS[rival.personality];
			tag.textContent = `${this.t(keys.name)} · ${this.t(DIFFICULTY_KEYS[rival.difficulty])}`;
			tag.title = this.t(keys.hint);
			tag.dataset.style = rival.personality;
		}
	}

	/** Open a new group in the hand history; later status lines append to it. */
	public startHandHistory(handNumber: number) {
		const history = document.getElementById('poker-history');
		if (!history) return;
		const group = document.createElement('li');
		group.className = 'poker-history-hand';
		const title = document.createElement('strong');
		title.textContent = this.t('historyHand', { number: handNumber });
		const entries = document.createElement('ol');
		group.appendChild(title);
		group.appendChild(entries);
		history.insertBefore(group, history.firstChild);
		this.currentHandLog = entries;
		// ponytail: keep the last 30 hands in-page; persist only if saved history is needed.
		while (history.children.length > 30) history.lastElementChild?.remove();
		const empty = document.getElementById('poker-history-empty');
		if (empty) empty.hidden = true;
	}

	public updateUI(pot: number, humanPlayer: Player) {
		const potEl = document.getElementById('pot-amount');
		const betEl = document.getElementById('current-bet');
		const balanceEl = document.getElementById('player-balance');

		if (potEl) potEl.textContent = formatWholeNumber(pot, this.locale);
		if (betEl) betEl.textContent = formatChips(humanPlayer.currentBet, this.locale);
		if (balanceEl) balanceEl.textContent = formatChips(humanPlayer.chips, this.locale);
	}

	public updateTableState(
		players: Player[],
		dealerIndex: number,
		currentPlayerIndex: number,
		active: boolean,
	) {
		for (const player of players) {
			const seat = document.getElementById(`poker-seat-${player.id}`);
			if (!seat) continue;
			const isTurn =
				active && player.id === currentPlayerIndex && !player.folded && !player.isAllIn;
			seat.dataset.turn = String(isTurn);
			seat.dataset.folded = String(player.folded);
			const position = document.getElementById(`position-${player.id}`);
			if (position)
				position.textContent = ['BTN', 'SB', 'BB', 'UTG', 'MP', 'CO'][
					(player.id - dealerIndex + players.length) % players.length
				];
			const action = document.getElementById(`opponent${player.id}-action`);
			if (action) {
				const label = this.seatLabels.get(player.id);
				const pinned = label?.kind === 'hand' || label?.kind === 'winner';
				const [text, kind] = player.folded
					? [this.t('foldedBadge'), 'fold']
					: pinned && label
						? [label.text, label.kind]
						: player.isAllIn
							? [this.t('allIn'), 'allin']
							: isTurn
								? [this.t('thinking'), 'thinking']
								: label
									? [label.text, label.kind]
									: player.currentBet > 0
										? [formatWholeNumber(player.currentBet, this.locale), 'bet']
										: ['—', 'none'];
				action.textContent = text;
				action.dataset.action = kind;
			}
		}
		this.updateOpponentUI(players);
	}

	public updateGameStatus(message: string, gamePhase: GamePhase, pot: number) {
		const statusEl = document.getElementById('game-status');
		if (!statusEl) return;

		const phaseLabel = this.t(PHASE_KEYS[gamePhase]);
		const phase = document.getElementById('poker-phase');
		if (phase) phase.textContent = phaseLabel;
		const phaseIndex = ['preflop', 'flop', 'turn', 'river', 'showdown'].indexOf(gamePhase);
		document.querySelectorAll<HTMLElement>('[data-street]').forEach((street, index) => {
			street.dataset.reached = String(index <= phaseIndex);
			if (index === phaseIndex) street.setAttribute('aria-current', 'step');
			else street.removeAttribute('aria-current');
		});
		const entryText = `[${phaseLabel}] ${message}`;
		if (this.currentHandLog) {
			if (this.currentHandLog.lastElementChild?.textContent !== entryText) {
				const entry = document.createElement('li');
				entry.textContent = entryText;
				this.currentHandLog.appendChild(entry);
			}
		} else {
			const history = document.getElementById('poker-history');
			if (history && history.firstElementChild?.textContent !== entryText) {
				const entry = document.createElement('li');
				entry.textContent = entryText;
				history.insertBefore(entry, history.firstChild);
				while (history.children.length > 100) history.lastElementChild?.remove();
				const empty = document.getElementById('poker-history-empty');
				if (empty) empty.hidden = true;
			}
		}
		if (pot > 0) {
			statusEl.textContent = this.t('statusWithPot', {
				phase: phaseLabel,
				pot: this.t('potLabel', { amount: formatChips(pot, this.locale) }),
				message,
			});
		} else {
			statusEl.textContent = this.t('statusPlain', { phase: phaseLabel, message });
		}
	}
}
