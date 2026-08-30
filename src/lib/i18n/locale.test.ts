import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import {
	ENABLED_LOCALES,
	LOCALE_COOKIE,
	SUPPORTED_LOCALES,
	getDocumentLocale,
	normalizeLocaleTag,
	resolveRequestLocale,
} from './locale';

describe('locale constants', () => {
	test('SUPPORTED_LOCALES is the canonical four-locale set', () => {
		expect([...SUPPORTED_LOCALES]).toEqual(['en', 'zh-Hant', 'zh-Hans', 'ja']);
	});

	test('ENABLED_LOCALES starts as English only', () => {
		expect([...ENABLED_LOCALES]).toEqual(['en']);
	});

	test('LOCALE_COOKIE is the persisted preference cookie name', () => {
		expect(LOCALE_COOKIE).toBe('arcturus_locale');
	});
});

describe('normalizeLocaleTag', () => {
	test('maps recognized tags to canonical locales', () => {
		expect(normalizeLocaleTag('zh-TW')).toBe('zh-Hant');
		expect(normalizeLocaleTag('zh-CN')).toBe('zh-Hans');
		expect(normalizeLocaleTag('zh')).toBe('zh-Hans');
		expect(normalizeLocaleTag('ja-JP')).toBe('ja');
		expect(normalizeLocaleTag('en-US')).toBe('en');
		expect(normalizeLocaleTag('en-GB')).toBe('en');
	});

	test('maps the extended zh region and script subtags', () => {
		expect(normalizeLocaleTag('zh-HK')).toBe('zh-Hant');
		expect(normalizeLocaleTag('zh-MO')).toBe('zh-Hant');
		expect(normalizeLocaleTag('zh-Hant')).toBe('zh-Hant');
		expect(normalizeLocaleTag('zh-Hant-TW')).toBe('zh-Hant');
		expect(normalizeLocaleTag('zh-SG')).toBe('zh-Hans');
		expect(normalizeLocaleTag('zh-Hans')).toBe('zh-Hans');
		expect(normalizeLocaleTag('zh-Hans-CN')).toBe('zh-Hans');
	});

	test('is case-insensitive', () => {
		expect(normalizeLocaleTag('ZH-TW')).toBe('zh-Hant');
		expect(normalizeLocaleTag('JA')).toBe('ja');
		expect(normalizeLocaleTag('zh-hans')).toBe('zh-Hans');
	});

	test('returns null for unsupported or malformed tags', () => {
		expect(normalizeLocaleTag('fr-CA')).toBeNull();
		expect(normalizeLocaleTag('de')).toBeNull();
		expect(normalizeLocaleTag('zh-yue')).toBeNull();
		expect(normalizeLocaleTag('not a locale')).toBeNull();
		expect(normalizeLocaleTag('')).toBeNull();
		expect(normalizeLocaleTag(null)).toBeNull();
		expect(normalizeLocaleTag(undefined)).toBeNull();
	});
});

describe('resolveRequestLocale', () => {
	test('uses the brief contract cases', () => {
		expect(
			resolveRequestLocale({
				cookieLocale: 'ja',
				acceptLanguage: 'zh-TW,zh;q=0.9,en;q=0.8',
				enabledLocales: ['en'],
			}),
		).toBe('en');

		expect(
			resolveRequestLocale({
				cookieLocale: 'ja',
				acceptLanguage: 'en-US,en;q=0.9',
				enabledLocales: ['en', 'ja'],
			}),
		).toBe('ja');

		expect(
			resolveRequestLocale({
				cookieLocale: null,
				acceptLanguage: 'fr-CA,zh-TW;q=0.8,ja;q=0.7',
				enabledLocales: ['en', 'zh-Hant', 'ja'],
			}),
		).toBe('zh-Hant');
	});

	test('cookie takes precedence over Accept-Language', () => {
		expect(
			resolveRequestLocale({
				cookieLocale: 'ja',
				acceptLanguage: 'en-US,en;q=0.9',
				enabledLocales: ['en', 'ja'],
			}),
		).toBe('ja');
	});

	test('malformed cookie is skipped in favor of Accept-Language', () => {
		expect(
			resolveRequestLocale({
				cookieLocale: 'not a locale',
				acceptLanguage: 'ja-JP',
				enabledLocales: ['en', 'ja'],
			}),
		).toBe('ja');
	});

	test('unsupported cookie region falls through to enabled matching', () => {
		expect(
			resolveRequestLocale({
				cookieLocale: 'fr-CA',
				acceptLanguage: 'zh-TW',
				enabledLocales: ['en', 'zh-Hant'],
			}),
		).toBe('zh-Hant');
	});

	test('a supported-but-disabled locale is ignored for cookie and header', () => {
		expect(
			resolveRequestLocale({
				cookieLocale: 'ja',
				acceptLanguage: 'en-US,en;q=0.9',
				enabledLocales: ['en'],
			}),
		).toBe('en');

		expect(
			resolveRequestLocale({
				cookieLocale: null,
				acceptLanguage: 'ja-JP,ja;q=0.9,en;q=0.8',
				enabledLocales: ['en'],
			}),
		).toBe('en');
	});

	test('orders Accept-Language entries by q-value', () => {
		expect(
			resolveRequestLocale({
				cookieLocale: null,
				acceptLanguage: 'en;q=0.5,ja;q=0.9',
				enabledLocales: ['en', 'ja'],
			}),
		).toBe('ja');
	});

	test('keeps header order for equal q-values', () => {
		expect(
			resolveRequestLocale({
				cookieLocale: null,
				acceptLanguage: 'en,ja',
				enabledLocales: ['en', 'ja'],
			}),
		).toBe('en');
	});

	test('falls back to English when nothing recognized is enabled', () => {
		expect(
			resolveRequestLocale({
				cookieLocale: null,
				acceptLanguage: null,
				enabledLocales: ['en'],
			}),
		).toBe('en');

		expect(
			resolveRequestLocale({
				cookieLocale: 'fr',
				acceptLanguage: 'de-DE,fr;q=0.9',
				enabledLocales: ['en'],
			}),
		).toBe('en');
	});

	test('defaults to the committed ENABLED_LOCALES when not overridden', () => {
		expect(resolveRequestLocale({ cookieLocale: 'ja', acceptLanguage: 'ja-JP' })).toBe('en');
		expect(resolveRequestLocale({ cookieLocale: null, acceptLanguage: 'en-US' })).toBe('en');
	});
});

describe('getDocumentLocale', () => {
	test('reads data-locale from the document element', () => {
		const window = new Window();
		window.document.documentElement.setAttribute('data-locale', 'ja');
		expect(getDocumentLocale(window.document as unknown as Document)).toBe('ja');
	});

	test('falls back to lang when data-locale is absent', () => {
		const window = new Window();
		window.document.documentElement.setAttribute('lang', 'zh-TW');
		expect(getDocumentLocale(window.document as unknown as Document)).toBe('zh-Hant');
	});

	test('data-locale wins over lang', () => {
		const window = new Window();
		window.document.documentElement.setAttribute('data-locale', 'zh-Hans');
		window.document.documentElement.setAttribute('lang', 'en');
		expect(getDocumentLocale(window.document as unknown as Document)).toBe('zh-Hans');
	});

	test('returns English for an absent or malformed document value', () => {
		const window = new Window();
		expect(getDocumentLocale(window.document as unknown as Document)).toBe('en');

		window.document.documentElement.setAttribute('data-locale', 'fr-CA');
		expect(getDocumentLocale(window.document as unknown as Document)).toBe('en');
	});

	test('returns English without a document (SSR safety)', () => {
		expect(getDocumentLocale(undefined)).toBe('en');
	});
});
