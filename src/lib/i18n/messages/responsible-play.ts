/**
 * Responsible-play information page copy: the public /responsible-play page
 * explaining that chips are play money with no cash value, encouraging
 * breaks and personal limits, and noting the adult (18+) audience. The copy
 * is informational only — it must not claim an implemented age gate or any
 * licensing/regulatory status, because none exists.
 */

import type { Locale } from '../locale';
import { createTranslator, defineMessages } from '../translate';

export const RESPONSIBLE_PLAY_MESSAGES = defineMessages({
	en: {
		pageTitle: 'Responsible Play - Arcturus Casino',
		title: 'Responsible Play',
		intro:
			'Arcturus is a play-money casino. This page explains what that means and how to keep your visits enjoyable.',
		playMoneyTitle: 'Play money only',
		playMoneyBody:
			'All chips on Arcturus are virtual play money. They have no cash value and cannot be exchanged for real money.',
		breaksTitle: 'Breaks and personal limits',
		breaksBody:
			'The games are meant for entertainment. Take regular breaks, decide on a time and chip budget before you start, and step away when it stops being fun.',
		adultTitle: 'Adult audience',
		adultBody:
			'Arcturus is intended for players aged 18 and over. If you are under 18, please do not use this site.',
	},
	'zh-Hant': {
		pageTitle: '負責任遊玩 - Arcturus Casino',
		title: '負責任遊玩',
		intro: 'Arcturus 是使用遊戲貨幣的賭場。此頁說明這代表什麼，以及如何保持愉快的遊玩體驗。',
		playMoneyTitle: '純遊戲貨幣',
		playMoneyBody: 'Arcturus 的所有籌碼皆為虛擬遊戲貨幣，沒有現金價值，也無法兌換成真實金錢。',
		breaksTitle: '休息與個人限度',
		breaksBody:
			'遊戲是為了娛樂。請定期休息，開始前先決定遊玩時間與籌碼預算，當樂趣不再時就停下來。',
		adultTitle: '成人觀眾',
		adultBody: 'Arcturus 以 18 歲以上玩家為對象。如果你未滿 18 歲，請勿使用本網站。',
	},
	'zh-Hans': {
		pageTitle: '负责任游玩 - Arcturus Casino',
		title: '负责任游玩',
		intro: 'Arcturus 是使用游戏货币的赌场。此页说明这代表什么，以及如何保持愉快的游玩体验。',
		playMoneyTitle: '纯游戏货币',
		playMoneyBody: 'Arcturus 的所有筹码均为虚拟游戏货币，没有现金价值，也无法兑换成真实金钱。',
		breaksTitle: '休息与个人限度',
		breaksBody:
			'游戏是为了娱乐。请定期休息，开始前先决定游玩时间与筹码预算，当乐趣不再时就停下来。',
		adultTitle: '成人观众',
		adultBody: 'Arcturus 以 18 岁以上玩家为对象。如果你未满 18 岁，请勿使用本网站。',
	},
	ja: {
		pageTitle: '責任あるプレイ - Arcturus Casino',
		title: '責任あるプレイ',
		intro:
			'Arcturus はゲーム内通貨で遊ぶカジノです。このページではその意味と、楽しくプレイし続けるためのヒントを紹介します。',
		playMoneyTitle: 'ゲーム内通貨のみ',
		playMoneyBody:
			'Arcturus のすべてのチップは仮想のゲーム内通貨で、現金価値はなく、実際のお金と交換することもできません。',
		breaksTitle: '休憩と自分の限度',
		breaksBody:
			'ゲームは娯楽のためのものです。定期的に休憩をとり、プレイ前に時間とチップの予算を決めて、楽しくなくなったら離れましょう。',
		adultTitle: '成人向け',
		adultBody:
			'Arcturus は 18 歳以上のプレイヤーを対象としています。18 歳未満の方は本サイトをご利用にならないでください。',
	},
});

export function responsiblePlayTranslator(locale: Locale) {
	return createTranslator(RESPONSIBLE_PLAY_MESSAGES, locale);
}
