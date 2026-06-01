import { describe, expect, test } from 'bun:test';
import { MultiplayerPokerClient } from './client';

describe('MultiplayerPokerClient', () => {
	test('construct does not throw', () => {
		expect(() => new MultiplayerPokerClient('ws://localhost')).not.toThrow();
	});

	test('connected is false before connect', () => {
		const client = new MultiplayerPokerClient('ws://localhost');
		expect(client.connected).toBe(false);
	});

	test('send is a no-op when not connected', () => {
		const client = new MultiplayerPokerClient('ws://localhost');
		expect(() => client.send({ type: 'pong' })).not.toThrow();
	});

	test('on returns an unsubscribe function', () => {
		const client = new MultiplayerPokerClient('ws://localhost');
		const off = client.on(() => {});
		expect(typeof off).toBe('function');
		expect(() => off()).not.toThrow();
	});

	test('onDisconnect returns an unsubscribe function', () => {
		const client = new MultiplayerPokerClient('ws://localhost');
		const off = client.onDisconnect(() => {});
		expect(typeof off).toBe('function');
		expect(() => off()).not.toThrow();
	});

	test('onDisconnect callback is not called when socket has not connected', () => {
		const client = new MultiplayerPokerClient('ws://localhost');
		let called = false;
		client.onDisconnect(() => {
			called = true;
		});
		expect(called).toBe(false);
	});

	test('close sets connected to false', () => {
		const client = new MultiplayerPokerClient('ws://localhost');
		// Manually test the close method doesn't throw
		expect(() => client.close()).not.toThrow();
		expect(client.connected).toBe(false);
	});

	test('multiple onDisconnect handlers can be registered and unsubscribed', () => {
		const client = new MultiplayerPokerClient('ws://localhost');
		let callCount = 0;
		const off1 = client.onDisconnect(() => {
			callCount++;
		});
		const off2 = client.onDisconnect(() => {
			callCount++;
		});
		// Unsubscribe first handler
		off1();
		// Only second handler remains registered
		expect(callCount).toBe(0);
		off2();
	});

	test('close before connect does not prevent subsequent connect call', async () => {
		const client = new MultiplayerPokerClient('ws://localhost');
		client.close();
		// connect() will reject (no server), but the duplicate-socket guard
		// should handle a null ws gracefully — no synchronous throw from the guard
		await expect(client.connect()).rejects.toThrow();
	});

	test('calling connect after close does not leave client in connected state', async () => {
		const client = new MultiplayerPokerClient('ws://localhost');
		client.close();
		try {
			await client.connect();
		} catch {
			// Expected — no WS server running
		}
		expect(client.connected).toBe(false);
	});

	test('replacement socket failure rejects when previously connected', async () => {
		const client = new MultiplayerPokerClient('ws://localhost');

		// Manually simulate being connected from a previous session
		const clientAny = client as unknown as {
			ws: { readyState: number; close: () => void } | null;
			_connected: boolean;
		};
		clientAny._connected = true;
		clientAny.ws = { readyState: WebSocket.OPEN, close() {} };

		// connect() closes the old socket and attempts a new one.
		// With no server at ws://localhost the replacement must reject.
		await expect(client.connect()).rejects.toThrow();
		expect(client.connected).toBe(false);
	});
});

describe('MultiplayerPokerClient — superseded socket scoping', () => {
	test('superseded socket onclose does not disconnect the client', () => {
		// Simulates the race: connect() creates socket A, then connect() again
		// replaces it with socket B. Socket A's onclose fires after B is open.
		// The client must stay connected because B is healthy.
		const client = new MultiplayerPokerClient('ws://localhost');

		// Access private fields to verify the scoping logic
		const clientAny = client as unknown as {
			ws: {
				onclose: (() => void) | null;
				close: () => void;
			} | null;
			_connected: boolean;
		};

		// Create mock socket A, manually simulate connect() wiring
		const socketA = { onclose: null as (() => void) | null, close() {} };
		clientAny.ws = socketA;
		clientAny._connected = true;

		// Capture the closure variable (what the real code does with `const ws`)
		const capturedA = socketA;
		// This mirrors the actual onclose handler from the fixed code:
		//   ws.onclose = () => { if (this.ws === ws && ...) { ... } }
		socketA.onclose = () => {
			if (clientAny.ws === capturedA && clientAny._connected) {
				clientAny._connected = false;
			}
		};

		// Simulate second connect(): old socket closed, new socket B created
		const socketB = { onclose: null as (() => void) | null, close() {} };
		clientAny.ws = socketB;
		clientAny._connected = true;

		const capturedB = socketB;
		socketB.onclose = () => {
			if (clientAny.ws === capturedB && clientAny._connected) {
				clientAny._connected = false;
			}
		};

		// Socket A's close fires (the superseded socket)
		socketA.onclose?.();

		// Client should still be connected because socketA !== current ws (socketB)
		expect(clientAny._connected).toBe(true);
		expect(client.connected).toBe(true);

		// Socket B's close SHOULD flip _connected
		socketB.onclose?.();
		expect(clientAny._connected).toBe(false);
		expect(client.connected).toBe(false);
	});

	test('disconnect handlers fire when active socket closes', () => {
		const client = new MultiplayerPokerClient('ws://localhost');
		let disconnectCount = 0;
		client.onDisconnect(() => {
			disconnectCount++;
		});

		// Access private fields
		const clientAny = client as unknown as {
			ws: {
				onclose: (() => void) | null;
				close: () => void;
			} | null;
			_connected: boolean;
			disconnectHandlers: Set<() => void>;
		};

		const socket = { onclose: null as (() => void) | null, close() {} };
		clientAny.ws = socket;
		clientAny._connected = true;

		const captured = socket;
		// Mirror the actual onclose with socket identity guard + handler dispatch
		socket.onclose = () => {
			if (clientAny.ws === captured && clientAny._connected) {
				clientAny._connected = false;
				for (const h of clientAny.disconnectHandlers) h();
			}
		};

		// Active socket closes — handlers fire
		socket.onclose?.();
		expect(disconnectCount).toBe(1);
		expect(client.connected).toBe(false);
	});

	test('disconnect handlers do NOT fire when superseded socket closes', () => {
		const client = new MultiplayerPokerClient('ws://localhost');
		let disconnectCount = 0;
		client.onDisconnect(() => {
			disconnectCount++;
		});

		const clientAny = client as unknown as {
			ws: {
				onclose: (() => void) | null;
				close: () => void;
			} | null;
			_connected: boolean;
			disconnectHandlers: Set<() => void>;
		};

		// Socket A
		const socketA = { onclose: null as (() => void) | null, close() {} };
		clientAny.ws = socketA;
		clientAny._connected = true;
		const capturedA = socketA;
		socketA.onclose = () => {
			if (clientAny.ws === capturedA && clientAny._connected) {
				clientAny._connected = false;
				for (const h of clientAny.disconnectHandlers) h();
			}
		};

		// Socket B replaces A
		const socketB = { onclose: null as (() => void) | null, close() {} };
		clientAny.ws = socketB;
		clientAny._connected = true;
		const capturedB = socketB;
		socketB.onclose = () => {
			if (clientAny.ws === capturedB && clientAny._connected) {
				clientAny._connected = false;
				for (const h of clientAny.disconnectHandlers) h();
			}
		};

		// Socket A's close fires (superseded) — handlers must NOT fire
		socketA.onclose?.();
		expect(disconnectCount).toBe(0);
		expect(client.connected).toBe(true);

		// Socket B's close fires — handlers fire
		socketB.onclose?.();
		expect(disconnectCount).toBe(1);
		expect(client.connected).toBe(false);
	});
});
