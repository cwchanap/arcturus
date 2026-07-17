/**
 * Shared DOM mock for roulette client/renderer unit tests.
 *
 * Bun test runs without a DOM, so we provide a minimal, behavior-correct
 * fake document + element implementation sufficient to drive the roulette
 * UI renderer and the roulette client wiring (event listeners, fetch,
 * crypto, timers). Not a full DOM — only the surface the roulette code uses.
 */

export class MockElement {
	id = '';
	tagName = '';
	textContent = '';
	innerHTML = '';
	hidden = false;
	disabled = false;
	isConnected = true;
	dataset: Record<string, string> = {};
	style: Record<string, string> = {};
	attributes: Record<string, string> = {};
	children: MockElement[] = [];
	parentNode: MockElement | null = null;
	private _className = '';
	classList = {
		_tokens: new Set<string>(),
		add: (c: string) => this.classList._tokens.add(c),
		remove: (c: string) => this.classList._tokens.delete(c),
		toggle: (c: string, force?: boolean) => {
			if (force === true) {
				this.classList._tokens.add(c);
				return true;
			}
			if (force === false) {
				this.classList._tokens.delete(c);
				return false;
			}
			if (this.classList._tokens.has(c)) {
				this.classList._tokens.delete(c);
				return false;
			}
			this.classList._tokens.add(c);
			return true;
		},
		contains: (c: string) => this.classList._tokens.has(c),
	};
	private listeners: Record<string, Set<(e: MockEvent) => void>> = {};

	constructor(tagName = 'div') {
		this.tagName = tagName.toUpperCase();
	}

	get className(): string {
		return this._className;
	}

	set className(value: string) {
		this._className = String(value);
		this.classList._tokens = new Set(String(value).split(/\s+/).filter(Boolean));
		this.attributes.class = String(value);
	}

	setAttribute(name: string, value: string): void {
		this.attributes[name] = String(value);
		if (name === 'id') this.id = String(value);
		if (name === 'class') this.className = String(value);
	}

	getAttribute(name: string): string | null {
		return name in this.attributes ? this.attributes[name] : null;
	}

	removeAttribute(name: string): void {
		delete this.attributes[name];
	}

	appendChild<T extends MockElement>(node: T): T {
		node.parentNode = this;
		this.children.push(node);
		return node;
	}

	removeChild<T extends MockElement>(node: T): T {
		this.children = this.children.filter((c) => c !== node);
		node.parentNode = null;
		return node;
	}

	replaceChildren(...nodes: MockElement[]): void {
		for (const c of this.children) c.parentNode = null;
		this.children = [];
		for (const n of nodes) this.appendChild(n);
	}

	addEventListener(type: string, handler: (e: MockEvent) => void): void {
		(this.listeners[type] ??= new Set()).add(handler);
	}

	removeEventListener(type: string, handler: (e: MockEvent) => void): void {
		this.listeners[type]?.delete(handler);
	}

	dispatchEvent(event: MockEvent): boolean {
		for (const h of this.listeners[event.type] ?? []) h(event);
		return !event.defaultPrevented;
	}

	querySelector(selector: string): MockElement | null {
		return this._queryAll(selector)[0] ?? null;
	}

	querySelectorAll(selector: string): MockElement[] {
		return this._queryAll(selector);
	}

	closest(selector: string): MockElement | null {
		// Simple support for `[id^="prefix-"]` and `.class` and `#id`.
		if (matchesSelector(this, selector)) return this;
		let node = this.parentNode;
		while (node) {
			if (matchesSelector(node, selector)) return node;
			node = node.parentNode;
		}
		return null;
	}

	private _queryAll(selector: string): MockElement[] {
		const out: MockElement[] = [];
		const walk = (el: MockElement) => {
			for (const c of el.children) {
				if (matchesSelector(c, selector)) out.push(c);
				walk(c);
			}
		};
		walk(this);
		return out;
	}
}

export class MockEvent {
	type: string;
	target: MockElement | null = null;
	defaultPrevented = false;
	key: string;
	detail: unknown;
	constructor(type: string, init: { key?: string; detail?: unknown } = {}) {
		this.type = type;
		this.key = init.key ?? '';
		this.detail = init.detail;
	}
	preventDefault(): void {
		this.defaultPrevented = true;
	}
}

function matchesSelector(el: MockElement, selector: string): boolean {
	const idPrefixMatch = selector.match(/^\[id\^="(.+?)"\]$/);
	if (idPrefixMatch) return el.id.startsWith(idPrefixMatch[1]);
	if (selector.startsWith('#')) return el.id === selector.slice(1);
	// Compound class selector: `.chip-select.selected` → require all classes.
	if (selector.startsWith('.')) {
		const classes = selector.split('.').filter(Boolean);
		return classes.every((c) => el.classList._tokens.has(c));
	}
	// Attribute selectors targeting data-* attributes:
	//   [data-bet-type]            → presence (attribute exists)
	//   [data-bet-type="straight"] → value equality
	// Resolves from either the raw `attributes` map or the camelCased `dataset`.
	const dataAttrMatch = selector.match(/^\[data-([a-z0-9-]+)(?:="([^"]*)")?\]$/i);
	if (dataAttrMatch) {
		const suffix = dataAttrMatch[1].toLowerCase();
		const expected = dataAttrMatch[2];
		const attrName = `data-${suffix}`;
		const datasetKey = suffix.replace(/-([a-z0-9])/gi, (_, c) => c.toUpperCase());
		const present = attrName in el.attributes || datasetKey in el.dataset;
		if (!present) return false;
		if (expected === undefined) return true;
		const value = el.attributes[attrName] ?? el.dataset[datasetKey];
		return value === expected;
	}
	return false;
}

export interface MockDocument {
	getElementById(id: string): MockElement | null;
	querySelector(selector: string): MockElement | null;
	querySelectorAll(selector: string): MockElement[];
	createElement(tagName: string): MockElement;
	readonly body: MockElement;
}

export interface MockDocumentSetup {
	document: MockDocument;
	elements: Record<string, MockElement>;
	registerElement(id: string, tagName?: string): MockElement;
}

/**
 * Install a mock `document` on globalThis with the given element ids
 * pre-registered (created lazily via getElementById). Returns handles to
 * the elements so tests can assert on them.
 */
export function installMockDocument(ids: string[] = []): MockDocumentSetup {
	const elements: Record<string, MockElement> = {};
	const body = new MockElement('body');

	const ensure = (id: string): MockElement => {
		if (!elements[id]) {
			const el = new MockElement('div');
			el.id = id;
			elements[id] = el;
		}
		return elements[id];
	};

	for (const id of ids) ensure(id);

	const document: MockDocument = {
		getElementById: (id: string) => (id in elements ? elements[id] : null),
		querySelector: (selector: string) => body.querySelector(selector),
		querySelectorAll: (selector: string) => body.querySelectorAll(selector),
		createElement: (tagName: string) => new MockElement(tagName),
		body,
	};

	(globalThis as unknown as { document: MockDocument }).document = document;
	// Some code paths cast to HTMLButtonElement; provide a no-op ctor.
	(globalThis as typeof globalThis & { HTMLButtonElement: unknown }).HTMLButtonElement =
		class MockHTMLButtonElement {} as unknown;

	return {
		document,
		elements,
		registerElement: (id: string, tagName = 'div') => {
			const el = ensure(id);
			el.tagName = tagName.toUpperCase();
			return el;
		},
	};
}

/** Append a child element with the given className to `body` (for querySelector). */
export function attachToBody(el: MockElement): MockElement {
	// @ts-expect-error document is mocked above
	const doc = (globalThis as unknown as { document: MockDocument }).document;
	doc.body.appendChild(el);
	return el;
}

/** Create a chip-select element attached to body with a data-amount. */
export function makeChipSelect(amount: number, selected = false): MockElement {
	const el = new MockElement('button');
	el.classList.add('chip-select');
	el.dataset.amount = String(amount);
	if (selected) el.classList.add('selected');
	attachToBody(el);
	return el;
}

export interface MockFetchResponse {
	ok: boolean;
	status: number;
	_json: unknown;
	json: () => Promise<unknown>;
}

export function makeFetchResponse(status: number, body: unknown): MockFetchResponse {
	return {
		ok: status >= 200 && status < 300,
		status,
		_json: body,
		json: async () => body,
	};
}

export interface FetchMock {
	(url: string, init?: RequestInit): Promise<MockFetchResponse>;
	calls: Array<{ url: string; init?: RequestInit }>;
	impl: ((url: string, init?: RequestInit) => Promise<MockFetchResponse>) | null;
}

export function installMockFetch(
	impl?: (url: string, init?: RequestInit) => MockFetchResponse | Promise<MockFetchResponse>,
): FetchMock {
	const fetchMock: FetchMock = Object.assign(
		async (url: string, init?: RequestInit) => {
			fetchMock.calls.push({ url, init });
			if (fetchMock.impl) return await fetchMock.impl(url, init);
			return makeFetchResponse(200, {});
		},
		{ calls: [] as Array<{ url: string; init?: RequestInit }>, impl: null },
	);
	fetchMock.impl = impl ?? null;
	(globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
	return fetchMock;
}

export interface TimerMock {
	setTimeout: (handler: () => void, ms?: number) => { handler: () => void; ms: number };
	clearTimeout: (handle: unknown) => void;
	pending: Array<{ handler: () => void; ms: number }>;
	flush: () => void;
}

/** Replace setTimeout with a synchronous recorder that never auto-fires. */
export function installMockTimers(): TimerMock {
	const pending: Array<{ handler: () => void; ms: number }> = [];
	const timerMock: TimerMock = {
		setTimeout: (handler: () => void, ms = 0) => {
			const entry = { handler, ms };
			pending.push(entry);
			return entry;
		},
		clearTimeout: (handle: unknown) => {
			const idx = pending.indexOf(handle as TimerMock['pending'][number]);
			if (idx >= 0) pending.splice(idx, 1);
		},
		pending,
		flush: () => {
			const snapshot = pending.splice(0);
			for (const e of snapshot) e.handler();
		},
	};
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	(globalThis as unknown as { setTimeout: typeof timerMock.setTimeout }).setTimeout =
		timerMock.setTimeout as unknown as typeof setTimeout;
	(globalThis as unknown as { clearTimeout: typeof timerMock.clearTimeout }).clearTimeout =
		timerMock.clearTimeout as unknown as typeof clearTimeout;
	// Attach restore so callers (or afterEach) can revert to real timers,
	// preventing leakage into tests that need real timers (e.g. Miniflare).
	(
		timerMock as TimerMock & {
			restore: () => void;
		}
	).restore = () => {
		(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = originalSetTimeout;
		(globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout =
			originalClearTimeout;
	};
	return timerMock;
}

export interface WindowMock {
	dispatchEvent: (event: { type: string; detail: unknown }) => boolean;
	addEventListener: (type: string, handler: (e: MockEvent) => void) => void;
	CustomEvent: new (type: string, init: { detail: unknown }) => { type: string; detail: unknown };
	listeners: Record<string, Set<(e: MockEvent) => void>>;
}

export function installMockWindow(): WindowMock {
	const listeners: Record<string, Set<(e: MockEvent) => void>> = {};
	const win: WindowMock = {
		listeners,
		addEventListener: (type: string, handler: (e: MockEvent) => void) => {
			(listeners[type] ??= new Set()).add(handler);
		},
		dispatchEvent: (event: { type: string; detail: unknown }) => {
			for (const h of listeners[event.type] ?? []) {
				h(new MockEvent(event.type, { detail: event.detail }));
			}
			return true;
		},
		CustomEvent: class {
			type: string;
			detail: unknown;
			constructor(type: string, init: { detail: unknown }) {
				this.type = type;
				this.detail = init.detail;
			}
		},
	};
	(globalThis as unknown as { window: WindowMock }).window = win;
	(globalThis as unknown as { CustomEvent: WindowMock['CustomEvent'] }).CustomEvent =
		win.CustomEvent;
	return win;
}

export function installMockCrypto(overrides?: {
	randomUUID?: () => string;
	getRandomValues?: (buf: Uint8Array) => Uint8Array;
}): void {
	const crypto = {
		randomUUID: overrides?.randomUUID ?? (() => 'mock-uuid-' + Math.random().toString(36).slice(2)),
		getRandomValues:
			overrides?.getRandomValues ??
			((buf: Uint8Array) => {
				for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
				return buf;
			}),
	};
	(globalThis as typeof globalThis & { crypto: typeof crypto }).crypto = crypto;
}

export function installMockLocalStorage(initial: Record<string, string> = {}): Storage {
	const store: Record<string, string> = { ...initial };
	const storage: Storage = {
		getItem: (key: string) => (key in store ? store[key] : null),
		setItem: (key: string, value: string) => {
			store[key] = String(value);
		},
		removeItem: (key: string) => {
			delete store[key];
		},
		clear: () => {
			for (const k of Object.keys(store)) delete store[k];
		},
		key: (index: number) => Object.keys(store)[index] ?? null,
		length: Object.keys(store).length,
	};
	(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = storage;
	return storage;
}
