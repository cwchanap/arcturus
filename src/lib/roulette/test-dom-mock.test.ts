import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	attachToBody,
	installMockDocument,
	installMockFetch,
	installMockTimers,
	installMockWindow,
	installMockCrypto,
	installMockLocalStorage,
	makeChipSelect,
	makeFetchResponse,
	MockElement,
	MockEvent,
} from './test-dom-mock';

// Save originals so afterEach can restore them — prevents leakage into
// subsequent test files (e.g. Miniflare integration tests). document/window/
// localStorage are undefined in the Bun test runtime but the mock installs
// replace globalThis.* and would leak without explicit restoration.
const REAL_TIMERS = {
	setTimeout: globalThis.setTimeout,
	clearTimeout: globalThis.clearTimeout,
};
const REAL_FETCH = globalThis.fetch;
const REAL_CRYPTO = globalThis.crypto;
const REAL_DOCUMENT = (globalThis as { document?: unknown }).document;
const REAL_WINDOW = (globalThis as { window?: unknown }).window;
const REAL_LOCAL_STORAGE = (globalThis as { localStorage?: unknown }).localStorage;
const REAL_CUSTOM_EVENT = (globalThis as { CustomEvent?: unknown }).CustomEvent;
const REAL_HTML_BUTTON_ELEMENT = (globalThis as { HTMLButtonElement?: unknown }).HTMLButtonElement;

afterEach(() => {
	(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = REAL_TIMERS.setTimeout;
	(globalThis as unknown as { clearTimeout: typeof setTimeout }).clearTimeout =
		REAL_TIMERS.clearTimeout;
	(globalThis as unknown as { fetch: typeof fetch }).fetch = REAL_FETCH;
	(globalThis as typeof globalThis & { crypto: typeof crypto }).crypto = REAL_CRYPTO;
	(globalThis as { document?: unknown }).document = REAL_DOCUMENT;
	(globalThis as { window?: unknown }).window = REAL_WINDOW;
	(globalThis as { localStorage?: unknown }).localStorage = REAL_LOCAL_STORAGE;
	(globalThis as { CustomEvent?: unknown }).CustomEvent = REAL_CUSTOM_EVENT;
	(globalThis as { HTMLButtonElement?: unknown }).HTMLButtonElement = REAL_HTML_BUTTON_ELEMENT;
});

// Re-install a fresh mock document before each test so the afterEach cleanup
// (which restores globalThis.document to its real value) does not break tests
// that rely on a DOM being present without calling installMockDocument itself.
beforeEach(() => {
	installMockDocument();
});

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

describe('MockElement — attribute and class management', () => {
	it('setAttribute updates id and class', () => {
		const el = new MockElement('div');
		el.setAttribute('id', 'my-id');
		expect(el.id).toBe('my-id');
		el.setAttribute('class', 'foo bar');
		expect(el.className).toBe('foo bar');
		expect(el.classList.contains('foo')).toBe(true);
		expect(el.classList.contains('bar')).toBe(true);
	});

	it('getAttribute returns null for missing attributes', () => {
		const el = new MockElement('div');
		expect(el.getAttribute('data-missing')).toBeNull();
		el.setAttribute('data-present', 'yes');
		expect(el.getAttribute('data-present')).toBe('yes');
	});

	it('removeAttribute deletes attributes', () => {
		const el = new MockElement('div');
		el.setAttribute('data-x', '1');
		expect(el.getAttribute('data-x')).toBe('1');
		el.removeAttribute('data-x');
		expect(el.getAttribute('data-x')).toBeNull();
	});

	it('className setter syncs classList tokens', () => {
		const el = new MockElement('div');
		el.className = 'a b c';
		expect(el.classList.contains('a')).toBe(true);
		expect(el.classList.contains('b')).toBe(true);
		expect(el.classList.contains('c')).toBe(true);
		expect(el.classList.contains('d')).toBe(false);
	});

	it('classList.toggle with force adds/removes', () => {
		const el = new MockElement('div');
		expect(el.classList.toggle('x', true)).toBe(true);
		expect(el.classList.contains('x')).toBe(true);
		expect(el.classList.toggle('x', false)).toBe(false);
		expect(el.classList.contains('x')).toBe(false);
	});

	it('classList.toggle without force flips state', () => {
		const el = new MockElement('div');
		expect(el.classList.toggle('y')).toBe(true);
		expect(el.classList.contains('y')).toBe(true);
		expect(el.classList.toggle('y')).toBe(false);
		expect(el.classList.contains('y')).toBe(false);
	});
});

describe('MockElement — tree operations', () => {
	it('appendChild sets parentNode and adds to children', () => {
		const parent = new MockElement('div');
		const child = new MockElement('span');
		parent.appendChild(child);
		expect(parent.children).toContain(child);
		expect(child.parentNode).toBe(parent);
	});

	it('removeChild removes from children and clears parentNode', () => {
		const parent = new MockElement('div');
		const child = new MockElement('span');
		parent.appendChild(child);
		parent.removeChild(child);
		expect(parent.children).not.toContain(child);
		expect(child.parentNode).toBeNull();
	});

	it('replaceChildren clears old and appends new', () => {
		const parent = new MockElement('div');
		const old1 = new MockElement('span');
		const old2 = new MockElement('span');
		parent.appendChild(old1);
		parent.appendChild(old2);
		const new1 = new MockElement('p');
		parent.replaceChildren(new1);
		expect(parent.children).not.toContain(old1);
		expect(parent.children).not.toContain(old2);
		expect(parent.children).toContain(new1);
		expect(old1.parentNode).toBeNull();
	});

	it('querySelector finds nested children', () => {
		const parent = new MockElement('div');
		const child = new MockElement('button');
		child.dataset.betType = 'red';
		parent.appendChild(child);
		expect(parent.querySelector('[data-bet-type]')).toBe(child);
		expect(parent.querySelector('[data-bet-type="red"]')).toBe(child);
		expect(parent.querySelector('[data-bet-type="black"]')).toBeNull();
	});

	it('closest matches self', () => {
		const el = new MockElement('div');
		el.id = 'target';
		expect(el.closest('#target')).toBe(el);
	});

	it('closest walks up parentNode chain', () => {
		const grandparent = new MockElement('div');
		grandparent.id = 'gp';
		const parent = new MockElement('div');
		const child = new MockElement('span');
		grandparent.appendChild(parent);
		parent.appendChild(child);
		expect(child.closest('#gp')).toBe(grandparent);
	});

	it('closest returns null when no ancestor matches', () => {
		const parent = new MockElement('div');
		const child = new MockElement('span');
		parent.appendChild(child);
		expect(child.closest('#nonexistent')).toBeNull();
	});
});

describe('MockElement — event handling', () => {
	it('addEventListener + dispatchEvent calls handler', () => {
		const el = new MockElement('button');
		let called = false;
		el.addEventListener('click', () => {
			called = true;
		});
		el.dispatchEvent(new MockEvent('click'));
		expect(called).toBe(true);
	});

	it('removeEventListener stops calls', () => {
		const el = new MockElement('button');
		let count = 0;
		const handler = () => {
			count++;
		};
		el.addEventListener('click', handler);
		el.dispatchEvent(new MockEvent('click'));
		expect(count).toBe(1);
		el.removeEventListener('click', handler);
		el.dispatchEvent(new MockEvent('click'));
		expect(count).toBe(1);
	});

	it('dispatchEvent passes event to handler with key and detail', () => {
		const el = new MockElement('button');
		let receivedKey = '';
		let receivedDetail: unknown;
		el.addEventListener('keydown', (e) => {
			receivedKey = e.key;
			receivedDetail = e.detail;
		});
		el.dispatchEvent(new MockEvent('keydown', { key: 'Enter', detail: { x: 1 } }));
		expect(receivedKey).toBe('Enter');
		expect(receivedDetail).toEqual({ x: 1 });
	});

	it('preventDefault sets defaultPrevented', () => {
		const event = new MockEvent('click');
		expect(event.defaultPrevented).toBe(false);
		event.preventDefault();
		expect(event.defaultPrevented).toBe(true);
	});
});

describe('installMockDocument', () => {
	it('getElementById returns registered elements', () => {
		const doc = installMockDocument(['foo', 'bar']);
		expect(doc.document.getElementById('foo')).toBeDefined();
		expect(doc.document.getElementById('bar')).toBeDefined();
		expect(doc.document.getElementById('baz')).toBeNull();
	});

	it('registerElement creates element with tagName', () => {
		const doc = installMockDocument([]);
		const el = doc.registerElement('my-el', 'button');
		expect(el.tagName).toBe('BUTTON');
		expect(el.id).toBe('my-el');
	});

	it('createElement returns new MockElement with tagName', () => {
		const doc = installMockDocument([]);
		const el = doc.document.createElement('span');
		expect(el.tagName).toBe('SPAN');
	});

	it('querySelector/querySelectorAll delegate to body', () => {
		const doc = installMockDocument([]);
		const el = new MockElement('div');
		el.id = 'test-qsa';
		doc.document.body.appendChild(el);
		expect(doc.document.querySelector('#test-qsa')).toBe(el);
		expect(doc.document.querySelectorAll('#test-qsa')).toContain(el);
	});
});

describe('makeChipSelect', () => {
	it('creates a chip-select button with data-amount', () => {
		installMockDocument([]);
		const el = makeChipSelect(25);
		expect(el.tagName).toBe('BUTTON');
		expect(el.classList.contains('chip-select')).toBe(true);
		expect(el.dataset.amount).toBe('25');
	});

	it('marks selected when selected=true', () => {
		installMockDocument([]);
		const el = makeChipSelect(50, true);
		expect(el.classList.contains('selected')).toBe(true);
	});

	it('does not mark selected by default', () => {
		installMockDocument([]);
		const el = makeChipSelect(10);
		expect(el.classList.contains('selected')).toBe(false);
	});
});

describe('makeFetchResponse', () => {
	it('creates a response with ok=true for 2xx', () => {
		const resp = makeFetchResponse(200, { data: 1 });
		expect(resp.ok).toBe(true);
		expect(resp.status).toBe(200);
		expect(resp._json).toEqual({ data: 1 });
	});

	it('creates a response with ok=false for 4xx/5xx', () => {
		const resp = makeFetchResponse(404, { error: 'not found' });
		expect(resp.ok).toBe(false);
		expect(resp.status).toBe(404);
	});

	it('json() returns the body', async () => {
		const resp = makeFetchResponse(200, { x: 42 });
		const data = await resp.json();
		expect(data).toEqual({ x: 42 });
	});
});

describe('installMockFetch', () => {
	it('records calls and returns default 200 when no impl', async () => {
		const fetchMock = installMockFetch();
		const resp = await fetch('/test-url');
		expect(fetchMock.calls).toHaveLength(1);
		expect(fetchMock.calls[0].url).toBe('/test-url');
		expect(resp.ok).toBe(true);
	});

	it('uses provided impl for responses', async () => {
		installMockFetch(() => makeFetchResponse(404, { error: 'nope' }));
		const resp = await fetch('/test');
		expect(resp.ok).toBe(false);
		expect(resp.status).toBe(404);
	});

	it('passes init to impl', async () => {
		let receivedInit: RequestInit | undefined;
		const fetchMock = installMockFetch((_url, init) => {
			receivedInit = init;
			return makeFetchResponse(200, {});
		});
		await fetch('/test', { method: 'POST', headers: { 'X-Test': '1' } });
		expect(fetchMock.calls[0].init?.method).toBe('POST');
		expect(receivedInit?.method).toBe('POST');
	});
});

describe('installMockTimers', () => {
	it('setTimeout records pending handler without firing', () => {
		const timers = installMockTimers();
		let fired = false;
		timers.setTimeout(() => {
			fired = true;
		}, 1000);
		expect(fired).toBe(false);
		expect(timers.pending).toHaveLength(1);
	});

	it('flush fires all pending handlers', () => {
		const timers = installMockTimers();
		let count = 0;
		timers.setTimeout(() => {
			count++;
		});
		timers.setTimeout(() => {
			count++;
		});
		timers.flush();
		expect(count).toBe(2);
		expect(timers.pending).toHaveLength(0);
	});

	it('clearTimeout removes pending handler', () => {
		const timers = installMockTimers();
		let fired = false;
		const handle = timers.setTimeout(() => {
			fired = true;
		});
		timers.clearTimeout(handle);
		timers.flush();
		expect(fired).toBe(false);
	});
});

describe('installMockWindow', () => {
	it('addEventListener + dispatchEvent calls handler', () => {
		const win = installMockWindow();
		let received: unknown;
		win.addEventListener('custom-event', (e) => {
			received = e.detail;
		});
		win.dispatchEvent({ type: 'custom-event', detail: { value: 42 } });
		expect(received).toEqual({ value: 42 });
	});

	it('CustomEvent constructor sets type and detail', () => {
		const win = installMockWindow();
		const event = new win.CustomEvent('test', { detail: 'hello' });
		expect(event.type).toBe('test');
		expect(event.detail).toBe('hello');
	});
});

describe('installMockCrypto', () => {
	it('randomUUID returns a string', () => {
		installMockCrypto();
		const uuid = crypto.randomUUID();
		expect(typeof uuid).toBe('string');
		expect(uuid.length).toBeGreaterThan(0);
	});

	it('randomUUID uses provided override', () => {
		installMockCrypto({ randomUUID: () => 'fixed-uuid' });
		expect(crypto.randomUUID()).toBe('fixed-uuid');
	});

	it('getRandomValues fills the buffer', () => {
		installMockCrypto();
		const buf = new Uint8Array(4);
		crypto.getRandomValues(buf);
		for (let i = 0; i < buf.length; i++) {
			expect(buf[i]).toBeGreaterThanOrEqual(0);
			expect(buf[i]).toBeLessThanOrEqual(255);
		}
	});

	it('getRandomValues uses provided override', () => {
		installMockCrypto({
			getRandomValues: (buf) => {
				for (let i = 0; i < buf.length; i++) buf[i] = 42;
				return buf;
			},
		});
		const buf = new Uint8Array(3);
		crypto.getRandomValues(buf);
		expect(buf[0]).toBe(42);
		expect(buf[1]).toBe(42);
		expect(buf[2]).toBe(42);
	});
});

describe('installMockLocalStorage', () => {
	it('getItem returns null for missing keys', () => {
		const storage = installMockLocalStorage();
		expect(storage.getItem('missing')).toBeNull();
	});

	it('setItem and getItem round-trip', () => {
		const storage = installMockLocalStorage();
		storage.setItem('key1', 'value1');
		expect(storage.getItem('key1')).toBe('value1');
	});

	it('removeItem deletes keys', () => {
		const storage = installMockLocalStorage();
		storage.setItem('key2', 'value2');
		storage.removeItem('key2');
		expect(storage.getItem('key2')).toBeNull();
	});

	it('clear empties the store', () => {
		const storage = installMockLocalStorage();
		storage.setItem('a', '1');
		storage.setItem('b', '2');
		storage.clear();
		expect(storage.getItem('a')).toBeNull();
		expect(storage.getItem('b')).toBeNull();
	});

	it('key returns key by index', () => {
		const storage = installMockLocalStorage();
		storage.setItem('first', '1');
		storage.setItem('second', '2');
		const keys = [storage.key(0), storage.key(1)];
		expect(keys).toContain('first');
		expect(keys).toContain('second');
		expect(storage.key(99)).toBeNull();
	});

	it('length reflects initial number of items', () => {
		const storage = installMockLocalStorage({ a: '1', b: '2' });
		expect(storage.length).toBe(2);
	});

	it('accepts initial data', () => {
		const storage = installMockLocalStorage({ preset: 'value' });
		expect(storage.getItem('preset')).toBe('value');
	});
});
