import { describe, expect, test } from 'bun:test';
import { applyAction, createRoom, takeSeat, startHand, type Room } from '../../lib/mp-poker/engine';
import {
	EMPTY_ROOM_TIMEOUT_MS,
	RECONNECT_TIMEOUT_MS,
	TURN_TIMEOUT_MS,
} from '../../lib/mp-poker/timers';
import { MultiplayerPokerRoom } from './multiplayer-poker-room';

class MemoryStorage {
	private readonly values = new Map<string, unknown>();
	alarmAt: number | null = null;
	deleted = false;

	async get<T>(key: string): Promise<T | undefined> {
		return this.values.get(key) as T | undefined;
	}

	async put<T>(key: string, value: T): Promise<void> {
		this.values.set(key, value);
	}

	async deleteAll(): Promise<void> {
		this.values.clear();
		this.deleted = true;
	}

	async setAlarm(at: number): Promise<void> {
		this.alarmAt = at;
	}

	async deleteAlarm(): Promise<void> {
		this.alarmAt = null;
	}

	seed(key: string, value: unknown): void {
		this.values.set(key, value);
	}
}

function makeState(storage: MemoryStorage): DurableObjectState {
	return {
		storage,
		blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
		getWebSockets: () => [],
		acceptWebSocket: () => undefined,
	} as unknown as DurableObjectState;
}

function makeObject(storage = new MemoryStorage()): {
	object: MultiplayerPokerRoom;
	storage: MemoryStorage;
} {
	return { object: new MultiplayerPokerRoom(makeState(storage), {} as Env), storage };
}

function privateField<T>(object: MultiplayerPokerRoom, key: string): T {
	return (object as unknown as Record<string, unknown>)[key] as T;
}

function setPrivateField(object: MultiplayerPokerRoom, key: string, value: unknown): void {
	(object as unknown as Record<string, unknown>)[key] = value;
}

function makeRoom(): Room {
	let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10 });
	room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0 });
	room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1 });
	return startHand(room, { deckSeed: 'arcturus-test', starterUserId: 'u1' });
}

function makeSocket(onClose?: (code?: number, reason?: string) => void): WebSocket {
	return {
		send: () => undefined,
		close: onClose ?? (() => undefined),
	} as unknown as WebSocket;
}

async function withNow<T>(now: number, callback: () => Promise<T>): Promise<T> {
	const originalNow = Date.now;
	Date.now = () => now;
	try {
		return await callback();
	} finally {
		Date.now = originalNow;
	}
}

describe('MultiplayerPokerRoom room-local runtime', () => {
	test('initializes without a host secret or wallet state', async () => {
		const { object, storage } = makeObject();
		const response = await object.fetch(
			new Request('http://do/init', {
				method: 'POST',
				body: JSON.stringify({
					maxSeats: 2,
					smallBlind: 5,
					bigBlind: 10,
					roomCode: 'MP-TEST01',
				}),
			}),
		);
		expect(response.status).toBe(200);
		expect((await response.json()) as { ok: boolean }).toEqual({ ok: true });
		const persisted = await storage.get<Record<string, unknown>>('persisted');
		expect(persisted).toMatchObject({ roomCode: 'MP-TEST01', turnDeadline: null });
		expect(persisted).not.toHaveProperty('doSecret');
		expect(persisted).not.toHaveProperty('currentHandId');
	});

	test('sends personalized room state without internal identity fields', () => {
		const { object } = makeObject();
		setPrivateField(object, 'room', makeRoom());

		const messages = new Map<string, string>();
		const socketA = {
			send: (message: string) => messages.set('u1', message),
		} as unknown as WebSocket;
		const socketB = {
			send: (message: string) => messages.set('u2', message),
		} as unknown as WebSocket;
		setPrivateField(
			object,
			'sockets',
			new Map([
				[socketA, { userId: 'u1', displayName: 'Alice' }],
				[socketB, { userId: 'u2', displayName: 'Bob' }],
			]),
		);

		privateField<() => void>(object, 'sendRoomState').call(object);

		const stateA = JSON.parse(messages.get('u1')!);
		const stateB = JSON.parse(messages.get('u2')!);
		expect(stateA.yourSeat).toBe(0);
		expect(stateB.yourSeat).toBe(1);
		expect(stateA.currentSeat).toBe(stateB.currentSeat);
		expect(messages.get('u1')).not.toContain('"userId"');
		expect(messages.get('u1')).not.toContain('holeCards');
		expect(messages.get('u1')).not.toContain('deck');
	});

	test('reloads a persisted room', async () => {
		const storage = new MemoryStorage();
		const first = makeObject(storage).object;
		await first.fetch(
			new Request('http://do/init', {
				method: 'POST',
				body: JSON.stringify({ maxSeats: 4, smallBlind: 5, bigBlind: 10, roomCode: 'MP-RELOAD' }),
			}),
		);
		const second = makeObject(storage).object;
		const response = await second.fetch(new Request('http://do/metadata'));
		expect(response.status).toBe(200);
		expect((await response.json()) as Record<string, unknown>).toEqual({
			roomCode: 'MP-RELOAD',
			maxSeats: 4,
			smallBlind: 5,
			bigBlind: 10,
			occupancy: 0,
		});
	});

	test('deletes corrupt persisted state instead of reviving it', async () => {
		const storage = new MemoryStorage();
		storage.seed('persisted', { room: { phase: 'not-a-phase' }, roomCode: 'bad' });
		const { object } = makeObject(storage);
		const response = await object.fetch(new Request('http://do/metadata'));
		expect(response.status).toBe(404);
		expect(storage.deleted).toBe(true);
	});

	test('deletes structurally invalid waiting-room state', async () => {
		const storage = new MemoryStorage();
		storage.seed('persisted', {
			roomCode: 'bad-config',
			turnDeadline: null,
			emptyDeadline: null,
			room: {
				phase: 'waiting',
				config: { maxSeats: 2 },
				seats: [],
				lastDealerSeat: -1,
				hand: null,
			},
		});
		const { object } = makeObject(storage);
		const response = await object.fetch(new Request('http://do/metadata'));
		expect(response.status).toBe(404);
		expect(storage.deleted).toBe(true);
	});

	test('reconnects a seat within the grace period', async () => {
		const { object } = makeObject();
		setPrivateField(object, 'roomCode', 'MP-RECONNECT');
		const now = Date.now();
		const room = makeRoom();
		setPrivateField(object, 'room', {
			...room,
			seats: room.seats.map((seat) =>
				seat.userId === 'u1'
					? { ...seat, connected: false, disconnectedAt: now - RECONNECT_TIMEOUT_MS + 1_000 }
					: seat,
			),
		});
		const server = {
			serializeAttachment: () => undefined,
			send: () => undefined,
		} as unknown as WebSocket;
		const globalObject = globalThis as unknown as {
			WebSocketPair?: new () => unknown;
		};
		const originalWebSocketPair = globalObject.WebSocketPair;
		try {
			globalObject.WebSocketPair = class {
				client = {};
				server = server;
			};
			const handleUpgrade = privateField<(request: Request) => Promise<Response>>(
				object,
				'handleUpgrade',
			);
			const response = await handleUpgrade.call(
				object,
				new Request('http://do/ws', {
					headers: {
						Upgrade: 'websocket',
						'x-arcturus-user-id': 'u1',
						'x-arcturus-display-name': encodeURIComponent('Alice'),
					},
				}),
			);
			expect(response.status).toBe(101);
			expect(privateField<Room>(object, 'room').seats[0].connected).toBe(true);
			expect(privateField<Room>(object, 'room').seats[0].disconnectedAt).toBeNull();
		} finally {
			if (originalWebSocketPair) globalObject.WebSocketPair = originalWebSocketPair;
			else delete globalObject.WebSocketPair;
		}
	});

	test('rejects an unseated starter even when the room has two eligible seats', async () => {
		const { object } = makeObject();
		const active = makeRoom();
		setPrivateField(object, 'room', { ...active, phase: 'waiting', hand: null });
		const messages: string[] = [];
		const socket = { send: (message: string) => messages.push(message) } as unknown as WebSocket;
		setPrivateField(object, 'sockets', new Map([[socket, { userId: 'u3', displayName: 'Guest' }]]));

		await object.webSocketMessage(socket, JSON.stringify({ type: 'start_hand' }));

		expect(privateField<Room>(object, 'room').phase).toBe('waiting');
		expect(JSON.parse(messages.at(-1)!)).toMatchObject({
			type: 'error',
			code: 'INVALID_ACTION',
		});
	});

	test('rejects a disconnected starter', async () => {
		const { object } = makeObject();
		const active = makeRoom();
		setPrivateField(object, 'room', {
			...active,
			phase: 'waiting',
			hand: null,
			seats: active.seats.map((seat) =>
				seat.userId === 'u1' ? { ...seat, connected: false } : seat,
			),
		});
		const messages: string[] = [];
		const socket = { send: (message: string) => messages.push(message) } as unknown as WebSocket;
		setPrivateField(object, 'sockets', new Map([[socket, { userId: 'u1', displayName: 'Alice' }]]));

		await object.webSocketMessage(socket, JSON.stringify({ type: 'start_hand' }));

		expect(privateField<Room>(object, 'room').phase).toBe('waiting');
		expect(JSON.parse(messages.at(-1)!)).toMatchObject({ type: 'error', code: 'INVALID_ACTION' });
	});

	test('rejects a short-stacked starter', async () => {
		const { object } = makeObject();
		const active = makeRoom();
		setPrivateField(object, 'room', {
			...active,
			phase: 'waiting',
			hand: null,
			seats: active.seats.map((seat) => (seat.userId === 'u1' ? { ...seat, chips: 9 } : seat)),
		});
		const messages: string[] = [];
		const socket = { send: (message: string) => messages.push(message) } as unknown as WebSocket;
		setPrivateField(object, 'sockets', new Map([[socket, { userId: 'u1', displayName: 'Alice' }]]));

		await object.webSocketMessage(socket, JSON.stringify({ type: 'start_hand' }));

		expect(privateField<Room>(object, 'room').phase).toBe('waiting');
		expect(JSON.parse(messages.at(-1)!)).toMatchObject({ type: 'error', code: 'INVALID_ACTION' });
	});

	test('pays an expired disconnected all-in winner before clearing the seat', async () => {
		const { object, storage } = makeObject();
		setPrivateField(object, 'roomCode', 'MP-ALARM');
		const now = Date.now();
		let room = makeRoom();
		const currentUserId = room.seats[room.hand!.currentSeat].userId!;
		const allInUserId = currentUserId;
		const allInAction = applyAction(room, allInUserId, { action: 'all_in' });
		room = allInAction.room;
		const otherUserId = allInUserId === 'u1' ? 'u2' : 'u1';
		room = {
			...room,
			hand: {
				...room.hand!,
				currentSeat: room.seats.find((seat) => seat.userId === otherUserId)!.seatIndex,
			},
			seats: room.seats.map((seat) =>
				seat.userId === allInUserId
					? { ...seat, chips: 0, connected: false, disconnectedAt: now - RECONNECT_TIMEOUT_MS - 1 }
					: seat,
			),
		};
		const expectedPayout = Object.values(room.hand!.committed).reduce(
			(sum, value) => sum + value,
			0,
		);
		const allInSeatIndex = room.hand!.seatIndexMap[allInUserId];
		const messages: string[] = [];
		const observerSocket = {
			send: (message: string) => messages.push(message),
		} as unknown as WebSocket;
		setPrivateField(object, 'room', room);
		setPrivateField(object, 'turnDeadline', now - 1);
		setPrivateField(
			object,
			'sockets',
			new Map([[observerSocket, { userId: otherUserId, displayName: 'Observer' }]]),
		);
		await object.alarm();
		const handEnded = messages
			.map((message) => JSON.parse(message))
			.find((message) => message.type === 'hand_ended');
		expect(handEnded?.winners).toContainEqual({
			seatIndex: allInSeatIndex,
			amount: expectedPayout,
		});
		const after = privateField<Room>(object, 'room');
		expect(after.phase).toBe('waiting');
		expect(after.hand).toBeNull();
		expect(after.seats.find((seat) => seat.userId === allInUserId)).toBeUndefined();
		// Drop the observer socket so the room can register as empty for cleanup.
		setPrivateField(object, 'sockets', new Map());
		setPrivateField(object, 'room', {
			...after,
			seats: after.seats.map((seat) =>
				seat.userId === otherUserId
					? { ...seat, connected: false, disconnectedAt: now - RECONNECT_TIMEOUT_MS - 1 }
					: seat,
			),
		});
		await object.alarm();
		expect(privateField<Room>(object, 'room')?.seats.every((seat) => seat.userId === null)).toBe(
			true,
		);
		expect(privateField<number | null>(object, 'emptyDeadline')).toBeGreaterThan(now);
		expect(storage.alarmAt).not.toBeNull();
	});

	test('schedules empty-room cleanup without sleeping', async () => {
		const { object, storage } = makeObject();
		const room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10 });
		setPrivateField(object, 'room', room);
		setPrivateField(object, 'roomCode', 'MP-EMPTY');
		setPrivateField(object, 'emptyDeadline', Date.now() - 1);
		await object.alarm();
		expect(privateField<Room | null>(object, 'room')).toBeNull();
		expect(storage.deleted).toBe(true);
		// The persisted deadline is part of the same five-minute policy used by the
		// timer helper; this assertion guards accidental shortening in the DO.
		expect(EMPTY_ROOM_TIMEOUT_MS).toBe(300_000);
	});

	test('does not delete an empty-seated room while an unseated socket is connected', async () => {
		await withNow(1_000_000, async () => {
			const { object, storage } = makeObject();
			setPrivateField(object, 'room', createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10 }));
			setPrivateField(object, 'roomCode', 'MP-CONNECTED-EMPTY');
			setPrivateField(object, 'emptyDeadline', 999_999);
			const socket = makeSocket();
			setPrivateField(
				object,
				'sockets',
				new Map([[socket, { userId: 'u1', displayName: 'Alice' }]]),
			);

			await object.alarm();

			expect(privateField<Room | null>(object, 'room')).not.toBeNull();
			expect(privateField<number | null>(object, 'emptyDeadline')).toBeNull();
			expect(storage.deleted).toBe(false);
		});
	});

	test('starts empty cleanup after the final socket closes and closes with the peer code', async () => {
		await withNow(2_000_000, async () => {
			const { object, storage } = makeObject();
			setPrivateField(object, 'room', createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10 }));
			setPrivateField(object, 'roomCode', 'MP-CLOSE-EMPTY');
			const closeArgs: [number | undefined, string | undefined] = [undefined, undefined];
			const socket = makeSocket((code, reason) => {
				closeArgs[0] = code;
				closeArgs[1] = reason;
			});
			setPrivateField(
				object,
				'sockets',
				new Map([[socket, { userId: 'u1', displayName: 'Alice' }]]),
			);

			await (
				object.webSocketClose as unknown as (
					ws: WebSocket,
					code: number,
					reason: string,
					wasClean: boolean,
				) => Promise<void>
			)(socket, 1001, 'going away', true);

			expect(closeArgs).toEqual([1001, 'going away']);
			expect(privateField<number | null>(object, 'emptyDeadline')).toBe(
				2_000_000 + EMPTY_ROOM_TIMEOUT_MS,
			);
			expect(storage.alarmAt).toBe(2_000_000 + EMPTY_ROOM_TIMEOUT_MS);

			setPrivateField(object, 'emptyDeadline', 2_000_000);
			await object.alarm();
			expect(privateField<Room | null>(object, 'room')).toBeNull();
			expect(storage.deleted).toBe(true);
		});
	});

	test('closes errored sockets with an explicit internal-error code', async () => {
		const { object } = makeObject();
		const closeArgs: [number | undefined, string | undefined] = [undefined, undefined];
		const socket = makeSocket((code, reason) => {
			closeArgs[0] = code;
			closeArgs[1] = reason;
		});
		setPrivateField(object, 'sockets', new Map([[socket, { userId: 'u1', displayName: 'Alice' }]]));

		await object.webSocketError(socket);

		expect(closeArgs).toEqual([1011, 'WebSocket error']);
	});

	test('does not renew an expired turn when a reconnect-expired non-current player is folded', async () => {
		await withNow(3_000_000, async () => {
			const { object } = makeObject();
			let room = makeRoom();
			room = {
				...room,
				seats: [
					...room.seats.map((seat) =>
						seat.userId === 'u2' ? { ...seat, connected: false, disconnectedAt: 1 } : seat,
					),
					{
						seatIndex: 2,
						userId: 'u3',
						displayName: 'Carol',
						chips: 1_000,
						connected: true,
						disconnectedAt: null,
					},
					{
						seatIndex: 3,
						userId: 'u4',
						displayName: 'Dave',
						chips: 1_000,
						connected: true,
						disconnectedAt: null,
					},
				],
			};
			room = {
				...room,
				hand: {
					...room.hand!,
					currentSeat: 0,
					seatIndexMap: { u1: 0, u2: 1, u3: 2, u4: 3 },
					holeCards: {
						u1: room.hand!.holeCards.u1,
						u2: room.hand!.holeCards.u2,
						u3: room.hand!.holeCards.u1,
						u4: room.hand!.holeCards.u2,
					},
					committed: { ...room.hand!.committed, u3: 0, u4: 0 },
				},
			};
			setPrivateField(object, 'room', room);
			setPrivateField(object, 'turnDeadline', 2_999_999);

			await object.alarm();

			const after = privateField<Room>(object, 'room');
			expect(after.phase).toBe('in-hand');
			expect(after.hand?.folded.has('u1')).toBe(true);
			expect(after.hand?.currentSeat).toBe(2);
			expect(privateField<number | null>(object, 'turnDeadline')).toBe(3_000_000 + TURN_TIMEOUT_MS);
		});
	});
});
