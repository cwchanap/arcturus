/**
 * Locale model: canonical locales, tag normalization, and request/document
 * resolution. This module has no dependencies and is safe for both the
 * Cloudflare Workers runtime and the browser.
 */

export const SUPPORTED_LOCALES = ['en', 'zh-Hant', 'zh-Hans', 'ja'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

/**
 * Locales production request resolution may expose. All four supported
 * locales are enabled for the final rollout.
 */
export const ENABLED_LOCALES: readonly Locale[] = SUPPORTED_LOCALES;

export const LOCALE_COOKIE = 'arcturus_locale';

/**
 * Map a recognized language tag to a canonical supported locale:
 * zh-TW/HK/MO and zh-Hant variants → zh-Hant; zh-CN/SG and zh-Hans
 * variants and bare zh → zh-Hans; ja variants → ja; en variants → en;
 * everything else → null.
 */
export function normalizeLocaleTag(tag: string | null | undefined): Locale | null {
	if (!tag) return null;
	const value = tag.trim().toLowerCase();
	if (!value) return null;
	const [language, scriptOrRegion] = value.split('-');
	switch (language) {
		case 'en':
			return 'en';
		case 'ja':
			return 'ja';
		case 'zh':
			if (
				!scriptOrRegion ||
				scriptOrRegion === 'hans' ||
				scriptOrRegion === 'cn' ||
				scriptOrRegion === 'sg'
			) {
				return 'zh-Hans';
			}
			if (
				scriptOrRegion === 'hant' ||
				scriptOrRegion === 'tw' ||
				scriptOrRegion === 'hk' ||
				scriptOrRegion === 'mo'
			) {
				return 'zh-Hant';
			}
			return null;
		default:
			return null;
	}
}

/**
 * Order Accept-Language entries by q-value (stable for ties) and return the
 * raw tags. Parsed locally; no parser dependency.
 */
function parseAcceptLanguage(header: string | null | undefined): string[] {
	if (!header) return [];
	return header
		.split(',')
		.map((part) => {
			const [tag, ...params] = part.trim().split(';');
			let q = 1;
			for (const param of params) {
				const [name, value] = param.trim().split('=');
				if (name?.trim().toLowerCase() === 'q') {
					const parsed = Number(value);
					if (Number.isFinite(parsed)) q = parsed;
				}
			}
			return { tag: (tag ?? '').trim(), q };
		})
		.filter((entry) => entry.tag !== '')
		.sort((a, b) => b.q - a.q)
		.map((entry) => entry.tag);
}

/**
 * Resolve the locale for one request: cookie first, then the highest-q
 * recognized Accept-Language match, restricted to `enabledLocales`, with an
 * unconditional English fallback.
 */
export function resolveRequestLocale(input: {
	cookieLocale: string | null | undefined;
	acceptLanguage: string | null | undefined;
	enabledLocales?: readonly Locale[];
}): Locale {
	const enabled = input.enabledLocales ?? ENABLED_LOCALES;
	const cookieLocale = normalizeLocaleTag(input.cookieLocale);
	if (cookieLocale && enabled.includes(cookieLocale)) return cookieLocale;
	for (const tag of parseAcceptLanguage(input.acceptLanguage)) {
		const locale = normalizeLocaleTag(tag);
		if (locale && enabled.includes(locale)) return locale;
	}
	return 'en';
}

/**
 * Read the document-level locale written once by AppLayout
 * (`data-locale`, falling back to `lang`). Returns English for an absent,
 * malformed, or missing-document value so SSR/browser callers share one handoff.
 */
export function getDocumentLocale(doc?: Document): Locale {
	const root = (doc ?? (typeof document === 'undefined' ? undefined : document))?.documentElement;
	if (!root) return 'en';
	return normalizeLocaleTag(root.dataset.locale ?? root.getAttribute('lang')) ?? 'en';
}
