/**
 * Typed message dictionaries. English is the authoring shape; the other
 * supported locales are constrained to exactly the same keys at compile time.
 * `defineMessages()` is an identity helper (zero runtime cost, it returns the
 * English branch) and `createTranslator()` only selects a branch and replaces
 * named `{token}` placeholders. No ICU, no plural framework, no runtime
 * key-parity machinery.
 */

import type { Locale } from './locale';

/** A single message template with named `{token}` placeholders. */
export type MessageShape = Record<string, string>;

/** Token values accepted by interpolation. */
export type MessageTokens = Record<string, string | number>;

/**
 * One locale branch: every English key required, every English key a string.
 * Excess keys on the authoring object literal are rejected too.
 */
type MessageBranch<Shape extends MessageShape> = { [K in keyof Shape]: string };

/**
 * A complete message dictionary: `en` plus every other supported locale,
 * each matching the English key set exactly.
 */
export type Messages<Shape extends MessageShape> = { en: Shape } & {
	[L in Exclude<Locale, 'en'>]: MessageBranch<Shape>;
};

/**
 * Define a message dictionary. The key set is inferred from the `en` branch;
 * missing or extra keys in any other branch are compile-time errors.
 */
export function defineMessages<Shape extends MessageShape>(
	messages: { en: Shape } & {
		[L in Exclude<Locale, 'en'>]: MessageBranch<NoInfer<Shape>>;
	},
): Messages<Shape> {
	return messages;
}

/**
 * Extract the message key union from a dictionary returned by
 * `defineMessages()` (whose runtime type is keyed by locale).
 */
export type MessageKey<Dictionary extends Messages<MessageShape>> =
	Dictionary extends Messages<infer Shape> ? keyof Shape : never;

/** A translate function bound to one dictionary and one locale. */
export type Translator<Shape extends MessageShape> = (
	key: keyof Shape,
	tokens?: MessageTokens,
) => string;

/**
 * Bind a dictionary and locale to a translate function. Dictionaries are
 * statically complete, so lookup needs no runtime missing-key fallback.
 */
export function createTranslator<Shape extends MessageShape>(
	messages: Messages<Shape>,
	locale: Locale,
): Translator<Shape> {
	const branch = messages[locale] as Shape;
	return (key, tokens) => {
		const template = branch[key];
		if (!tokens) return template;
		return template.replace(/\{(\w+)\}/g, (match, name: string) => {
			const value = tokens[name];
			return value === undefined ? match : String(value);
		});
	};
}
