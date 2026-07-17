import { describe, expect, it } from 'bun:test';
import { attachToBody, installMockDocument, MockElement } from './test-dom-mock';

installMockDocument();

function body(): MockElement {
	return (globalThis as unknown as { document: { body: MockElement } }).document.body;
}

describe('MockElement matchesSelector (via querySelectorAll)', () => {
	it('matches presence selector [data-bet-type] from dataset', () => {
		const el = new MockElement('button');
		el.dataset.betType = 'straight';
		attachToBody(el);
		expect(body().querySelectorAll('[data-bet-type]')).toContain(el);
	});

	it('matches presence selector [data-bet-type] from raw attribute', () => {
		const el = new MockElement('button');
		el.setAttribute('data-bet-type', 'red');
		attachToBody(el);
		expect(body().querySelectorAll('[data-bet-type]')).toContain(el);
	});

	it('does not match [data-bet-type] when attribute absent', () => {
		const el = new MockElement('button');
		el.classList.add('unrelated');
		attachToBody(el);
		expect(body().querySelectorAll('[data-bet-type]')).not.toContain(el);
	});

	it('matches value selector [data-bet-type="straight"]', () => {
		const yes = new MockElement('button');
		yes.dataset.betType = 'straight';
		attachToBody(yes);
		const no = new MockElement('button');
		no.dataset.betType = 'red';
		attachToBody(no);
		const matches = body().querySelectorAll('[data-bet-type="straight"]');
		expect(matches).toContain(yes);
		expect(matches).not.toContain(no);
	});

	it('matches multi-word data attribute via dataset camelCase', () => {
		const el = new MockElement('button');
		el.dataset.betTarget = '17';
		attachToBody(el);
		expect(body().querySelectorAll('[data-bet-target]')).toContain(el);
		expect(body().querySelectorAll('[data-bet-target="17"]')).toContain(el);
		expect(body().querySelectorAll('[data-bet-target="18"]')).not.toContain(el);
	});

	it('still supports #id, .class, and [id^="prefix-"] selectors', () => {
		const byId = new MockElement('div');
		byId.id = 'foo';
		attachToBody(byId);
		expect(body().querySelectorAll('#foo')).toContain(byId);

		const byClass = new MockElement('div');
		byClass.classList.add('chip-select');
		byClass.classList.add('selected');
		attachToBody(byClass);
		expect(body().querySelectorAll('.chip-select.selected')).toContain(byClass);

		const byPrefix = new MockElement('div');
		byPrefix.id = 'seat-3';
		attachToBody(byPrefix);
		expect(body().querySelectorAll('[id^="seat-"]')).toContain(byPrefix);
	});
});
