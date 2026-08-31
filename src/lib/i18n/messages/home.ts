/**
 * Home/lobby presentation messages. Game titles come only from the shared
 * game-name catalog (`getGameName`); this module never retranslates them.
 */

import type { Locale } from '../locale';
import { createTranslator, defineMessages } from '../translate';

/** Copy for the lobby game card: badge, meta line, and call to action. */
export const GAME_CARD_MESSAGES = defineMessages({
	en: {
		featured: 'Featured',
		playersPlaying: '{count} playing',
		minBet: 'Min {minBet}',
		play: 'Play',
	},
	'zh-Hant': {
		featured: '精選',
		playersPlaying: '{count} 人遊玩中',
		minBet: '最低 {minBet}',
		play: '開始遊玩',
	},
	'zh-Hans': {
		featured: '精选',
		playersPlaying: '{count} 人游玩中',
		minBet: '最低 {minBet}',
		play: '开始游玩',
	},
	ja: {
		featured: '注目',
		playersPlaying: '{count} 人がプレイ中',
		minBet: '最低 {minBet}',
		play: 'プレイ',
	},
});

/** Copy for the home page: hero, sections, features, and closing CTA. */
export const HOME_MESSAGES = defineMessages({
	en: {
		pageTitle: 'Arcturus Casino - Premium Online Gaming',
		heroEyebrow: 'Est. MMXXV · Premium Play',
		heroHeading: 'Welcome to <em>Arcturus</em>',
		heroBody:
			'A virtual casino built for the thrill of the game. Play poker, blackjack, baccarat and more — 100% free, no real money required.',
		ctaJoinFree: 'Join Free — Get {chips}',
		ctaPlayNow: 'Play Now',
		ctaDashboard: 'Dashboard',
		statFreeToPlay: 'Free to Play',
		statPlayersOnline: 'Players Online',
		statStartingChips: 'Starting Chips',
		floorEyebrow: 'The Floor',
		featuredTables: 'Featured Tables',
		lineupEyebrow: 'Full Lineup',
		lineupBody:
			'Sharpen your skills across the full table lineup. Everything is free to play — earn chips, test new strategies, and find your next favorite game.',
		houseEyebrow: 'House Welcome',
		houseHeading: 'A Toast to New Players',
		houseBody:
			'Claim a 100% chip match on your first refill, plus a standing invitation to the private VIP tables.',
		ctaClaimBonus: 'Claim Bonus',
		differenceEyebrow: 'The Difference',
		whyHeading: 'Why Arcturus',
		featureNoMoneyTitle: 'No Real Money',
		featureNoMoneyBody:
			'Play with virtual chips only. All the thrill of the casino floor, none of the risk.',
		featureUnlimitedTitle: 'Unlimited Play',
		featureUnlimitedBody:
			'Out of chips? Claim a daily bonus and return to the table. The night never ends.',
		featureSharpenTitle: 'Sharpen Your Game',
		featureSharpenBody:
			'Refine your strategy and read the table in a risk-free room built for mastery.',
		closingEyebrow: 'Take Your Seat',
		closingHeading: 'Ready when <em>you</em> are',
		closingBody:
			'Join Arcturus today and start with 10,000 virtual chips. No credit card, no catch — just the game.',
		ctaStartPlayingFree: 'Start Playing Free',
	},
	'zh-Hant': {
		pageTitle: 'Arcturus Casino - 頂級線上娛樂場',
		heroEyebrow: '創立於 MMXXV · 頂級遊玩',
		heroHeading: '歡迎來到 <em>Arcturus</em>',
		heroBody:
			'一座為遊戲樂趣而生的虛擬賭場。撲克、二十一點、百家樂等遊戲任你玩 — 100% 免費，不涉及任何真錢。',
		ctaJoinFree: '免費加入 — 獲得 {chips}',
		ctaPlayNow: '立即遊玩',
		ctaDashboard: '控制台',
		statFreeToPlay: '免費遊玩',
		statPlayersOnline: '線上玩家',
		statStartingChips: '起始籌碼',
		floorEyebrow: '遊戲大廳',
		featuredTables: '精選遊戲桌',
		lineupEyebrow: '完整陣容',
		lineupBody:
			'在完整的遊戲陣容中磨練技術。一切免費遊玩 — 贏取籌碼、測試新策略，找到你的下一款最愛遊戲。',
		houseEyebrow: '開場歡迎',
		houseHeading: '敬新玩家一杯',
		houseBody: '首次補充籌碼即可獲得 100% 等量贈送，並獲私人 VIP 遊戲桌的常邀資格。',
		ctaClaimBonus: '領取獎勵',
		differenceEyebrow: '與眾不同之處',
		whyHeading: '為何選擇 Arcturus',
		featureNoMoneyTitle: '絕無真錢',
		featureNoMoneyBody: '只使用虛擬籌碼遊玩。享受賭場的全部刺激，不承擔任何風險。',
		featureUnlimitedTitle: '無限暢玩',
		featureUnlimitedBody: '籌碼用完了？領取每日獎勵，重返遊戲桌。狂歡之夜永不散場。',
		featureSharpenTitle: '磨練技術',
		featureSharpenBody: '在零風險的練習房中精進策略、讀懂牌桌。',
		closingEyebrow: '入座吧',
		closingHeading: '<em>你</em>準備好，隨時開局',
		closingBody: '立即加入 Arcturus，以 10,000 枚虛擬籌碼起步。無需信用卡，沒有套路 — 只有遊戲。',
		ctaStartPlayingFree: '免費開玩',
	},
	'zh-Hans': {
		pageTitle: 'Arcturus Casino - 顶级线上娱乐场',
		heroEyebrow: '创立于 MMXXV · 顶级游玩',
		heroHeading: '欢迎来到 <em>Arcturus</em>',
		heroBody:
			'一座为游戏乐趣而生的虚拟赌场。扑克、二十一点、百家乐等游戏任你玩 — 100% 免费，不涉及任何真钱。',
		ctaJoinFree: '免费加入 — 获得 {chips}',
		ctaPlayNow: '立即游玩',
		ctaDashboard: '控制台',
		statFreeToPlay: '免费游玩',
		statPlayersOnline: '在线玩家',
		statStartingChips: '起始筹码',
		floorEyebrow: '游戏大厅',
		featuredTables: '精选游戏桌',
		lineupEyebrow: '完整阵容',
		lineupBody:
			'在完整的游戏阵容中磨练技术。一切免费游玩 — 赢取筹码、测试新策略，找到你的下一款最爱游戏。',
		houseEyebrow: '开场欢迎',
		houseHeading: '敬新玩家一杯',
		houseBody: '首次补充筹码即可获得 100% 等量赠送，并获私人 VIP 游戏桌的常邀资格。',
		ctaClaimBonus: '领取奖励',
		differenceEyebrow: '与众不同之处',
		whyHeading: '为何选择 Arcturus',
		featureNoMoneyTitle: '绝无真钱',
		featureNoMoneyBody: '只使用虚拟筹码游玩。享受赌场的全部刺激，不承担任何风险。',
		featureUnlimitedTitle: '无限畅玩',
		featureUnlimitedBody: '筹码用完了？领取每日奖励，重返游戏桌。狂欢之夜永不散场。',
		featureSharpenTitle: '磨练技术',
		featureSharpenBody: '在零风险的练习房中精进策略、读懂牌桌。',
		closingEyebrow: '入座吧',
		closingHeading: '<em>你</em>准备好，随时开局',
		closingBody: '立即加入 Arcturus，以 10,000 枚虚拟筹码起步。无需信用卡，没有套路 — 只有游戏。',
		ctaStartPlayingFree: '免费开玩',
	},
	ja: {
		pageTitle: 'Arcturus Casino - プレミアムオンラインゲーム',
		heroEyebrow: '創立 MMXXV · プレミアムプレイ',
		heroHeading: '<em>Arcturus</em>へようこそ',
		heroBody:
			'ゲームの興奮のために作られたバーチャルカジノ。ポーカー、ブラックジャック、バカラなどが勢揃い — 100% 無料、現金は一切不要です。',
		ctaJoinFree: '無料登録 — {chips} をプレゼント',
		ctaPlayNow: '今すぐプレイ',
		ctaDashboard: 'ダッシュボード',
		statFreeToPlay: '無料で遊べる',
		statPlayersOnline: 'オンラインプレイヤー',
		statStartingChips: '開始チップ',
		floorEyebrow: 'ゲームフロア',
		featuredTables: '注目のテーブル',
		lineupEyebrow: 'ラインナップ',
		lineupBody:
			'全テーブルラインナップで腕を磨きましょう。すべて無料でプレイ可能 — チップを獲得し、新しい戦略を試して、次のお気に入りを見つけてください。',
		houseEyebrow: 'ウェルカム',
		houseHeading: '新規プレイヤーに乾杯',
		houseBody:
			'初回のチップ補充で 100% を同量プレゼント。さらにプライベート VIP テーブルへのご招待も。',
		ctaClaimBonus: 'ボーナスを受け取る',
		differenceEyebrow: 'Arcturus の違い',
		whyHeading: 'Arcturus が選ばれる理由',
		featureNoMoneyTitle: '現金不要',
		featureNoMoneyBody:
			'バーチャルチップだけのプレイ。カジノフロアの興奮をすべて、リスクなしでお届けします。',
		featureUnlimitedTitle: '無限プレイ',
		featureUnlimitedBody:
			'チップを使い切りましたか？デイリーボーナスを受け取って、テーブルに戻りましょう。夜は終わりません。',
		featureSharpenTitle: '腕を磨く',
		featureSharpenBody: 'リスクのない練習ルームで戦略を研ぎ澄まし、牌を読み抜けましょう。',
		closingEyebrow: 'ご着席ください',
		closingHeading: '<em>あなた</em>の準備ができたら、いつでも',
		closingBody:
			'今すぐ Arcturus に参加して、10,000 枚のバーチャルチップでスタート。クレジットカード不要、駆け引きなし — ゲームだけです。',
		ctaStartPlayingFree: '無料でプレイ開始',
	},
});

export function homeTranslator(locale: Locale) {
	return createTranslator(HOME_MESSAGES, locale);
}

export function gameCardTranslator(locale: Locale) {
	return createTranslator(GAME_CARD_MESSAGES, locale);
}
