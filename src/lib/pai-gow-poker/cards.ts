import { createDeck, shuffleDeck } from '../cards';
import type { PaiGowCard, PaiGowJoker } from './types';

export const PAI_GOW_JOKER: PaiGowJoker = { rank: 'joker', suit: 'joker' };

export function isPaiGowJoker(card: PaiGowCard): card is PaiGowJoker {
	return card.rank === 'joker';
}

export function createPaiGowDeck(): PaiGowCard[] {
	return [...createDeck(), PAI_GOW_JOKER];
}

export function createShuffledPaiGowDeck(random: () => number = Math.random): PaiGowCard[] {
	return shuffleDeck(createPaiGowDeck(), random);
}
