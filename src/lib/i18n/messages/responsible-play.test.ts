import { describe, expect, test } from 'bun:test';
import { RESPONSIBLE_PLAY_MESSAGES } from './responsible-play';
import { SUPPORTED_LOCALES, type Locale } from '../locale';

// Truthful-copy guards for the public responsible-play page: every locale
// must state the play-money facts, and no locale may claim an implemented
// age gate or any licensing/regulatory status (none exists).

const EN_KEYS = Object.keys(RESPONSIBLE_PLAY_MESSAGES.en);

const NO_CASH_VALUE_MARKERS: Record<Locale, string> = {
	en: 'no cash value',
	'zh-Hant': '沒有現金價值',
	'zh-Hans': '没有现金价值',
	ja: '現金価値はなく',
};

// Localized markers for age-verification / licensing claims that would be
// untruthful: the site implements no age gate and holds no licence.
const FORBIDDEN_CLAIM_MARKERS: Record<Locale, string[]> = {
	en: ['verif', 'licens', 'regulat', 'complian'],
	'zh-Hant': ['驗證年齡', '執照', '牌照', '監管'],
	'zh-Hans': ['验证年龄', '执照', '牌照', '监管'],
	ja: ['年齢認証', '免許', '規制', 'コンプライアンス'],
};

describe('RESPONSIBLE_PLAY_MESSAGES', () => {
	test('every locale provides the full key set with non-empty copy', () => {
		for (const locale of SUPPORTED_LOCALES) {
			const branch = RESPONSIBLE_PLAY_MESSAGES[locale];
			expect(Object.keys(branch).sort()).toEqual([...EN_KEYS].sort());
			for (const value of Object.values(branch)) {
				expect(value.length).toBeGreaterThan(0);
			}
		}
	});

	test('states that chips have no cash value in every locale', () => {
		for (const locale of SUPPORTED_LOCALES) {
			expect(RESPONSIBLE_PLAY_MESSAGES[locale].playMoneyBody).toContain(
				NO_CASH_VALUE_MARKERS[locale],
			);
		}
	});

	test('age guidance addresses 18+ without claiming verification or licensing', () => {
		for (const locale of SUPPORTED_LOCALES) {
			const branch = RESPONSIBLE_PLAY_MESSAGES[locale];
			expect(branch.adultBody).toContain('18');
			const allCopy = Object.values(branch).join(' ').toLowerCase();
			for (const marker of FORBIDDEN_CLAIM_MARKERS[locale]) {
				expect(allCopy).not.toContain(marker.toLowerCase());
			}
		}
	});
});
