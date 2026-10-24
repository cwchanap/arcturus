/**
 * Canonical achievement display names and descriptions. Achievement
 * definitions in the domain carry only language-neutral IDs, categories, and
 * icons; this module is the single presentation catalog, keyed by the closed
 * `AchievementId` union. Description templates interpolate their thresholds
 * with locale-aware number and chip formatting.
 */

import { ACHIEVEMENT_THRESHOLDS } from '../../achievements/achievement-rules';
import type { AchievementId } from '../../achievements/types';
import { formatWholeNumber } from '../../formatting';
import type { Locale } from '../locale';
import { formatChips } from './common';
import { createTranslator, defineMessages } from '../translate';

const ACHIEVEMENT_NAMES = defineMessages({
	en: {
		rising_star: 'Rising Star',
		high_roller: 'High Roller',
		champion: 'Champion',
		consistent: 'Consistent Winner',
		comeback: 'Comeback King',
		royal_treatment: 'Royal Treatment',
		sng_champion: 'Sit & Go Champion',
		triple_threat: 'Triple Threat',
		straight_up: 'Straight Up',
		big_catch: 'Big Catch',
		jackpot: 'Jackpot',
		grand_tour: 'Grand Tour',
		specialist: 'Specialist',
		big_score: 'Big Score',
	} satisfies Record<AchievementId, string>,
	'zh-Hant': {
		rising_star: '明日之星',
		high_roller: '豪擲千金',
		champion: '冠軍',
		consistent: '常勝軍',
		comeback: '東山再起',
		royal_treatment: '皇家禮遇',
		sng_champion: '錦標賽冠軍',
		triple_threat: '三重威脅',
		straight_up: '單號制勝',
		big_catch: '大豐收',
		jackpot: '頭獎',
		grand_tour: '全場巡禮',
		specialist: '單遊戲專家',
		big_score: '豪贏一局',
	},
	'zh-Hans': {
		rising_star: '明日之星',
		high_roller: '豪掷千金',
		champion: '冠军',
		consistent: '常胜军',
		comeback: '东山再起',
		royal_treatment: '皇家礼遇',
		sng_champion: '锦标赛冠军',
		triple_threat: '三重威胁',
		straight_up: '单号制胜',
		big_catch: '大丰收',
		jackpot: '头奖',
		grand_tour: '全场巡礼',
		specialist: '单游戏专家',
		big_score: '豪赢一局',
	},
	ja: {
		rising_star: 'ライジングスター',
		high_roller: 'ハイローラー',
		champion: 'チャンピオン',
		consistent: '常勝ウィナー',
		comeback: 'カムバックキング',
		royal_treatment: 'ロイヤルトリートメント',
		sng_champion: 'SNGチャンピオン',
		triple_threat: 'トリプルスレット',
		straight_up: 'ストレートアップ',
		big_catch: 'ビッグキャッチ',
		jackpot: 'ジャックポット',
		grand_tour: 'グランドツアー',
		specialist: 'スペシャリスト',
		big_score: 'ビッグスコア',
	},
});

const ACHIEVEMENT_DESCRIPTIONS = defineMessages({
	en: {
		rising_star: 'Enter the top {rank} leaderboard',
		high_roller: 'Reach the top {rank} on the leaderboard',
		champion: 'Reach #1 position on the leaderboard',
		consistent: 'Win {wins} hands across all games',
		comeback: 'Win after dropping below {threshold}',
		royal_treatment: 'Show a royal flush at a contested showdown',
		sng_champion: 'Finish 1st in a Sit & Go tournament',
		triple_threat: 'Roll three matching dice and win a bet in Sic Bo',
		straight_up: 'Win a straight-up number bet in Roulette',
		big_catch: 'Hit a 100x multiplier in Keno',
		jackpot: 'Line up five sevens in Slots',
		grand_tour: 'Play every game at least once',
		specialist: 'Win {wins} hands in a single game',
		big_score: 'Win {threshold} or more in a single game',
	} satisfies Record<AchievementId, string>,
	'zh-Hant': {
		rising_star: '進入排行榜前 {rank} 名',
		high_roller: '登上排行榜前 {rank} 名',
		champion: '登上排行榜第 1 名',
		consistent: '在所有遊戲中贏得 {wins} 局',
		comeback: '在跌破 {threshold} 後贏得一局',
		royal_treatment: '在攤牌時亮出皇家同花順',
		sng_champion: '在錦標賽中奪得第 1 名',
		triple_threat: '在骰寶擲出三顆相同骰子並贏得一注',
		straight_up: '在輪盤贏得單號下注',
		big_catch: '在基諾獲得 100 倍賠率',
		jackpot: '在老虎機連成五個七',
		grand_tour: '每款遊戲都至少遊玩一次',
		specialist: '在單一遊戲中贏得 {wins} 局',
		big_score: '在單一遊戲中贏得 {threshold} 或更多',
	},
	'zh-Hans': {
		rising_star: '进入排行榜前 {rank} 名',
		high_roller: '登上排行榜前 {rank} 名',
		champion: '登上排行榜第 1 名',
		consistent: '在所有游戏中赢得 {wins} 局',
		comeback: '在跌破 {threshold} 后赢得一局',
		royal_treatment: '在摊牌时亮出皇家同花顺',
		sng_champion: '在锦标赛中夺得第 1 名',
		triple_threat: '在骰宝掷出三颗相同骰子并赢得一注',
		straight_up: '在轮盘赢得单号下注',
		big_catch: '在基诺获得 100 倍赔率',
		jackpot: '在老虎机连成五个七',
		grand_tour: '每款游戏都至少游玩一次',
		specialist: '在单一游戏中赢得 {wins} 局',
		big_score: '在单一游戏中赢得 {threshold} 或更多',
	},
	ja: {
		rising_star: 'リーダーボード上位 {rank} 位にランクイン',
		high_roller: 'リーダーボード上位 {rank} 位に到達',
		champion: 'リーダーボード 1 位に到達',
		consistent: '全ゲームで合計 {wins} 回勝利',
		comeback: '{threshold}を下回った後に勝利する',
		royal_treatment: 'ショーダウンでロイヤルフラッシュを見せる',
		sng_champion: 'SNGトーナメントで1位になる',
		triple_threat: 'シックボーで3つの同じ目を出して賭けに勝つ',
		straight_up: 'ルーレットのストレート（単一数字）に勝つ',
		big_catch: 'キーノで100倍の配当を獲得',
		jackpot: 'スロットでセブンを5つ揃える',
		grand_tour: 'すべてのゲームを1回以上プレイする',
		specialist: '1つのゲームで {wins} 回勝利',
		big_score: '1つのゲームで {threshold} 以上勝利する',
	},
});

export function getAchievementName(locale: Locale, id: AchievementId): string {
	return createTranslator(ACHIEVEMENT_NAMES, locale)(id);
}

export function getAchievementDescription(locale: Locale, id: AchievementId): string {
	const translate = createTranslator(ACHIEVEMENT_DESCRIPTIONS, locale);
	switch (id) {
		case 'rising_star':
			return translate(id, {
				rank: formatWholeNumber(ACHIEVEMENT_THRESHOLDS.RISING_STAR_RANK, locale),
			});
		case 'high_roller':
			return translate(id, {
				rank: formatWholeNumber(ACHIEVEMENT_THRESHOLDS.HIGH_ROLLER_RANK, locale),
			});
		case 'consistent':
			return translate(id, {
				wins: formatWholeNumber(ACHIEVEMENT_THRESHOLDS.CONSISTENT_WINS, locale),
			});
		case 'comeback':
			return translate(id, {
				threshold: formatChips(ACHIEVEMENT_THRESHOLDS.COMEBACK_LOW_BALANCE, locale),
			});
		case 'specialist':
			return translate(id, {
				wins: formatWholeNumber(ACHIEVEMENT_THRESHOLDS.SPECIALIST_WINS, locale),
			});
		case 'big_score':
			return translate(id, {
				threshold: formatChips(ACHIEVEMENT_THRESHOLDS.BIG_SCORE_WIN, locale),
			});
		default:
			return translate(id);
	}
}
