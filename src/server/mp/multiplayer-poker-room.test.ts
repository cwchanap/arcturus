import { describe, expect, test } from 'bun:test';
import { applyAction, createRoom, takeSeat, startHand, type Room } from '../../lib/mp-poker/engine';
import { EMPTY_ROOM_TIMEOUT_MS, RECONNECT_TIMEOUT_MS } from '../../lib/mp-poker/timers';
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
	return startHand(room, { deckSeed: 'arcturus-test' });
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
		setPrivateField(object, 'room', room);
		setPrivateField(object, 'turnDeadline', now - 1);
		await object.alarm();
		const after = privateField<Room>(object, 'room');
		expect(after.phase).toBe('waiting');
		expect(after.hand).toBeNull();
		expect(after.seats.find((seat) => seat.userId === allInUserId)).toBeUndefined();
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
});
