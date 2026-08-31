// src/lib/baccarat/BaccaratUIRenderer.test.ts
//
// Locale contract for the Baccarat renderer: the document locale set by
// AppLayout (data-locale) drives every user-visible dynamic state, with chip
// amounts routed through the shared formatChips() phrase.

import { Window } from 'happy-dom';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { BaccaratUIRenderer } from './BaccaratUIRenderer';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const happyWindow = new Window();
beforeAll(() => {
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		writable: true,
		value: happyWindow,
	});
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		writable: true,
		value: happyWindow.document,
	});
});
afterAll(() => {
	happyWindow.close();
	if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
	else Reflect.deleteProperty(globalThis, 'window');
	if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
	else Reflect.deleteProperty(globalThis, 'document');
});

describe('BaccaratUIRenderer locale contract', () => {
	test('renders the balance as a Japanese chip phrase when the document locale is ja', () => {
		document.body.innerHTML = '<div id="chip-balance"></div>';
		document.documentElement.dataset.locale = 'ja';

		const renderer = new BaccaratUIRenderer();
		renderer.updateBalance(1000, '#chip-balance');

		expect(document.querySelector('#chip-balance')?.textContent).toBe('1,000 チップ');
	});

	test('renders the shoe count in Japanese when the document locale is ja', () => {
		document.body.innerHTML = '<div id="shoe-count"></div>';
		document.documentElement.dataset.locale = 'ja';

		const renderer = new BaccaratUIRenderer();
		renderer.updateShoeCount(416, '#shoe-count');

		expect(document.querySelector('#shoe-count')?.textContent).toBe('416 枚');
	});
});
