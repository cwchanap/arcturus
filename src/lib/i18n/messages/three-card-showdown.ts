/**
 * Three-Card Showdown presentation messages: the page shell, ante/decision
 * copy, round outcomes, rules, and settlement recovery. Ante validation
 * arrives as language-neutral codes translated through this catalog. Chip
 * amounts use the shared `formatChips()` phrase, never currency.
 */

import { formatChips } from './common';
import type { Locale } from '../locale';
import { createTranslator, defineMessages } from '../translate';

export const THREE_CARD_SHOWDOWN_MESSAGES = defineMessages({
	en: {
		pageTitle: '{game} - Arcturus Casino',
		backToGames: 'Back to Games',
		subtitle: 'Ante + Play against a qualifying dealer hand. Fold and lose only the ante.',
		chooseAnte: 'Choose an ante, then deal.',
		dealer: 'Dealer',
		player: 'Player',
		ante: 'Ante',
		deal: 'Deal',
		fold: 'Fold',
		play: 'Play',
		newRound: 'New Round',
		dealt: 'Dealt. Fold or play your hand.',
		roundComplete: 'Round complete. Start a new round when ready.',
		resultFold: 'Fold · {net}',
		resultDealerNotQualified: 'Dealer does not qualify · {net}',
		resultPlayerWin: 'Player wins · {net}',
		resultTie: 'Tie · {net}',
		resultDealerWin: 'Dealer wins · {net}',
		howToPlay: 'How to Play',
		howToPlayBody:
			'Ante to receive three cards; the dealer takes three cards face down. Fold to lose only the ante, or Play a second wager equal to the ante. The dealer must hold Queen-high or better to qualify — if the dealer does not qualify, your Play wager is returned and the ante is paid 1:1. Otherwise the best three-card hand wins; a tie pushes.',
		errorWholeNumber: 'Ante must be a whole number of chips',
		errorInvalidLimits: 'Invalid bet limits',
		errorInvalidRange: 'Invalid bet range',
		errorOutOfRange: 'Bet must be between {min} and {max}',
		errorInsufficientBalance: 'Ante plus Play wager exceeds available balance',
		retrySettlement: 'Retry settlement',
		resetRound: 'Reset round',
		settlementFailed: 'Settlement failed. Retry or reset before starting another round.',
		retryingSettlement: 'Retrying settlement...',
		settlementRetryFailed: 'Settlement failed again. Retry or reset before starting another round.',
	},
	'zh-Hant': {
		pageTitle: '{game} - Arcturus Casino',
		backToGames: '返回遊戲',
		subtitle: '先下前注（Ante），再與達標的莊家手牌比大小。棄牌只輸前注。',
		chooseAnte: '請選擇前注，然後發牌。',
		dealer: '莊家',
		player: '玩家',
		ante: '前注',
		deal: '發牌',
		fold: '棄牌',
		play: '跟注',
		newRound: '新一局',
		dealt: '已發牌。棄牌或跟注。',
		roundComplete: '本局完成。準備好時開始新一局。',
		resultFold: '棄牌 · {net}',
		resultDealerNotQualified: '莊家未達標 · {net}',
		resultPlayerWin: '玩家獲勝 · {net}',
		resultTie: '和局 · {net}',
		resultDealerWin: '莊家獲勝 · {net}',
		howToPlay: '玩法說明',
		howToPlayBody:
			'下前注後獲得三張牌；莊家以三張暗牌應對。棄牌只輸前注，或下注與前注相同的金額跟注。莊家必須持有 Q 或更高的牌才達標 — 若莊家未達標，跟注退還，前注以 1:1 派彩。否則最佳三張牌獲勝；平手則和局。',
		errorWholeNumber: '前注必須是整數個籌碼',
		errorInvalidLimits: '無效的下注限制',
		errorInvalidRange: '無效的下注範圍',
		errorOutOfRange: '下注必須介於 {min} 與 {max} 之間',
		errorInsufficientBalance: '前注加跟注超過可用餘額',
		retrySettlement: '重試結算',
		resetRound: '重設本局',
		settlementFailed: '結算失敗。請重試或重設後再開始新一局。',
		retryingSettlement: '正在重試結算…',
		settlementRetryFailed: '結算再次失敗。請重試或重設後再開始新一局。',
	},
	'zh-Hans': {
		pageTitle: '{game} - Arcturus Casino',
		backToGames: '返回游戏',
		subtitle: '先下前注（Ante），再与达标的庄家手牌比大小。弃牌只输前注。',
		chooseAnte: '请选择前注，然后发牌。',
		dealer: '庄家',
		player: '玩家',
		ante: '前注',
		deal: '发牌',
		fold: '弃牌',
		play: '跟注',
		newRound: '新一局',
		dealt: '已发牌。弃牌或跟注。',
		roundComplete: '本局完成。准备好时开始新一局。',
		resultFold: '弃牌 · {net}',
		resultDealerNotQualified: '庄家未达标 · {net}',
		resultPlayerWin: '玩家获胜 · {net}',
		resultTie: '和局 · {net}',
		resultDealerWin: '庄家获胜 · {net}',
		howToPlay: '玩法说明',
		howToPlayBody:
			'下前注后获得三张牌；庄家以三张暗牌应对。弃牌只输前注，或下注与前注相同的金额跟注。庄家必须持有 Q 或更高的牌才达标 — 若庄家未达标，跟注退还，前注以 1:1 派彩。否则最佳三张牌获胜；平手则和局。',
		errorWholeNumber: '前注必须是整数个筹码',
		errorInvalidLimits: '无效的下注限制',
		errorInvalidRange: '无效的下注范围',
		errorOutOfRange: '下注必须介于 {min} 与 {max} 之间',
		errorInsufficientBalance: '前注加跟注超过可用余额',
		retrySettlement: '重试结算',
		resetRound: '重置本局',
		settlementFailed: '结算失败。请重试或重置后再开始新一局。',
		retryingSettlement: '正在重试结算…',
		settlementRetryFailed: '结算再次失败。请重试或重置后再开始新一局。',
	},
	ja: {
		pageTitle: '{game} - Arcturus Casino',
		backToGames: 'ゲームに戻る',
		subtitle:
			'アンティ＋プレイでクオリファイしたディーラーハンドに挑戦。フォールドならアンティのみ失います。',
		chooseAnte: 'アンティを選んでからディールしてください。',
		dealer: 'ディーラー',
		player: 'プレイヤー',
		ante: 'アンティ',
		deal: '配る',
		fold: 'フォールド',
		play: 'プレイ',
		newRound: '次のラウンド',
		dealt: '配りました。フォールドまたはプレイしてください。',
		roundComplete: 'ラウンド完了。準備ができたら次のラウンドを開始してください。',
		resultFold: 'フォールド · {net}',
		resultDealerNotQualified: 'ディーラーがクオリファイしていません · {net}',
		resultPlayerWin: 'プレイヤーの勝ち · {net}',
		resultTie: '引き分け · {net}',
		resultDealerWin: 'ディーラーの勝ち · {net}',
		howToPlay: '遊び方',
		howToPlayBody:
			'アンティを置いて 3 枚のカードを受け取ります。ディーラーは 3 枚を伏せて受け取ります。フォールドするとアンティのみ失い、プレイするとアンティと同額の 2 つ目の賭け金を置きます。ディーラーはクイーン以上を持っていればクオリファイ — クオリファイしない場合、プレイ賭け金は返還され、アンティは 1:1 で払戻しされます。それ以外は最も強い 3 枚のハンドが勝ち、引き分けはプッシュです。',
		errorWholeNumber: 'アンティは整数のチップで指定してください',
		errorInvalidLimits: '無効なベット制限',
		errorInvalidRange: '無効なベット範囲',
		errorOutOfRange: 'ベットは {min} から {max} の間で指定してください',
		errorInsufficientBalance: 'アンティとプレイ賭け金が残高を超えています',
		retrySettlement: '決済を再試行',
		resetRound: 'ラウンドをリセット',
		settlementFailed:
			'決済に失敗しました。別のラウンドを開始する前に再試行またはリセットしてください。',
		retryingSettlement: '決済を再試行中…',
		settlementRetryFailed:
			'決済が再び失敗しました。別のラウンドを開始する前に再試行またはリセットしてください。',
	},
});

export function threeCardShowdownTranslator(locale: Locale) {
	return createTranslator(THREE_CARD_SHOWDOWN_MESSAGES, locale);
}

/** Signed net chip result ("+10 chips", "−20 chips", "0 chips"). */
export function formatThreeCardShowdownNet(locale: Locale, value: number): string {
	if (value === 0) return formatChips(0, locale);
	return `${value > 0 ? '+' : '−'}${formatChips(Math.abs(value), locale)}`;
}
