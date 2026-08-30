import { describe, expect, test } from 'bun:test';
import { createTranslator, defineMessages } from './translate';

const messages = defineMessages({
	en: { greeting: 'Hello {name}', repeat: '{value} / {value}' },
	'zh-Hant': { greeting: '你好，{name}', repeat: '{value} / {value}' },
	'zh-Hans': { greeting: '你好，{name}', repeat: '{value} / {value}' },
	ja: { greeting: 'こんにちは、{name}', repeat: '{value} / {value}' },
});

describe('createTranslator', () => {
	test('selects the branch for the requested locale', () => {
		expect(createTranslator(messages, 'en')('greeting', { name: 'Ada' })).toBe('Hello Ada');
		expect(createTranslator(messages, 'zh-Hant')('greeting', { name: '阿達' })).toBe('你好，阿達');
		expect(createTranslator(messages, 'zh-Hans')('greeting', { name: '阿达' })).toBe('你好，阿达');
		expect(createTranslator(messages, 'ja')('greeting', { name: 'ケン' })).toBe('こんにちは、ケン');
	});

	test('interpolates named tokens and repeats placeholders', () => {
		const translate = createTranslator(messages, 'en');
		expect(translate('repeat', { value: 42 })).toBe('42 / 42');
		expect(translate('repeat', { value: 0 })).toBe('0 / 0');
	});

	test('leaves the template untouched when tokens are omitted', () => {
		const translate = createTranslator(messages, 'en');
		expect(translate('greeting')).toBe('Hello {name}');
	});

	test('leaves unknown tokens untouched', () => {
		const translate = createTranslator(messages, 'en');
		expect(translate('greeting', { other: 'x' })).toBe('Hello {name}');
	});
});

// Compile-time contract (verified by `bunx tsc --noEmit`): every non-English
// branch must have exactly the English key set — missing and extra keys are
// both type errors, with no runtime parity machinery.
defineMessages({
	en: { only: 'Hello {name}' },
	'zh-Hant': { only: '你好，{name}' },
	'zh-Hans': { only: '你好，{name}' },
	// @ts-expect-error a missing ja key must fail compilation
	ja: {},
});

defineMessages({
	en: { only: 'Hello {name}' },
	'zh-Hant': {
		only: '你好，{name}',
		// @ts-expect-error a locale-only extra key must fail compilation
		extra: '多餘',
	},
	'zh-Hans': { only: '你好，{name}' },
	ja: { only: 'こんにちは、{name}' },
});
