/**
 * Mission presentation messages: the missions page copy plus the display
 * titles and descriptions for every mission definition. Mission definitions
 * in the domain carry only language-neutral IDs, metrics, and rewards; this
 * module is the single presentation catalog, keyed by the closed `MissionId`
 * union, so adding a mission without localized copy is a build error.
 */

import type { MissionId } from '../../missions/types';
import { formatWholeNumber } from '../../formatting';
import type { Locale } from '../locale';
import { createTranslator, defineMessages, type MessageTokens } from '../translate';
import { getGameName, type GameNameKey } from './games';

/**
 * Canonical game name per mission. Templates carry a `{game}` token where a
 * game name appears; the helpers below fill it from `getGameName()` so the
 * copy never re-translates a game name itself.
 */
const MISSION_GAME_KEYS: Partial<Record<MissionId, GameNameKey>> = {
	'daily-blackjack-5': 'blackjack',
	'daily-slots-20': 'slots',
	'daily-craps-3': 'craps',
	'daily-baccarat-3': 'baccarat',
	'daily-keno-5': 'keno',
};

function missionGameToken(locale: Locale, id: MissionId): MessageTokens | undefined {
	const key = MISSION_GAME_KEYS[id];
	return key ? { game: getGameName(locale, key) } : undefined;
}

const MISSION_TITLES = defineMessages({
	en: {
		'daily-blackjack-5': '{game} Streak',
		'daily-win-3': 'Three Wins',
		'daily-slots-20': 'Spin to Win',
		'daily-craps-3': 'Dice Roller',
		'daily-baccarat-3': '{game} Round',
		'daily-keno-5': 'Lucky Numbers',
		'weekly-games-3': 'Variety Seeker',
	} satisfies Record<MissionId, string>,
	'zh-Hant': {
		'daily-blackjack-5': '{game}連勝',
		'daily-win-3': '三連勝',
		'daily-slots-20': '轉出好運',
		'daily-craps-3': '骰子滾動',
		'daily-baccarat-3': '{game}回合',
		'daily-keno-5': '幸運號碼',
		'weekly-games-3': '多元探索者',
	},
	'zh-Hans': {
		'daily-blackjack-5': '{game}连胜',
		'daily-win-3': '三连胜',
		'daily-slots-20': '转出好运',
		'daily-craps-3': '骰子滚动',
		'daily-baccarat-3': '{game}回合',
		'daily-keno-5': '幸运号码',
		'weekly-games-3': '多元探索者',
	},
	ja: {
		'daily-blackjack-5': '{game}連勝',
		'daily-win-3': 'スリーピース',
		'daily-slots-20': 'スピンで勝利',
		'daily-craps-3': 'ダイスローラー',
		'daily-baccarat-3': '{game}ラウンド',
		'daily-keno-5': 'ラッキーナンバー',
		'weekly-games-3': 'バラエティシーカー',
	},
});

const MISSION_DESCRIPTIONS = defineMessages({
	en: {
		'daily-blackjack-5': 'Play {count} {game} hands',
		'daily-win-3': 'Win {count} rounds in any game',
		'daily-slots-20': 'Complete {count} {game} spins',
		'daily-craps-3': 'Play {count} {game} rounds',
		'daily-baccarat-3': 'Play {count} {game} hands',
		'daily-keno-5': 'Play {count} {game} draws',
		'weekly-games-3': 'Play {count} different game modes this week',
	} satisfies Record<MissionId, string>,
	'zh-Hant': {
		'daily-blackjack-5': '玩 {count} 手{game}',
		'daily-win-3': '在任何遊戲中贏得 {count} 回合',
		'daily-slots-20': '完成 {count} 次{game}轉動',
		'daily-craps-3': '玩 {count} 局{game}',
		'daily-baccarat-3': '玩 {count} 手{game}',
		'daily-keno-5': '玩 {count} 局{game}',
		'weekly-games-3': '本週遊玩 {count} 種不同遊戲模式',
	},
	'zh-Hans': {
		'daily-blackjack-5': '玩 {count} 手{game}',
		'daily-win-3': '在任何游戏中赢得 {count} 回合',
		'daily-slots-20': '完成 {count} 次{game}转动',
		'daily-craps-3': '玩 {count} 局{game}',
		'daily-baccarat-3': '玩 {count} 手{game}',
		'daily-keno-5': '玩 {count} 局{game}',
		'weekly-games-3': '本周游玩 {count} 种不同游戏模式',
	},
	ja: {
		'daily-blackjack-5': '{game}を {count} ハンドプレイ',
		'daily-win-3': '任意のゲームで {count} ラウンド勝利',
		'daily-slots-20': '{game}を {count} 回スピンする',
		'daily-craps-3': '{game}を {count} ラウンドプレイ',
		'daily-baccarat-3': '{game}を {count} ハンドプレイ',
		'daily-keno-5': '{game}を {count} 回プレイ',
		'weekly-games-3': '今週 {count} 種類の異なるゲームモードをプレイ',
	},
});

/** Copy for the missions page: streak banner, quest sections, and claims. */
export const MISSIONS_MESSAGES = defineMessages({
	en: {
		pageTitle: 'Missions - Arcturus Casino',
		dailyLoginStreak: 'Daily Login Streak',
		dayOfCycle: 'Day {day} of cycle',
		streakSummary: '{current}-day streak · Best: {longest}',
		todaysReward: "Today's Reward",
		claim: 'Claim',
		claimed: 'Claimed',
		inProgress: 'In Progress',
		dailyQuests: 'Daily Quests',
		weeklyGoal: 'Weekly Goal',
		rerolled: '(rerolled)',
		rerollAriaLabel: 'Reroll mission',
	},
	'zh-Hant': {
		pageTitle: '任務 - Arcturus Casino',
		dailyLoginStreak: '每日登入連續獎勵',
		dayOfCycle: '週期第 {day} 天',
		streakSummary: '連續 {current} 天 · 最佳：{longest} 天',
		todaysReward: '今日獎勵',
		claim: '領取',
		claimed: '已領取',
		inProgress: '進行中',
		dailyQuests: '每日任務',
		weeklyGoal: '每週目標',
		rerolled: '（已重擲）',
		rerollAriaLabel: '重擲任務',
	},
	'zh-Hans': {
		pageTitle: '任务 - Arcturus Casino',
		dailyLoginStreak: '每日登录连续奖励',
		dayOfCycle: '周期第 {day} 天',
		streakSummary: '连续 {current} 天 · 最佳：{longest} 天',
		todaysReward: '今日奖励',
		claim: '领取',
		claimed: '已领取',
		inProgress: '进行中',
		dailyQuests: '每日任务',
		weeklyGoal: '每周目标',
		rerolled: '（已重掷）',
		rerollAriaLabel: '重掷任务',
	},
	ja: {
		pageTitle: 'ミッション - Arcturus Casino',
		dailyLoginStreak: 'デイリーログインストリーク',
		dayOfCycle: 'サイクル {day} 日目',
		streakSummary: '{current} 日連続 · 最高：{longest} 日',
		todaysReward: '本日の報酬',
		claim: '受け取る',
		claimed: '受取済み',
		inProgress: '進行中',
		dailyQuests: 'デイリークエスト',
		weeklyGoal: 'ウィークリーゴール',
		rerolled: '（再ロール済み）',
		rerollAriaLabel: 'ミッションを再ロール',
	},
});

export function getMissionTitle(locale: Locale, id: MissionId): string {
	return createTranslator(MISSION_TITLES, locale)(id, missionGameToken(locale, id));
}

export function getMissionDescription(locale: Locale, id: MissionId, count: number): string {
	return createTranslator(MISSION_DESCRIPTIONS, locale)(id, {
		count: formatWholeNumber(count, locale),
		...missionGameToken(locale, id),
	});
}

export function missionsTranslator(locale: Locale) {
	return createTranslator(MISSIONS_MESSAGES, locale);
}
