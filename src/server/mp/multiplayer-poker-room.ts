import {
	ClientMessage,
	toHandEndedMessage,
	toRoomStateMessage,
	type ServerMessage,
} from '../../lib/mp-poker/protocol';
import {
	createRoom,
	takeSeat,
	leaveSeat,
	startHand,
	applyAction,
	forceFold,
	clearDisconnectedSeat,
	EngineError,
	type Room,
	type RoomConfig,
	type HandState,
	type RoomTransition,
} from '../../lib/mp-poker/engine';
import {
	getNextAlarmAt,
	EMPTY_ROOM_TIMEOUT_MS,
	RECONNECT_TIMEOUT_MS,
	TURN_TIMEOUT_MS,
} from '../../lib/mp-poker/timers';

interface InitRequest {
	maxSeats: number;
	smallBlind: number;
	bigBlind: number;
	roomCode: string;
}

type PersistedHand = Omit<HandState, 'folded' | 'allIn' | 'hasActed'> & {
	folded: string[];
	allIn: string[];
	hasActed: string[];
};
type PersistedRoom = Omit<Room, 'hand'> & { hand: PersistedHand | null };

interface PersistedState {
	room: PersistedRoom;
	roomCode: string;
	turnDeadline: number | null;
	emptyDeadline: number | null;
}

function roomToPersisted(room: Room): PersistedRoom {
	return {
		...room,
		hand: room.hand
			? {
					...room.hand,
					folded: Array.from(room.hand.folded),
					allIn: Array.from(room.hand.allIn),
					hasActed: Array.from(room.hand.hasActed),
				}
			: null,
	};
}

function persistedToRoom(p: PersistedRoom): Room {
	return {
		...p,
		hand: p.hand
			? {
					...p.hand,
					folded: new Set(p.hand.folded),
					allIn: new Set(p.hand.allIn),
					hasActed: new Set(p.hand.hasActed),
				}
			: null,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isCard(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.value === 'string' &&
		(value.suit === 'hearts' ||
			value.suit === 'diamonds' ||
			value.suit === 'clubs' ||
			value.suit === 'spades') &&
		isSafeNonNegativeInteger(value.rank) &&
		value.rank >= 2 &&
		value.rank <= 14
	);
}

function isCardArray(value: unknown): boolean {
	return Array.isArray(value) && value.every(isCard);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isPersistedState(value: unknown): value is PersistedState {
	if (!isRecord(value) || typeof value.roomCode !== 'string') return false;
	if (
		(value.turnDeadline !== null && !isSafeNonNegativeInteger(value.turnDeadline)) ||
		(value.emptyDeadline !== null && !isSafeNonNegativeInteger(value.emptyDeadline))
	) {
		return false;
	}
	if (!isRecord(value.room)) return false;
	const room = value.room;
	if (room.phase !== 'waiting' && room.phase !== 'in-hand') return false;
	if (!isRecord(room.config)) return false;
	const config = room.config;
	const maxSeats = config.maxSeats;
	if (maxSeats !== 2 && maxSeats !== 4 && maxSeats !== 6) {
		return false;
	}
	const smallBlind = config.smallBlind;
	const bigBlind = config.bigBlind;
	if (
		!isSafeNonNegativeInteger(smallBlind) ||
		smallBlind === 0 ||
		!isSafeNonNegativeInteger(bigBlind) ||
		bigBlind === 0 ||
		bigBlind < smallBlind * 2 ||
		!Number.isSafeInteger(bigBlind * 100)
	) {
		return false;
	}
	const seats = room.seats;
	if (!Array.isArray(seats) || seats.length !== maxSeats) return false;
	const lastDealerSeat = room.lastDealerSeat;
	if (
		typeof lastDealerSeat !== 'number' ||
		!Number.isSafeInteger(lastDealerSeat) ||
		lastDealerSeat < -1 ||
		lastDealerSeat >= maxSeats
	) {
		return false;
	}
	for (const [seatIndex, value] of seats.entries()) {
		if (!isRecord(value)) return false;
		if (value.seatIndex !== seatIndex) return false;
		if (value.userId !== null && typeof value.userId !== 'string') return false;
		if (value.displayName !== null && typeof value.displayName !== 'string') return false;
		if (!isSafeNonNegativeInteger(value.chips) || typeof value.connected !== 'boolean')
			return false;
		if (value.disconnectedAt !== null && !isSafeNonNegativeInteger(value.disconnectedAt)) {
			return false;
		}
	}
	const handValue = room.hand;
	if (room.phase === 'waiting' && handValue !== null) return false;
	if (handValue === null) return room.phase === 'waiting';
	if (!isRecord(handValue)) return false;
	const hand = handValue;
	const bettingRound = hand.bettingRound;
	const dealerSeat = hand.dealerSeat;
	const currentSeat = hand.currentSeat;
	const deck = hand.deck;
	const board = hand.board;
	const holeCards = hand.holeCards;
	const committed = hand.committed;
	const currentBet = hand.currentBet;
	const lastRaiseAmount = hand.lastRaiseAmount;
	const folded = hand.folded;
	const allIn = hand.allIn;
	const hasActed = hand.hasActed;
	const seatIndexMap = hand.seatIndexMap;
	if (
		typeof bettingRound !== 'string' ||
		!['preflop', 'flop', 'turn', 'river', 'showdown'].includes(bettingRound) ||
		!isSafeNonNegativeInteger(dealerSeat) ||
		dealerSeat < 0 ||
		dealerSeat >= maxSeats ||
		!isSafeNonNegativeInteger(currentSeat) ||
		currentSeat < 0 ||
		currentSeat >= maxSeats ||
		!isCardArray(deck) ||
		!isCardArray(board) ||
		!isRecord(holeCards) ||
		!isRecord(committed) ||
		!isSafeNonNegativeInteger(currentBet) ||
		!isSafeNonNegativeInteger(lastRaiseAmount) ||
		!isStringArray(folded) ||
		!isStringArray(allIn) ||
		!isStringArray(hasActed) ||
		!isRecord(seatIndexMap)
	) {
		return false;
	}
	const dealtUserIds = Object.keys(holeCards);
	if (dealtUserIds.length < 2) return false;
	for (const userId of dealtUserIds) {
		const cards = holeCards[userId];
		if (!Array.isArray(cards) || cards.length !== 2 || !cards.every(isCard)) return false;
		if (!isSafeNonNegativeInteger(committed[userId])) return false;
		if (!isSafeNonNegativeInteger(seatIndexMap[userId])) return false;
		if (seatIndexMap[userId] >= maxSeats) return false;
	}
	return true;
}

function userAtSeat(room: Room, seatIndex: number): string | null {
	return room.seats[seatIndex]?.userId ?? null;
}

type KnownErrorCode = Extract<ServerMessage, { type: 'error' }>['code'];
const KNOWN_ERROR_CODES: Set<KnownErrorCode> = new Set<KnownErrorCode>([
	'BAD_MESSAGE',
	'NOT_YOUR_TURN',
	'INVALID_SEAT',
	'INVALID_ACTION',
	'NOT_ENOUGH_PLAYERS',
]);

function asKnownErrorCode(code: string): KnownErrorCode {
	return (KNOWN_ERROR_CODES as Set<string>).has(code) ? (code as KnownErrorCode) : 'INVALID_ACTION';
}

// PascalCase class name per TypeScript convention. wrangler.toml `class_name`
// matches this string exactly; the binding `name` is
// "MULTIPLAYER_POKER_ROOMS".
export class MultiplayerPokerRoom implements DurableObject {
	private state: DurableObjectState;
	private room: Room | null = null;
	private roomCode: string | null = null;
	private sockets = new Map<WebSocket, { userId: string; displayName: string }>();
	private turnDeadline: number | null = null;
	private emptyDeadline: number | null = null;
	private loaded: Promise<void>;

	constructor(state: DurableObjectState, _env: Env) {
		this.state = state;
		this.loaded = this.state.blockConcurrencyWhile(async () => {
			this.rebuildSocketsFromHibernation();
			const persisted = await this.state.storage.get<unknown>('persisted');
			if (persisted === undefined) return;
			if (!isPersistedState(persisted)) {
				await this.state.storage.deleteAll();
				return;
			}
			try {
				this.room = persistedToRoom(persisted.room);
				this.roomCode = persisted.roomCode;
				this.turnDeadline = persisted.turnDeadline;
				this.emptyDeadline = persisted.emptyDeadline;
				const previousEmptyDeadline = this.emptyDeadline;
				this.updateEmptyDeadline(Date.now());
				if (this.emptyDeadline !== previousEmptyDeadline) await this.persist();
				const nextAlarm = getNextAlarmAt(
					this.room,
					this.turnDeadline,
					this.emptyDeadline,
					Date.now(),
				);
				if (nextAlarm !== null) await this.state.storage.setAlarm(nextAlarm);
			} catch {
				this.room = null;
				this.roomCode = null;
				this.turnDeadline = null;
				this.emptyDeadline = null;
				await this.state.storage.deleteAll();
			}
		});
	}

	private rebuildSocketsFromHibernation(): void {
		for (const ws of this.state.getWebSockets()) {
			try {
				const attached = ws.deserializeAttachment() as {
					userId: string;
					displayName: string;
				} | null;
				if (attached?.userId) {
					this.sockets.set(ws, {
						userId: attached.userId,
						displayName: attached.displayName ?? '',
					});
				}
			} catch {
				/* socket has no attachment — skip */
			}
		}
	}

	async fetch(request: Request): Promise<Response> {
		await this.loaded;
		const url = new URL(request.url);
		switch (url.pathname) {
			case '/init':
				return this.handleInit(request);
			case '/metadata':
				return this.handleMetadata();
			case '/ws':
				return this.handleUpgrade(request);
			default:
				return new Response('Not Found', { status: 404 });
		}
	}

	private async handleInit(request: Request): Promise<Response> {
		if (this.room) return Response.json({ error: 'ROOM_CODE_TAKEN' }, { status: 409 });
		let rawBody: unknown;
		try {
			rawBody = await request.json();
		} catch {
			return Response.json(
				{ error: 'INVALID_JSON', message: 'Malformed JSON body' },
				{ status: 400 },
			);
		}
		if (!isRecord(rawBody) || typeof rawBody.roomCode !== 'string') {
			return Response.json(
				{ error: 'INVALID_CONFIG', message: 'Invalid room configuration' },
				{ status: 400 },
			);
		}
		const body = rawBody as unknown as InitRequest;
		const config: RoomConfig = {
			maxSeats: body.maxSeats as RoomConfig['maxSeats'],
			smallBlind: body.smallBlind,
			bigBlind: body.bigBlind,
		};
		try {
			this.room = createRoom(config);
		} catch (err) {
			if (err instanceof EngineError) {
				return Response.json({ error: err.code, message: err.message }, { status: 400 });
			}
			throw err;
		}
		this.roomCode = body.roomCode;
		this.turnDeadline = null;
		this.emptyDeadline = Date.now() + EMPTY_ROOM_TIMEOUT_MS;
		await this.persist();
		await this.scheduleNextAlarm();
		return Response.json({ ok: true });
	}

	private async handleMetadata(): Promise<Response> {
		if (!this.room || !this.roomCode)
			return Response.json({ error: 'ROOM_NOT_FOUND' }, { status: 404 });
		return Response.json({
			roomCode: this.roomCode,
			maxSeats: this.room.config.maxSeats,
			smallBlind: this.room.config.smallBlind,
			bigBlind: this.room.config.bigBlind,
			occupancy: this.room.seats.filter((seat) => seat.userId !== null).length,
		});
	}

	private async handleUpgrade(request: Request): Promise<Response> {
		if (!this.room) return new Response('Room not initialized', { status: 404 });
		const userId = request.headers.get('x-arcturus-user-id');
		const rawDisplayName = request.headers.get('x-arcturus-display-name');
		let displayName: string | null = null;
		if (rawDisplayName) {
			try {
				displayName = decodeURIComponent(rawDisplayName);
			} catch {
				return new Response('Invalid display-name encoding', { status: 400 });
			}
		}
		if (!userId || !displayName) return new Response('Missing identity headers', { status: 401 });
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Expected websocket', { status: 426 });
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
		this.state.acceptWebSocket(server);
		this.sockets.set(server, { userId, displayName });
		server.serializeAttachment({ userId, displayName });

		const now = Date.now();
		const seat = this.room.seats.find((candidate) => candidate.userId === userId);
		const expired =
			seat?.disconnectedAt !== null &&
			seat?.disconnectedAt !== undefined &&
			now - seat.disconnectedAt >= RECONNECT_TIMEOUT_MS;
		if (seat && !expired) {
			this.room = {
				...this.room,
				seats: this.room.seats.map((candidate) =>
					candidate.userId === userId
						? { ...candidate, connected: true, disconnectedAt: null }
						: candidate,
				),
			};
			if (
				this.room.phase === 'in-hand' &&
				this.room.hand &&
				this.turnDeadline === null &&
				userAtSeat(this.room, this.room.hand.currentSeat) === userId
			) {
				// Grant a fresh turn only when the timer was never started for this
				// actor (e.g. the turn arrived while they were disconnected). An
				// already-expired deadline must not be renewed — the alarm will
				// force-fold the actor instead.
				this.turnDeadline = now + TURN_TIMEOUT_MS;
			}
		}

		this.updateEmptyDeadline(now);
		await this.persist();
		await this.scheduleNextAlarm();
		this.sendRoomState();
		if (this.room.phase === 'in-hand' && this.room.hand?.holeCards[userId]) {
			const cards = this.room.hand.holeCards[userId];
			if (cards.length === 2) {
				this.send(server, {
					type: 'hand_started',
					dealerSeat: this.room.hand.dealerSeat,
					holeCards: [cards[0], cards[1]],
				});
			}
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		await this.loaded;
		const identity = this.sockets.get(ws);
		if (!identity || !this.room) {
			this.send(ws, { type: 'error', code: 'INVALID_ACTION', message: 'unknown socket' });
			ws.close(1008, 'unknown socket');
			return;
		}

		const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
		let parsed: ClientMessage;
		try {
			parsed = ClientMessage.parse(JSON.parse(raw));
		} catch {
			this.send(ws, { type: 'error', code: 'BAD_MESSAGE', message: 'invalid message' });
			return;
		}

		try {
			switch (parsed.type) {
				case 'take_seat': {
					this.room = takeSeat(this.room, {
						userId: identity.userId,
						displayName: identity.displayName,
						seatIndex: parsed.seatIndex,
					});
					this.updateEmptyDeadline(Date.now());
					await this.persist();
					this.sendRoomState();
					break;
				}
				case 'leave_seat':
					this.room = leaveSeat(this.room, identity.userId);
					this.updateEmptyDeadline(Date.now());
					await this.persist();
					this.sendRoomState();
					await this.scheduleNextAlarm();
					break;
				case 'start_hand': {
					const starterSeat = this.room.seats.find((seat) => seat.userId === identity.userId);
					if (
						!starterSeat ||
						!starterSeat.connected ||
						starterSeat.chips < this.room.config.bigBlind
					) {
						this.send(ws, {
							type: 'error',
							code: 'INVALID_ACTION',
							message: 'only a connected seated player with enough chips may start a hand',
						});
						return;
					}
					this.room = startHand(this.room, {
						deckSeed: crypto.randomUUID(),
						starterUserId: identity.userId,
					});
					this.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
					this.updateEmptyDeadline(Date.now());
					await this.persist();
					this.broadcastHandStarted();
					await this.scheduleNextAlarm();
					break;
				}
				case 'action': {
					const seat = this.room.seats.find((candidate) => candidate.userId === identity.userId);
					if (!seat || !seat.connected) {
						this.send(ws, {
							type: 'error',
							code: 'INVALID_ACTION',
							message: 'seat disconnected — reconnect grace expired',
						});
						return;
					}
					const now = Date.now();
					if (
						this.room.phase === 'in-hand' &&
						this.room.hand &&
						this.turnDeadline !== null &&
						now >= this.turnDeadline &&
						userAtSeat(this.room, this.room.hand.currentSeat) === identity.userId
					) {
						await this.applyTransition(
							applyAction(this.room, identity.userId, { action: 'fold' }),
							now,
						);
						this.send(ws, { type: 'error', code: 'INVALID_ACTION', message: 'turn timed out' });
						return;
					}
					await this.applyTransition(applyAction(this.room, identity.userId, parsed), now);
					break;
				}
			}
		} catch (err) {
			if (err instanceof EngineError) {
				this.send(ws, { type: 'error', code: asKnownErrorCode(err.code), message: err.message });
			} else {
				console.error('arcturus internal error', err);
				this.send(ws, { type: 'error', code: 'BAD_MESSAGE', message: 'internal error' });
			}
		}
	}

	private async cleanupSocket(ws: WebSocket): Promise<void> {
		const identity = this.sockets.get(ws);
		this.sockets.delete(ws);
		if (this.room && identity) {
			const duplicateUserSocket = Array.from(this.sockets.values()).some(
				(candidate) => candidate.userId === identity.userId,
			);
			if (!duplicateUserSocket) {
				const now = Date.now();
				this.room = {
					...this.room,
					seats: this.room.seats.map((seat) =>
						seat.userId === identity.userId
							? { ...seat, connected: false, disconnectedAt: now }
							: seat,
					),
				};
			}
		}
		if (!this.room) return;
		this.updateEmptyDeadline(Date.now());
		await this.persist();
		await this.scheduleNextAlarm();
		if (identity) this.sendRoomState();
	}

	async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		_wasClean: boolean,
	): Promise<void> {
		await this.loaded;
		try {
			await this.cleanupSocket(ws);
		} finally {
			try {
				ws.close(code, reason);
			} catch {
				/* socket already closed */
			}
		}
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		await this.loaded;
		try {
			await this.cleanupSocket(ws);
		} finally {
			try {
				ws.close(1011, 'WebSocket error');
			} catch {
				/* socket already closed */
			}
		}
	}

	async alarm(): Promise<void> {
		await this.loaded;
		if (!this.room) return;
		const now = Date.now();

		if (
			this.emptyDeadline !== null &&
			now >= this.emptyDeadline &&
			!this.room.seats.some((seat) => seat.userId !== null) &&
			this.sockets.size === 0 &&
			this.room.hand === null
		) {
			await this.deleteRoom();
			return;
		}

		const expiredDisconnected = this.room.seats
			.filter(
				(seat) =>
					seat.userId !== null &&
					seat.disconnectedAt !== null &&
					now - seat.disconnectedAt >= RECONNECT_TIMEOUT_MS,
			)
			.map((seat) => seat.userId!);

		if (this.room.phase === 'in-hand' && this.room.hand) {
			for (const userId of expiredDisconnected) {
				if (!this.room.hand || this.room.phase !== 'in-hand') break;
				if (!this.room.hand.holeCards[userId] || this.room.hand.folded.has(userId)) continue;
				if (this.room.hand.allIn.has(userId)) continue;
				const currentUserId = userAtSeat(this.room, this.room.hand.currentSeat);
				const transition =
					currentUserId === userId
						? applyAction(this.room, userId, { action: 'fold' })
						: forceFold(this.room, userId);
				await this.applyTransition(transition, now);
			}
		}

		if (
			this.room?.phase === 'in-hand' &&
			this.room.hand &&
			this.turnDeadline !== null &&
			now >= this.turnDeadline
		) {
			const currentSeat = this.room.hand.currentSeat;
			const seat = this.room.seats[currentSeat];
			const userId = seat?.userId;
			if (userId && !this.room.hand.folded.has(userId) && !this.room.hand.allIn.has(userId)) {
				// An expired turn deadline force-folds the current actor regardless of
				// connection state. Reconnect grace protects a disconnected seat only
				// while its turn timer has not already expired.
				await this.applyTransition(applyAction(this.room, userId, { action: 'fold' }), now);
			} else {
				// Current seat is folded, all-in, or empty — clear the stale deadline to
				// avoid an immediate alarm loop.
				this.turnDeadline = null;
				await this.persist();
			}
		}

		if (!this.room) return;
		const cleaned = this.clearExpiredDisconnectedSeats(this.room, now);
		if (cleaned !== this.room) {
			await this.applyTransition({ room: cleaned, handResult: null }, now);
		}
		if (!this.room) return;

		this.updateEmptyDeadline(now);
		if (
			this.emptyDeadline !== null &&
			now >= this.emptyDeadline &&
			!this.room.seats.some((seat) => seat.userId !== null) &&
			this.sockets.size === 0 &&
			this.room.hand === null
		) {
			await this.deleteRoom();
			return;
		}
		await this.persist();
		await this.scheduleNextAlarm();
	}

	private async applyTransition(transition: RoomTransition, now: number): Promise<void> {
		const previousRoom = this.room;
		this.room = transition.room;
		if (transition.handResult) this.emitHandEnded(transition.handResult);
		this.room = this.clearExpiredDisconnectedSeats(this.room, now);

		if (this.room.phase !== 'in-hand' || !this.room.hand) {
			this.turnDeadline = null;
		} else if (
			!previousRoom?.hand ||
			previousRoom.hand.currentSeat !== this.room.hand.currentSeat ||
			previousRoom.hand.bettingRound !== this.room.hand.bettingRound ||
			this.turnDeadline === null
		) {
			const currentSeat = this.room.seats[this.room.hand.currentSeat];
			const userId = currentSeat?.userId;
			this.turnDeadline =
				userId &&
				currentSeat.connected &&
				!this.room.hand.folded.has(userId) &&
				!this.room.hand.allIn.has(userId)
					? now + TURN_TIMEOUT_MS
					: null;
		}
		this.updateEmptyDeadline(now);
		await this.persist();
		this.sendRoomState();
		await this.scheduleNextAlarm();
	}

	private clearExpiredDisconnectedSeats(room: Room, now: number): Room {
		let next = room;
		for (const seat of room.seats) {
			if (
				!seat.userId ||
				seat.connected ||
				seat.disconnectedAt === null ||
				now - seat.disconnectedAt < RECONNECT_TIMEOUT_MS
			) {
				continue;
			}
			const protectedByHand =
				next.phase === 'in-hand' &&
				next.hand !== null &&
				next.hand.holeCards[seat.userId] !== undefined &&
				!next.hand.folded.has(seat.userId);
			if (!protectedByHand) next = clearDisconnectedSeat(next, seat.userId);
		}
		return next;
	}

	private updateEmptyDeadline(now: number): void {
		if (!this.room) return;
		const isEmpty =
			!this.room.seats.some((seat) => seat.userId !== null) && this.sockets.size === 0;
		if (!isEmpty) {
			this.emptyDeadline = null;
		} else if (this.emptyDeadline === null) {
			this.emptyDeadline = now + EMPTY_ROOM_TIMEOUT_MS;
		}
	}

	private async deleteRoom(): Promise<void> {
		const openSockets = [...this.sockets.keys()];
		await this.state.storage.deleteAll();
		await this.state.storage.deleteAlarm();
		this.room = null;
		this.roomCode = null;
		this.turnDeadline = null;
		this.emptyDeadline = null;
		this.sockets.clear();
		for (const ws of openSockets) {
			try {
				ws.close(1000, 'Room evicted');
			} catch {
				/* socket already closed */
			}
		}
	}

	private async scheduleNextAlarm(): Promise<void> {
		if (!this.room) return;
		const nextAlarm = getNextAlarmAt(this.room, this.turnDeadline, this.emptyDeadline, Date.now());
		if (nextAlarm !== null) await this.state.storage.setAlarm(nextAlarm);
	}

	private send(ws: WebSocket, msg: ServerMessage): void {
		try {
			ws.send(JSON.stringify(msg));
		} catch {
			/* socket already closed */
		}
	}

	private broadcast(msg: ServerMessage): void {
		for (const ws of this.sockets.keys()) this.send(ws, msg);
	}

	private sendRoomState(): void {
		if (!this.room) return;
		for (const [socket, identity] of this.sockets) {
			this.send(socket, toRoomStateMessage(this.room, identity.userId));
		}
	}

	private broadcastHandStarted(): void {
		if (!this.room?.hand) return;
		const hand = this.room.hand;
		for (const [ws, identity] of this.sockets.entries()) {
			const cards = hand.holeCards[identity.userId];
			if (cards && cards.length === 2) {
				this.send(ws, {
					type: 'hand_started',
					dealerSeat: hand.dealerSeat,
					holeCards: [cards[0], cards[1]],
				});
			}
		}
		this.sendRoomState();
	}

	private emitHandEnded(result: NonNullable<RoomTransition['handResult']>): void {
		this.broadcast(toHandEndedMessage(result));
	}

	private async persist(): Promise<void> {
		if (!this.room || !this.roomCode) return;
		const persisted: PersistedState = {
			room: roomToPersisted(this.room),
			roomCode: this.roomCode,
			turnDeadline: this.turnDeadline,
			emptyDeadline: this.emptyDeadline,
		};
		await this.state.storage.put<PersistedState>('persisted', persisted);
	}
}
