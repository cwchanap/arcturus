/** Sign-in page presentation messages. Provider names are brand identifiers. */

import type { Locale } from '../locale';
import { createTranslator, defineMessages } from '../translate';

export const AUTH_MESSAGES = defineMessages({
	en: {
		pageTitle: 'Sign In - Arcturus Casino',
		eyebrow: "Members' Entrance",
		heading: 'Welcome to <em>Arcturus</em>',
		body: 'Continue with Google to play with your virtual chip balance.',
		googleCta: 'Continue with Google',
		error: 'Google sign-in did not complete. Please try again.',
		backHome: '← Back to Home',
	},
	'zh-Hant': {
		pageTitle: '登入 - Arcturus Casino',
		eyebrow: '會員入口',
		heading: '歡迎來到 <em>Arcturus</em>',
		body: '繼續使用 Google 登入，即可使用你的虛擬籌碼餘額遊玩。',
		googleCta: '繼續使用 Google',
		error: 'Google 登入未能完成，請再試一次。',
		backHome: '← 返回首頁',
	},
	'zh-Hans': {
		pageTitle: '登录 - Arcturus Casino',
		eyebrow: '会员入口',
		heading: '欢迎来到 <em>Arcturus</em>',
		body: '继续使用 Google 登录，即可使用你的虚拟筹码余额游玩。',
		googleCta: '继续使用 Google',
		error: 'Google 登录未能完成，请重试。',
		backHome: '← 返回首页',
	},
	ja: {
		pageTitle: 'ログイン - Arcturus Casino',
		eyebrow: 'メンバーズエントランス',
		heading: '<em>Arcturus</em>へようこそ',
		body: 'Google で続行して、バーチャルチップ残高でプレイしましょう。',
		googleCta: 'Google で続行',
		error: 'Google ログインが完了しませんでした。もう一度お試しください。',
		backHome: '← ホームに戻る',
	},
});

export function authTranslator(locale: Locale) {
	return createTranslator(AUTH_MESSAGES, locale);
}
