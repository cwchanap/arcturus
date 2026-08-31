import { describe, expect, test } from 'bun:test';
import { SUPPORTED_LOCALES } from '../locale';
import { formatChips } from './common';
import { getGameName } from './games';
import { blackjackTranslator, formatBlackjackAmount, formatBlackjackNet } from './blackjack';

describe('blackjack message catalog', () => {
	test('page headings and badges resolve through the game-name catalog', () => {
		const t = blackjackTranslator('en');
		expect(t('pageTitle', { game: getGameName('en', 'blackjack') })).toBe(
			'Blackjack - Arcturus Casino',
		);
		expect(
			blackjackTranslator('zh-Hant')('pageTitle', {
				game: getGameName('zh-Hant', 'blackjack-ranked'),
			}),
		).toBe('排位二十一點 - Arcturus Casino');
		expect(t('casual')).toBe('Casual');
		expect(blackjackTranslator('zh-Hant')('ranked')).toBe('排位');
	});

	test('wager controls and deal accessibility copy', () => {
		const t = blackjackTranslator('en');
		expect(t('dealButton')).toBe('DEAL CARDS');
		expect(t('dealAriaLabel')).toBe('Deal');
		expect(t('doubleAriaLabel')).toBe('Double Down');
		expect(t('wagerLabel', { min: '10', max: '1,000' })).toBe('Wager (10–1,000)');
		expect(t('betAmount')).toBe('Bet Amount');
		expect(t('newRoundButton')).toBe('NEW ROUND');
	});

	test('action names cover the four basic moves in every locale', () => {
		expect(blackjackTranslator('en')('hit')).toBe('Hit');
		expect(blackjackTranslator('zh-Hant')('hit')).toBe('要牌');
		expect(blackjackTranslator('zh-Hant')('stand')).toBe('停牌');
		expect(blackjackTranslator('zh-Hant')('doubleDown')).toBe('加倍');
		expect(blackjackTranslator('zh-Hant')('split')).toBe('分牌');
		expect(blackjackTranslator('ja')('hit')).toBe('ヒット');
		expect(blackjackTranslator('ja')('stand')).toBe('スタンド');
		expect(blackjackTranslator('ja')('doubleDown')).toBe('ダブルダウン');
		expect(blackjackTranslator('ja')('split')).toBe('スプリット');
	});

	test('single-hand outcome sentences', () => {
		const t = blackjackTranslator('en');
		expect(t('outcomeBlackjack')).toBe('🎉 BLACKJACK! You win!');
		expect(t('outcomeWin')).toBe('✓ You win!');
		expect(t('outcomeLoss')).toBe('✗ Dealer wins');
		expect(t('outcomePush')).toBe('🤝 Push (Tie)');
		expect(blackjackTranslator('zh-Hant')('outcomeBlackjack')).toBe('🎉 二十一點！你贏了！');
		expect(blackjackTranslator('ja')('outcomePush')).toBe('🤝 引き分け（プッシュ）');
	});

	test('split summaries assemble full sentences from per-hand results', () => {
		const t = blackjackTranslator('en');
		const hands = 'Hand 1: ✓ Win | Hand 2: ✗ Loss';
		expect(t('splitSummary', { hands, summary: t('overallWin') })).toBe(
			'Hand 1: ✓ Win | Hand 2: ✗ Loss — Overall: You win! 🎉',
		);
		expect(t('splitSummary', { hands, summary: t('overallLoss') })).toBe(
			'Hand 1: ✓ Win | Hand 2: ✗ Loss — Overall: Dealer wins',
		);
		expect(t('splitSummary', { hands, summary: t('overallSplit') })).toBe(
			'Hand 1: ✓ Win | Hand 2: ✗ Loss — Overall: Split result',
		);
		expect(blackjackTranslator('zh-Hant')('splitHandResult', { number: '1', result: '✓ 贏' })).toBe(
			'第 1 手：✓ 贏',
		);
		expect(blackjackTranslator('ja')('splitHandResult', { number: '1', result: '✓ 勝ち' })).toBe(
			'ハンド 1：✓ 勝ち',
		);
	});

	test('settlement recovery copy', () => {
		const t = blackjackTranslator('en');
		expect(t('retrySettlement')).toBe('Retry settlement');
		expect(t('resetRound')).toBe('Reset round');
		expect(t('settlementFailed')).toBe(
			'Settlement failed. Retry or reset before starting another round.',
		);
		expect(t('settlementPending')).toBe(
			'Settlement is still pending. Retry or reset before starting another round.',
		);
		expect(blackjackTranslator('zh-Hant')('settlementReset')).toBe('結算已重設。請下注以開始。');
	});

	test('settings copy', () => {
		const t = blackjackTranslator('en');
		expect(t('startingChips')).toBe('Starting Chips');
		expect(t('minimumBet')).toBe('Minimum Bet');
		expect(t('maximumBet')).toBe('Maximum Bet');
		expect(t('dealerSpeed')).toBe('Dealer Speed');
		expect(t('dealerSpeedFast')).toBe('Fast (0.5s)');
		expect(t('settingsSaved')).toBe('Settings saved. They will apply to new rounds.');
		expect(t('settingsReset')).toBe('Settings reset to defaults.');
		expect(t('betRangeError', { min: '$50', max: '$200' })).toBe(
			'Bet must be between $50 and $200',
		);
		expect(t('insufficientBalance')).toBe('Insufficient balance');
	});

	test('AI advisor copy', () => {
		const t = blackjackTranslator('en');
		expect(t('askAiRival')).toBe('Ask AI Rival');
		expect(t('aiThinking')).toBe('Thinking...');
		expect(t('aiRecommended', { action: t('hit') })).toBe('Recommended: Hit');
		expect(t('noLegalRecommendation')).toBe('No legal recommendation');
		expect(blackjackTranslator('ja')('aiRecommended', { action: 'スタンド' })).toBe(
			'推奨：スタンド',
		);
	});

	test('ranked countdown, status, and result copy', () => {
		const t = blackjackTranslator('en');
		expect(t('rankedIdle')).toBe('Choose a wager to begin a ranked run.');
		expect(t('recoveringRun')).toBe('Recovering ranked run…');
		expect(t('yourMoveStatus', { current: '1', total: '2' })).toBe('Your move · hand 1 of 2');
		expect(t('runExpired')).toBe('Run expired · wager forfeited');
		expect(t('runSettled', { outcome: t('wordWin') })).toBe('win · run settled');
		expect(t('wagerRange', { min: '10', max: '1,000' })).toBe(
			'Wager must be a whole number between 10 and 1,000.',
		);
		expect(t('resultWin')).toBe('Win');
		expect(t('resultLoss')).toBe('Loss');
		expect(t('resultPush')).toBe('Push');
		expect(t('startRankedRun')).toBe('Start Ranked Run');
		expect(t('resultFinalBalance')).toBe('Final balance');
		expect(blackjackTranslator('ja')('runSettled', { outcome: '勝ち' })).toBe('勝ち · 決済済み');
	});

	test('chip amounts render per locale with the shared number helpers', () => {
		expect(formatBlackjackAmount('en', 742)).toBe('$742');
		expect(formatBlackjackAmount('en', 1000)).toBe('$1,000');
		expect(formatBlackjackAmount('zh-Hant', 742)).toBe('742 籌碼');
		expect(formatBlackjackAmount('zh-Hans', 10000)).toBe('10,000 筹码');
		expect(formatBlackjackAmount('ja', 1)).toBe('1 チップ');
		expect(formatBlackjackNet('en', 100)).toBe('+$100');
		expect(formatBlackjackNet('en', -100)).toBe('-$100');
		expect(formatBlackjackNet('en', 0)).toBe('$0');
		expect(formatBlackjackNet('zh-Hant', -50)).toBe('−50 籌碼');
		expect(formatBlackjackNet('ja', 0)).toBe('0 チップ');
	});

	test('the header balance pill uses the shared chips phrase', () => {
		expect(formatChips(742, 'en')).toBe('742 chips');
		expect(formatChips(742, 'zh-Hant')).toBe('742 籌碼');
	});

	test('every supported locale serves non-empty copy for the key surfaces', () => {
		for (const locale of SUPPORTED_LOCALES) {
			const t = blackjackTranslator(locale);
			for (const key of [
				'placeBet',
				'outcomeWin',
				'rankedIdle',
				'runExpired',
				'settingsSaved',
				'askAiRival',
				'yourTurn',
				'playingHand',
			] as const) {
				expect(t(key).length).toBeGreaterThan(0);
			}
		}
	});
});
