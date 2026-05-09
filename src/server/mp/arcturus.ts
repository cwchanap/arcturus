import {
	ClientMessage,
	EMOTES,
	type Seat,
	type Phase,
	type ServerMessage,
} from '../../lib/mp-poker/protocol';
import {
	createRoom,
	takeSeat,
	leaveSeat,
	startHand,
	applyAction,
	buildSidePots,
	EngineError,
	type Room,
	type RoomConfig,
	type HandState,
} from '../../lib/mp-poker/engine';
import type { Card } from '../../lib/poker/types';
import { buildSettlePayload } from './settlement';

interface InitRequest {
	maxSeats: number;
	smallBlind: number;
	bigBlind: number;
	hostUserId: string;
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
	doSecret: string;
	currentHandId: number;
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

type KnownErrorCode = Extract<ServerMessage, { type: 'error' }>['code'];
const KNOWN_ERROR_CODES: Set<KnownErrorCode> = new Set<KnownErrorCode>([
	'BAD_MESSAGE',
	'NOT_YOUR_TURN',
	'INSUFFICIENT_CHIPS',
	'ALREADY_IN_ROOM',
	'SETTLEMENT_FAILED',
	'NOT_A_MEMBER',
	'ROOM_CODE_TAKEN',
	'INVALID_SEAT',
	'INVALID_ACTION',
	'INVALID_CONFIG',
	'NOT_ENOUGH_PLAYERS',
]);

function asKnownErrorCode(code: string): KnownErrorCode {
	return (KNOWN_ERROR_CODES as Set<string>).has(code) ? (code as KnownErrorCode) : 'INVALID_ACTION';
}

const RECONNECT_TIMEOUT_MS = 30_000;
const IDLE_TEARDOWN_MS = 5 * 60 * 1000;

// Lowercase class name per binding convention (matches `arcturus` in wrangler.toml).
export class arcturus implements DurableObject {
	private state: DurableObjectState;
	private env: Env;
	private room: Room | null = null;
	private roomCode: string | null = null;
	private doSecret: string | null = null;
	private currentHandId = 0;
	private sockets = new Map<WebSocket, { userId: string; displayName: string }>();
	private loaded: Promise<void>;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
		this.loaded = this.state.blockConcurrencyWhile(async () => {
			const persisted = await this.state.storage.get<PersistedState>('persisted');
			if (persisted) {
				this.room = persistedToRoom(persisted.room);
				this.roomCode = persisted.roomCode;
				this.doSecret = persisted.doSecret;
				this.currentHandId = persisted.currentHandId ?? 0;
			}
		});
		// Rebuild sockets map from hibernated WebSockets
		this.rebuildSocketsFromHibernation();
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
		if (this.room) {
			return Response.json({ error: 'ROOM_CODE_TAKEN' }, { status: 409 });
		}
		const body = (await request.json()) as InitRequest;
		const config: RoomConfig = {
			maxSeats: body.maxSeats,
			smallBlind: body.smallBlind,
			bigBlind: body.bigBlind,
			hostUserId: body.hostUserId,
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
		this.doSecret = crypto.randomUUID();
		await this.persist();
		return Response.json({ ok: true, doSecret: this.doSecret });
	}

	private async handleMetadata(): Promise<Response> {
		if (!this.room || !this.roomCode) {
			return Response.json({ error: 'ROOM_NOT_FOUND' }, { status: 404 });
		}
		return Response.json({
			roomCode: this.roomCode,
			maxSeats: this.room.config.maxSeats,
			smallBlind: this.room.config.smallBlind,
			bigBlind: this.room.config.bigBlind,
			occupancy: this.room.seats.filter((s) => s.userId !== null).length,
		});
	}

	private async handleUpgrade(request: Request): Promise<Response> {
		if (!this.room) return new Response('Room not initialized', { status: 404 });
		const userId = request.headers.get('x-arcturus-user-id');
		const rawDisplayName = request.headers.get('x-arcturus-display-name');
		const displayName = rawDisplayName ? decodeURIComponent(rawDisplayName) : null;
		if (!userId || !displayName) return new Response('Missing identity headers', { status: 401 });

		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Expected websocket', { status: 426 });
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
		this.state.acceptWebSocket(server);
		this.sockets.set(server, { userId, displayName });
		server.serializeAttachment({ userId, displayName });

		const seats = this.room.seats.map((s) =>
			s.userId === userId ? { ...s, connected: true, disconnectedAt: null } : s,
		);
		this.room = { ...this.room, seats };
		await this.persist();

		this.send(server, this.makeRoomStateMessage());

		// Resend private hole cards if the user is in an active hand
		if (this.room.hand && this.room.hand.holeCards[userId]) {
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
			this.send(ws, { type: 'error', code: 'NOT_A_MEMBER', message: 'unknown socket' });
			ws.close(1008, 'unknown socket');
			return;
		}

		const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
		let parsed;
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
						mainBalance: 0,
					});
					await this.persist();
					this.broadcastRoomState();
					break;
				}
				case 'leave_seat':
					this.room = leaveSeat(this.room, identity.userId);
					// If user is no longer seated, release their room lock
					if (!this.room.seats.some((s) => s.userId === identity.userId)) {
						await this.releaseMembership(identity.userId);
					}
					await this.persist();
					this.broadcastRoomState();
					await this.scheduleNextAlarm();
					break;
				case 'start_hand': {
					if (this.room.config.hostUserId !== identity.userId) {
						this.send(ws, { type: 'error', code: 'INVALID_ACTION', message: 'host only' });
						return;
					}
					if (
						this.room.phase === 'in-hand' ||
						this.room.phase === 'settling' ||
						this.room.phase === 'frozen'
					) {
						this.send(ws, {
							type: 'error',
							code: 'INVALID_ACTION',
							message: 'hand already in progress',
						});
						return;
					}
					const seated = this.room.seats.filter((s) => s.userId !== null).map((s) => s.userId!);
					const snapshots = await this.fetchSnapshot(seated);
					this.currentHandId++;
					const cryptoSuffix = crypto.randomUUID();
					const handId = `${this.roomCode}-${this.currentHandId}-${cryptoSuffix}`;
					this.room = startHand(this.room, { snapshots, deckSeed: handId });
					await this.persist();
					this.broadcastHandStarted();
					break;
				}
				case 'action': {
					this.room = applyAction(this.room, identity.userId, parsed);
					await this.persist();
					if (this.room.phase === 'settling') {
						this.broadcastHandEnded();
						await this.runSettlement();
					}
					this.broadcastRoomState();
					break;
				}
				case 'emote':
					this.broadcastEmote(identity.userId, parsed.emoteId);
					break;
				case 'pong':
					break;
			}
		} catch (err) {
			if (err instanceof EngineError) {
				this.send(ws, {
					type: 'error',
					code: asKnownErrorCode(err.code),
					message: err.message,
				});
			} else {
				console.error('arcturus internal error', err);
				this.send(ws, { type: 'error', code: 'BAD_MESSAGE', message: 'internal error' });
			}
		}
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		await this.loaded;
		const identity = this.sockets.get(ws);
		this.sockets.delete(ws);
		if (!identity || !this.room) return;

		// If another socket for the same user still exists, keep the seat connected
		const hasOtherSocket = Array.from(this.sockets.values()).some(
			(id) => id.userId === identity.userId,
		);
		if (hasOtherSocket) {
			await this.persist();
			return;
		}

		const seats = this.room.seats.map((s) =>
			s.userId === identity.userId ? { ...s, connected: false, disconnectedAt: Date.now() } : s,
		);
		this.room = { ...this.room, seats };

		// If the disconnected player is the active seat, auto-fold their hand
		if (this.room.phase === 'in-hand' && this.room.hand && this.room.hand.currentSeat !== null) {
			const currentSeat = this.room.seats[this.room.hand.currentSeat];
			if (currentSeat?.userId === identity.userId) {
				try {
					this.room = applyAction(this.room, identity.userId, { action: 'fold' });
					if (this.room.phase === 'settling') {
						this.broadcastHandEnded();
						await this.runSettlement();
					}
				} catch {
					/* best-effort auto-fold */
				}
			}
		}

		await this.persist();
		await this.scheduleNextAlarm();
		this.broadcastRoomState();
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		await this.webSocketClose(ws);
	}

	async alarm(): Promise<void> {
		await this.loaded;
		if (!this.room) return;
		const now = Date.now();

		// Collect timed-out userIds before clearing seats
		const timedOutUserIds: string[] = [];
		for (const s of this.room.seats) {
			if (s.userId && s.disconnectedAt !== null && now - s.disconnectedAt >= RECONNECT_TIMEOUT_MS) {
				timedOutUserIds.push(s.userId);
			}
		}

		// Fold ALL timed-out players still in the active hand before clearing seats
		if (this.room.phase === 'in-hand' && this.room.hand) {
			for (const userId of timedOutUserIds) {
				if (this.room.hand.folded.has(userId)) continue;
				// Only fold players actually dealt into this hand
				if (!this.room.hand.holeCards[userId]) continue;
				// If it's not their turn, temporarily move action to them so fold can apply
				if (this.room.hand.currentSeat !== null) {
					const currentSeatIdx = this.room.hand.currentSeat;
					const currentSeat = this.room.seats[currentSeatIdx];
					if (currentSeat?.userId !== userId) {
						// Find their seat and temporarily set them as current so applyAction works
						const theirSeat = this.room.seats.find((s) => s.userId === userId);
						if (theirSeat) {
							this.room = {
								...this.room,
								hand: { ...this.room.hand, currentSeat: theirSeat.seatIndex },
							};
						}
					}
				}
				try {
					this.room = applyAction(this.room, userId, { action: 'fold' });
					if (this.room.phase === 'settling') {
						this.broadcastHandEnded();
						await this.runSettlement();
					}
				} catch {
					/* best-effort fold */
				}
			}
		}

		// Release membership locks for evicted users before clearing seats
		for (const uid of timedOutUserIds) {
			// Only release if the user won't have any seat after clearing
			const otherSeats = this.room.seats.filter(
				(s) =>
					s.userId === uid &&
					(s.disconnectedAt === null || now - s.disconnectedAt < RECONNECT_TIMEOUT_MS),
			);
			if (otherSeats.length === 0) {
				await this.releaseMembership(uid);
			}
		}

		// Now clear the timed-out seats
		let mutated = false;
		const seats = this.room.seats.map((s) => {
			if (s.userId && s.disconnectedAt !== null && now - s.disconnectedAt >= RECONNECT_TIMEOUT_MS) {
				mutated = true;
				return {
					...s,
					userId: null,
					displayName: null,
					disconnectedAt: null,
					connected: false,
				};
			}
			return s;
		});
		if (mutated) {
			this.room = { ...this.room, seats };
			await this.persist();
			this.broadcastRoomState();
		}

		const anyHuman = this.room.seats.some((s) => s.userId !== null);
		if (!anyHuman) {
			await this.state.storage.deleteAll();
			this.room = null;
			this.roomCode = null;
			this.doSecret = null;
			for (const ws of this.sockets.keys()) {
				try {
					ws.close(1000, 'Room evicted');
				} catch {
					/* ignore */
				}
			}
			this.sockets.clear();
			return;
		}

		await this.scheduleNextAlarm();
	}

	private async scheduleNextAlarm(): Promise<void> {
		if (!this.room) return;
		const now = Date.now();
		let earliest: number | null = null;
		for (const s of this.room.seats) {
			if (s.disconnectedAt !== null) {
				const fireAt = s.disconnectedAt + RECONNECT_TIMEOUT_MS;
				if (earliest === null || fireAt < earliest) earliest = fireAt;
			}
		}
		const anyHuman = this.room.seats.some((s) => s.userId !== null);
		if (!anyHuman) {
			const idleFireAt = now + IDLE_TEARDOWN_MS;
			if (earliest === null || idleFireAt < earliest) earliest = idleFireAt;
		}
		if (earliest !== null) {
			await this.state.storage.setAlarm(earliest);
		}
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

	private broadcastRoomState(): void {
		this.broadcast(this.makeRoomStateMessage());
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
		this.broadcastRoomState();
	}

	private broadcastEmote(fromUserId: string, emoteId: (typeof EMOTES)[number]): void {
		if (!this.room) return;
		const seat = this.room.seats.find((s) => s.userId === fromUserId);
		if (!seat) return;
		this.broadcast({ type: 'emote_received', fromSeat: seat.seatIndex, emoteId });
	}

	private broadcastHandEnded(): void {
		if (!this.room?.hand) return;
		const hand = this.room.hand;
		const lastLog = this.room.handLog[this.room.handLog.length - 1];
		if (!lastLog) return;
		const pots = buildSidePots(hand, this.room.seats);
		this.broadcast({
			type: 'hand_ended',
			winners: lastLog.winners,
			pots: pots.map((p) => ({ amount: p.amount, eligibleSeats: p.eligibleSeatIndices })),
			showdownCards: this.room.seats
				.filter((s) => s.userId && hand.holeCards[s.userId] && !hand.folded.has(s.userId))
				.map((s) => ({
					seatIndex: s.seatIndex,
					cards: hand.holeCards[s.userId!] as [Card, Card],
				})),
		});
	}

	private makeRoomStateMessage(): ServerMessage {
		if (!this.room) {
			return {
				type: 'room_state',
				phase: 'idle',
				seats: [],
				pot: 0,
				board: [],
				currentSeat: null,
				betToCall: 0,
				timeRemainingMs: 0,
			};
		}
		const r = this.room;
		const pot = r.hand ? Object.values(r.hand.committed).reduce((a, b) => a + b, 0) : 0;
		const seats: Seat[] = r.seats.map((s) => ({
			seatIndex: s.seatIndex,
			userId: s.userId,
			displayName: s.displayName,
			chips:
				s.userId && r.hand
					? Math.max(0, (r.hand.handStacks[s.userId] ?? 0) - (r.hand.committed[s.userId] ?? 0))
					: 0,
			committed: s.userId && r.hand ? (r.hand.committed[s.userId] ?? 0) : 0,
			folded: !!(s.userId && r.hand?.folded.has(s.userId)),
			allIn: !!(s.userId && r.hand?.allIn.has(s.userId)),
			connected: s.connected,
			disconnectedAt: s.disconnectedAt,
		}));
		return {
			type: 'room_state',
			phase: r.phase as Phase,
			seats,
			pot,
			board: r.hand?.board ?? [],
			currentSeat: r.hand?.currentSeat ?? null,
			betToCall: r.hand?.currentBet ?? 0,
			timeRemainingMs: 0,
		};
	}

	private async fetchSnapshot(userIds: string[]): Promise<Record<string, number>> {
		const origin = this.env.WORKER_ORIGIN;
		if (!origin) throw new Error('WORKER_ORIGIN not configured');
		const mpAuth = this.env.MP_AUTH_SECRET ?? this.doSecret ?? '';
		const res = await fetch(`${origin}/api/mp/snapshot`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-arcturus-auth': mpAuth,
			},
			body: JSON.stringify({ userIds, roomCode: this.roomCode }),
		});
		if (!res.ok) throw new Error(`snapshot failed: ${res.status}`);
		const json = (await res.json()) as { balances: Record<string, number> };
		return json.balances;
	}

	private async releaseMembership(userId: string): Promise<void> {
		const origin = this.env.WORKER_ORIGIN;
		if (!origin) return;
		const mpAuth = this.env.MP_AUTH_SECRET ?? this.doSecret ?? '';
		try {
			await fetch(`${origin}/api/mp/lock`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-arcturus-auth': mpAuth,
					'x-arcturus-user-id': userId,
				},
				body: JSON.stringify({ action: 'release' }),
			});
		} catch {
			/* best-effort release */
		}
	}

	private async runSettlement(): Promise<void> {
		if (!this.room?.hand || !this.roomCode) return;
		const handId = `${this.roomCode}-${this.currentHandId}`;
		const lastWinners = this.room.handLog[this.room.handLog.length - 1]?.winners ?? [];
		const winnersByUserId = lastWinners
			.map((w) => {
				const seat = this.room!.seats[w.seatIndex];
				return seat.userId ? { userId: seat.userId, amount: w.amount } : null;
			})
			.filter((x): x is { userId: string; amount: number } => x !== null);

		const payload = buildSettlePayload({
			roomCode: this.roomCode,
			handId,
			committed: this.room.hand.committed,
			winners: winnersByUserId,
		});

		let attempts = 0;
		const origin = this.env.WORKER_ORIGIN;
		if (!origin) throw new Error('WORKER_ORIGIN not configured');
		const mpAuth = this.env.MP_AUTH_SECRET ?? this.doSecret ?? '';
		while (attempts < 3) {
			attempts++;
			try {
				const res = await fetch(`${origin}/api/mp/settle`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-arcturus-auth': mpAuth,
					},
					body: JSON.stringify(payload),
				});
				if (res.ok) {
					this.room = { ...this.room, phase: 'seating', hand: null };
					await this.persist();
					return;
				}
			} catch {
				/* retry */
			}
			await new Promise((r) => setTimeout(r, 250 * attempts));
		}
		this.room = { ...this.room, phase: 'frozen' };
		await this.persist();
		this.broadcast({
			type: 'error',
			code: 'SETTLEMENT_FAILED',
			message: 'D1 settlement failed after retries',
		});
	}

	private async persist(): Promise<void> {
		if (!this.room || !this.roomCode || !this.doSecret) return;
		const persisted: PersistedState = {
			room: roomToPersisted(this.room),
			roomCode: this.roomCode,
			doSecret: this.doSecret,
			currentHandId: this.currentHandId,
		};
		await this.state.storage.put<PersistedState>('persisted', persisted);
	}
}
