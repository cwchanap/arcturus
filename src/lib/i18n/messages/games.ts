/**
 * Canonical game display names. Game display names are a cross-feature
 * presentation concept with one translation source: the English branch reuses
 * GAME_TYPE_LABELS (normalized "Texas Hold'em Poker") plus the lobby extras,
 * and every other locale covers exactly that key set.
 */

import { GAME_TYPE_LABELS } from '../../game-stats/constants';
import type { Locale } from '../locale';
import { createTranslator, defineMessages, type MessageKey } from '../translate';

const GAME_NAMES = defineMessages({
	en: {
		...GAME_TYPE_LABELS,
		'daily-challenge': 'Daily Challenge',
		'poker-mp': 'Multiplayer Poker',
		'blackjack-ranked': 'Ranked Blackjack',
	},
	'zh-Hant': {
		blackjack: '二十一點',
		baccarat: '百家樂',
		craps: '雙骰子',
		poker: '德州撲克',
		slots: '老虎機',
		roulette: '輪盤',
		keno: '基諾',
		'video-poker': '影音撲克',
		'sic-bo': '骰寶',
		'three-card-showdown': '三張牌對決',
		'pai-gow-poker': '牌九撲克',
		'daily-challenge': '每日挑戰',
		'poker-mp': '多人德州撲克',
		'blackjack-ranked': '排位二十一點',
	},
	'zh-Hans': {
		blackjack: '二十一点',
		baccarat: '百家乐',
		craps: '双骰子',
		poker: '德州扑克',
		slots: '老虎机',
		roulette: '轮盘',
		keno: '基诺',
		'video-poker': '视频扑克',
		'sic-bo': '骰宝',
		'three-card-showdown': '三张牌对决',
		'pai-gow-poker': '牌九扑克',
		'daily-challenge': '每日挑战',
		'poker-mp': '多人德州扑克',
		'blackjack-ranked': '排位二十一点',
	},
	ja: {
		blackjack: 'ブラックジャック',
		baccarat: 'バカラ',
		craps: 'クラップス',
		poker: 'テキサスホールデムポーカー',
		slots: 'スロット',
		roulette: 'ルーレット',
		keno: 'キノ',
		'video-poker': 'ビデオポーカー',
		'sic-bo': 'シックボー',
		'three-card-showdown': 'スリーカードショーダウン',
		'pai-gow-poker': 'パイゴウポーカー',
		'daily-challenge': 'デイリーチャレンジ',
		'poker-mp': 'マルチプレイヤーポーカー',
		'blackjack-ranked': 'ランク戦ブラックジャック',
	},
});

export type GameNameKey = MessageKey<typeof GAME_NAMES>;

export function getGameName(locale: Locale, key: GameNameKey): string {
	return createTranslator(GAME_NAMES, locale)(key);
}
