/**
 * Shared i18n presentation messages: the app-wide localized chip phrase,
 * shell copy used by the global layout/navigation, and the settlement copy
 * reused across game surfaces. Feature dictionaries live in sibling modules.
 */

import { formatWholeNumber } from '../../formatting';
import type { Locale } from '../locale';
import { createTranslator, defineMessages } from '../translate';

const CHIP_PHRASES = defineMessages({
	en: { one: '{count} chip', other: '{count} chips' },
	'zh-Hant': { one: '{count} 籌碼', other: '{count} 籌碼' },
	'zh-Hans': { one: '{count} 筹码', other: '{count} 筹码' },
	ja: { one: '{count} チップ', other: '{count} チップ' },
});

/**
 * Format a chip amount as a localized phrase ("1 chip", "10,000 chips",
 * or the CJK invariant noun form). This is the one chip-amount convention:
 * chips, never currency.
 */
export function formatChips(value: number, locale: Locale): string {
	const key = locale === 'en' && value === 1 ? 'one' : 'other';
	return createTranslator(CHIP_PHRASES, locale)(key, {
		count: formatWholeNumber(value, locale),
	});
}

/** Copy for the global shell: header, footer, and user navigation. */
export const SHELL_MESSAGES = defineMessages({
	en: {
		premiumCasino: 'Premium Casino',
		missions: 'Missions',
		leaderboard: 'Leaderboard',
		profile: 'Profile',
		signIn: 'Sign In',
		joinFree: 'Join Free',
		games: 'Games',
		allGames: 'All Games',
		legal: 'Legal',
		responsibleGaming: 'Responsible Gaming',
		adultsOnly: '18+ Only',
		copyright: '© {year} Arcturus Casino. All rights reserved. Play responsibly.',
	},
	'zh-Hant': {
		premiumCasino: '頂級賭場',
		missions: '任務',
		leaderboard: '排行榜',
		profile: '個人檔案',
		signIn: '登入',
		joinFree: '免費加入',
		games: '遊戲',
		allGames: '所有遊戲',
		legal: '法律資訊',
		responsibleGaming: '負責任博彩',
		adultsOnly: '僅限 18 歲以上',
		copyright: '© {year} Arcturus Casino。版權所有。請理性遊玩。',
	},
	'zh-Hans': {
		premiumCasino: '顶级赌场',
		missions: '任务',
		leaderboard: '排行榜',
		profile: '个人档案',
		signIn: '登录',
		joinFree: '免费加入',
		games: '游戏',
		allGames: '所有游戏',
		legal: '法律信息',
		responsibleGaming: '负责任博彩',
		adultsOnly: '仅限 18 岁以上',
		copyright: '© {year} Arcturus Casino。版权所有。请理性游玩。',
	},
	ja: {
		premiumCasino: 'プレミアムカジノ',
		missions: 'ミッション',
		leaderboard: 'ランキング',
		profile: 'プロフィール',
		signIn: 'ログイン',
		joinFree: '無料登録',
		games: 'ゲーム',
		allGames: 'すべてのゲーム',
		legal: '法的情報',
		responsibleGaming: '責任あるギャンブル',
		adultsOnly: '18歳以上限定',
		copyright: '© {year} Arcturus Casino. All rights reserved. 責任あるプレイを心がけてください。',
	},
});
