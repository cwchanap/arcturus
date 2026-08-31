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
	} satisfies Record<AchievementId, string>,
	'zh-Hant': {
		rising_star: '明日之星',
		high_roller: '豪擲千金',
		champion: '冠軍',
		consistent: '常勝軍',
		comeback: '東山再起',
	},
	'zh-Hans': {
		rising_star: '明日之星',
		high_roller: '豪掷千金',
		champion: '冠军',
		consistent: '常胜军',
		comeback: '东山再起',
	},
	ja: {
		rising_star: 'ライジングスター',
		high_roller: 'ハイローラー',
		champion: 'チャンピオン',
		consistent: '常勝ウィナー',
		comeback: 'カムバックキング',
	},
});

const ACHIEVEMENT_DESCRIPTIONS = defineMessages({
	en: {
		rising_star: 'Enter the top {rank} leaderboard',
		high_roller: 'Reach the top {rank} on the leaderboard',
		champion: 'Reach #1 position on the leaderboard',
		consistent: 'Win {wins} hands across all games',
		comeback: 'Win after dropping below {threshold}',
	} satisfies Record<AchievementId, string>,
	'zh-Hant': {
		rising_star: '進入排行榜前 {rank} 名',
		high_roller: '登上排行榜前 {rank} 名',
		champion: '登上排行榜第 1 名',
		consistent: '在所有遊戲中贏得 {wins} 局',
		comeback: '在跌破 {threshold} 後贏得一局',
	},
	'zh-Hans': {
		rising_star: '进入排行榜前 {rank} 名',
		high_roller: '登上排行榜前 {rank} 名',
		champion: '登上排行榜第 1 名',
		consistent: '在所有游戏中赢得 {wins} 局',
		comeback: '在跌破 {threshold} 后赢得一局',
	},
	ja: {
		rising_star: 'リーダーボード上位 {rank} 位にランクイン',
		high_roller: 'リーダーボード上位 {rank} 位に到達',
		champion: 'リーダーボード 1 位に到達',
		consistent: '全ゲームで合計 {wins} 回勝利',
		comeback: '{threshold}を下回った後に勝利する',
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
		case 'champion':
			return translate(id);
	}
}
