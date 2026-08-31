/**
 * Message catalog tests for the five small client-module games. Each test
 * pins the English authoring shape and spot-checks the other locales, so a
 * broken key or template shows up as a runtime mismatch in at least one
 * locale. Key parity across locales is enforced at compile time by
 * `defineMessages()`.
 */

import { describe, expect, test } from 'bun:test';
import { formatChips } from './common';
import { getGameName } from './games';
import { slotsTranslator, getSlotsSymbolLabel, formatSlotsNet } from './slots';
import { sicBoTranslator, formatSicBoNet } from './sic-bo';
import { threeCardShowdownTranslator, formatThreeCardShowdownNet } from './three-card-showdown';
import { paiGowPokerTranslator, getPaiGowCategoryLabel, getPaiGowCardName } from './pai-gow-poker';
import { videoPokerTranslator, getVideoPokerHandLabel, formatVideoPokerNet } from './video-poker';

describe('slots message catalog', () => {
	test('page shell copy', () => {
		const t = slotsTranslator('en');
		expect(t('pageTitle', { game: getGameName('en', 'slots') })).toBe('Slots - Arcturus Casino');
		expect(t('backToGames')).toBe('Back to Games');
		expect(t('betPerSpin')).toBe('Bet per spin');
		expect(t('spin')).toBe('Spin');
		expect(slotsTranslator('zh-Hant')('spin')).toBe('轉動');
		expect(slotsTranslator('ja')('spin')).toBe('スピン');
	});

	test('symbol labels resolve per SymbolId in every locale', () => {
		expect(getSlotsSymbolLabel('en', 'seven')).toBe('Seven');
		expect(getSlotsSymbolLabel('en', 'cherry')).toBe('Cherry');
		expect(getSlotsSymbolLabel('zh-Hant', 'melon')).toBe('西瓜');
		expect(getSlotsSymbolLabel('ja', 'bell')).toBe('ベル');
	});

	test('spin outcomes and settlement recovery copy', () => {
		const t = slotsTranslator('en');
		expect(t('lineResult', { symbol: 'Seven', count: '5', line: '1' })).toBe('Seven ×5 on line 1');
		expect(t('noWin')).toBe('No win');
		expect(t('winAmount', { amount: formatChips(250, 'en') })).toBe('WIN +250 chips');
		expect(t('retrySettlement')).toBe('Retry settlement');
		expect(t('settlementFailed')).toBe(
			'Settlement failed. Retry or reset before starting another spin.',
		);
		expect(slotsTranslator('ja')('settlementReset')).toBe(
			'決済をリセットしました。ベットして開始してください。',
		);
	});

	test('signed nets use the shared chip phrase', () => {
		expect(formatSlotsNet('en', 50)).toBe('+50 chips');
		expect(formatSlotsNet('en', -30)).toBe('−30 chips');
		expect(formatSlotsNet('en', 0)).toBe('0 chips');
		expect(formatSlotsNet('zh-Hant', 50)).toBe('+50 籌碼');
	});
});

describe('sic bo message catalog', () => {
	test('bet names and slip copy', () => {
		const t = sicBoTranslator('en');
		expect(t('betBig')).toBe('Big');
		expect(t('betSmall')).toBe('Small');
		expect(t('betOdd')).toBe('Odd');
		expect(t('betEven')).toBe('Even');
		expect(t('betAnyTriple')).toBe('Any Triple');
		expect(t('totalStake', { amount: formatChips(5, 'en') })).toBe('Total stake: 5 chips');
		expect(t('roll')).toBe('Roll');
		expect(sicBoTranslator('zh-Hant')('betAnyTriple')).toBe('任意三同號');
		expect(sicBoTranslator('ja')('roll')).toBe('ロール');
	});

	test('outcomes and error codes', () => {
		const t = sicBoTranslator('en');
		expect(t('won', { net: formatSicBoNet('en', 5) })).toBe('Won +5 chips');
		expect(t('lost', { net: formatSicBoNet('en', -5) })).toBe('Lost −5 chips');
		expect(t('push')).toBe('Push');
		expect(t('errorNoBets')).toBe('Place at least one bet');
		expect(t('errorInsufficientBalance')).toBe('Selected bets exceed available balance');
		expect(t('errorDenomination')).toBe('Choose a valid chip denomination');
		expect(sicBoTranslator('zh-Hant')('errorNoBets')).toBe('請至少下一個注');
		expect(sicBoTranslator('ja')('errorInsufficientBalance')).toBe(
			'選択したベットが残高を超えています',
		);
	});
});

describe('three-card showdown message catalog', () => {
	test('outcomes and rules copy', () => {
		const t = threeCardShowdownTranslator('en');
		expect(t('chooseAnte')).toBe('Choose an ante, then deal.');
		expect(t('dealt')).toBe('Dealt. Fold or play your hand.');
		expect(t('resultFold', { net: formatThreeCardShowdownNet('en', -10) })).toBe(
			'Fold · −10 chips',
		);
		expect(t('resultDealerWin', { net: formatThreeCardShowdownNet('en', -20) })).toBe(
			'Dealer wins · −20 chips',
		);
		expect(t('resultPlayerWin', { net: formatThreeCardShowdownNet('en', 10) })).toBe(
			'Player wins · +10 chips',
		);
		expect(t('howToPlay')).toBe('How to Play');
		expect(threeCardShowdownTranslator('zh-Hant')('fold')).toBe('棄牌');
		expect(threeCardShowdownTranslator('ja')('play')).toBe('プレイ');
	});

	test('ante error codes translate per locale', () => {
		const t = threeCardShowdownTranslator('en');
		expect(t('errorWholeNumber')).toBe('Ante must be a whole number of chips');
		expect(t('errorOutOfRange', { min: '1 chip', max: '100 chips' })).toBe(
			'Bet must be between 1 chip and 100 chips',
		);
		expect(t('errorInsufficientBalance')).toBe('Ante plus Play wager exceeds available balance');
		expect(threeCardShowdownTranslator('zh-Hant')('errorWholeNumber')).toBe('前注必須是整數個籌碼');
	});
});

describe('pai gow poker message catalog', () => {
	test('category names and arrangement status', () => {
		const t = paiGowPokerTranslator('en');
		expect(getPaiGowCategoryLabel('en', 'straight-flush')).toBe('Straight Flush');
		expect(getPaiGowCategoryLabel('en', 'high-card')).toBe('High Card');
		expect(t('arrangementStatus', { high: 'Straight Flush', low: 'High Card' })).toBe(
			'High: Straight Flush · Low: High Card',
		);
		expect(getPaiGowCategoryLabel('zh-Hant', 'full-house')).toBe('葫蘆');
		expect(getPaiGowCategoryLabel('ja', 'royal-flush')).toBe('ロイヤルストレートフラッシュ');
	});

	test('accessible card names localize rank and suit nouns with invariant glyphs', () => {
		expect(getPaiGowCardName('en', { rank: 11, suit: 'hearts' })).toBe('Jack of Hearts');
		expect(getPaiGowCardName('en', { rank: 14, suit: 'spades' })).toBe('Ace of Spades');
		expect(getPaiGowCardName('en', { rank: 7, suit: 'diamonds' })).toBe('7 of Diamonds');
		expect(getPaiGowCardName('en', { rank: 'joker', suit: 'joker' })).toBe('Joker');
		expect(getPaiGowCardName('zh-Hant', { rank: 12, suit: 'clubs' })).toBe('梅花 皇后');
		expect(getPaiGowCardName('ja', { rank: 13, suit: 'diamonds' })).toBe('ダイヤのキング');
	});

	test('wager and arrangement error codes', () => {
		const t = paiGowPokerTranslator('en');
		expect(t('errorWholeNumber')).toBe('Wager must be a whole number of chips');
		expect(t('errorHighHandRank')).toBe('High hand must rank at least as high as Low hand');
		expect(t('errorDistinctIndexes')).toBe('Low-hand indexes must be distinct');
		expect(paiGowPokerTranslator('zh-Hant')('errorHighHandRank')).toBe(
			'高手牌必須至少與低手牌同等級',
		);
		expect(paiGowPokerTranslator('ja')('errorDistinctIndexes')).toBe(
			'ローハンドのインデックスは別々である必要があります',
		);
	});
});

describe('video poker message catalog', () => {
	test('hand labels and result sentences', () => {
		const t = videoPokerTranslator('en');
		expect(getVideoPokerHandLabel('en', 'straight-flush')).toBe('Straight Flush');
		expect(getVideoPokerHandLabel('en', 'nothing')).toBe('No Win');
		expect(
			t('result', {
				label: getVideoPokerHandLabel('en', 'straight-flush'),
				payout: formatChips(100, 'en'),
				net: formatVideoPokerNet('en', 98),
			}),
		).toBe('Straight Flush: 100 chips (+98 chips)');
		expect(
			t('result', {
				label: getVideoPokerHandLabel('en', 'nothing'),
				payout: formatChips(0, 'en'),
				net: formatVideoPokerNet('en', -2),
			}),
		).toBe('No Win: 0 chips (−2 chips)');
		expect(getVideoPokerHandLabel('zh-Hant', 'jacks-or-better')).toBe('一對J或以上');
		expect(getVideoPokerHandLabel('ja', 'full-house')).toBe('フルハウス');
	});

	test('hold and status copy', () => {
		const t = videoPokerTranslator('en');
		expect(t('holdCards')).toBe('Hold any cards, then draw.');
		expect(t('holdCardAria', { rank: 'J', suit: 'Hearts' })).toBe('Hold J of Hearts');
		expect(t('notEnoughChips')).toBe('Not enough chips to deal.');
		expect(t('signInForChips')).toBe('Sign in to get more chips.');
		expect(t('errorInsufficientBalance')).toBe('Wager exceeds available balance');
		expect(videoPokerTranslator('ja')('holdCardAria', { rank: 'J', suit: 'ハート' })).toBe(
			'ハートのJを保持',
		);
	});
});
