import {
	ClientMessage,
	type Seat,
	type Phase,
	type ServerMessage,
	type EmoteId,
} from '../../lib/mp-poker/protocol';
import {
	createRoom,
	takeSeat,
	leaveSeat,
	startHand,
	applyAction,
	forceFold,
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
	pendingLockReleases: string[];
	/** User IDs whose escrow (heldChips) release failed but who may still be
	 *  active (seated / connected). Unlike pendingLockReleases, these users
	 *  need only an escrow release — not a membership lock release — and the
	 *  alarm handler must retry even while they are active. */
	pendingEscrowReleases: string[];
	turnDeadline: number | null;
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
const TURN_TIMEOUT_MS = 60_000;

// PascalCase class name per TypeScript convention.  wrangler.toml `class_name`
// matches this string exactly; the binding `name` stays lowercase ("arcturus").
export class Arcturus implements DurableObject {
	private state: DurableObjectState;
	private env: Env;
	private room: Room | null = null;
	private roomCode: string | null = null;
	private doSecret: string | null = null;
	private currentHandId = 0;
	private sockets = new Map<WebSocket, { userId: string; displayName: string }>();
	/** User IDs whose membership lock release failed after escrow was returned.
	 *  Retried on the next alarm tick so transient failures don't permanently
	 *  block a user from joining another room. */
	private pendingLockReleases = new Set<string>();
	/** User IDs whose escrow (heldChips) release failed but who may still be
	 *  active (seated / open socket).  The alarm handler retries releaseEscrow
	 *  for these users even while active, unlike pendingLockReleases which
	 *  skips active users.  This covers two scenarios:
	 *  1. releaseEscrow failed during start_hand when < 2 players remained.
	 *  2. releaseEscrow failed for players excluded from the hand (below BB).
	 *  3. DO crashed after fetchSnapshot moved chips to heldChips but before
	 *     the hand was persisted — the constructor loads these IDs to recover. */
	private pendingEscrowReleases = new Set<string>();
	/** Guard to prevent concurrent start_hand invocations from interleaving
	 *  around the non-storage fetchSnapshot() await. Set synchronously before
	 *  the first await so any handler that enters while another is mid-flight
	 *  sees true and bails out immediately. */
	private isStartingHand = false;
	/** Deadline (epoch ms) by which the current seated actor must act. Used to
	 *  auto-fold connected idle players so the hand does not stall indefinitely. */
	private turnDeadline: number | null = null;
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
				this.pendingLockReleases = new Set(persisted.pendingLockReleases ?? []);
				this.pendingEscrowReleases = new Set(persisted.pendingEscrowReleases ?? []);
				this.turnDeadline = persisted.turnDeadline ?? null;

				// Recover from crash/eviction: schedule an immediate alarm for states
				// that need retry logic. We cannot run settlement or releaseMembership
				// here because blockConcurrencyWhile should not make outbound fetches.
				// - settling: hand completed but settlement fetch failed mid-flight
				// - frozen: all settlement retries exhausted, need periodic retry
				// - pendingLockReleases: membership lock releases that failed transiently
				// - pendingEscrowReleases: escrow releases that failed (chips stuck in heldChips)
				// - in-hand with turnDeadline: a connected player may be idle and need auto-fold
				// - disconnectedAt on any seat: reconnect timeout may have elapsed, need
				//   seat eviction and membership release
				// - empty room: idle teardown alarm may have been lost before storage
				// Without this alarm, no future event triggers recovery (no players to
				// open WebSocket), leaving chips/membership locks permanently stuck.
				if (
					this.room.phase === 'settling' ||
					this.room.phase === 'frozen' ||
					this.pendingLockReleases.size > 0 ||
					this.pendingEscrowReleases.size > 0 ||
					(this.room.phase === 'in-hand' && this.turnDeadline !== null) ||
					this.room.seats.some((s) => s.disconnectedAt !== null) ||
					!this.room.seats.some((s) => s.userId !== null)
				) {
					await this.state.storage.setAlarm(Date.now() + 100);
				}
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
		let body: InitRequest;
		try {
			body = (await request.json()) as InitRequest;
		} catch {
			return Response.json(
				{ error: 'INVALID_JSON', message: 'Malformed JSON body' },
				{ status: 400 },
			);
		}
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
		// Schedule idle teardown alarm in case the creator never connects via WebSocket
		await this.scheduleNextAlarm();
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

		// Check if the player's seat reconnect grace has already expired.
		// If so, accept the WebSocket but do NOT restore the seat — the alarm
		// handler will fold (if in hand) and clear the seat.  This prevents a
		// late reconnect from bypassing the forced-fold / eviction.
		const now = Date.now();
		const expiredSeat = this.room.seats.find(
			(s) =>
				s.userId === userId &&
				s.disconnectedAt !== null &&
				now - s.disconnectedAt >= RECONNECT_TIMEOUT_MS,
		);

		if (!expiredSeat) {
			const seats = this.room.seats.map((s) =>
				s.userId === userId ? { ...s, connected: true, disconnectedAt: null } : s,
			);
			this.room = { ...this.room, seats };

			// If the reconnecting player is the current actor in an active hand and
			// no turn deadline exists (e.g. the alarm cleared it while they were
			// disconnected within the reconnect grace), set a fresh deadline so the
			// alarm will auto-fold them if they idle. Without this the hand hangs
			// indefinitely because no future alarm is scheduled to auto-fold.
			if (this.room.phase === 'in-hand' && this.room.hand && this.turnDeadline === null) {
				const currentSeat = this.room.hand.currentSeat;
				const currentUserId = currentSeat !== null ? this.room.seats[currentSeat]?.userId : null;
				if (currentUserId === userId) {
					this.turnDeadline = now + TURN_TIMEOUT_MS;
				}
			}
			await this.persist();
		}

		await this.scheduleNextAlarm();

		this.broadcastRoomState();

		// Resend private hole cards only while the hand is actually in play
		if (this.room.phase === 'in-hand' && this.room.hand && this.room.hand.holeCards[userId]) {
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
					if (this.isStartingHand) {
						this.send(ws, {
							type: 'error',
							code: 'INVALID_ACTION',
							message: 'hand is starting, please wait',
						});
						break;
					}
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
					// Keep the membership lock until the socket closes. Releasing it here
					// would allow the user to join another room while this WebSocket is
					// still open, then re-seat via this socket — defeating the one-room-per-user
					// constraint. webSocketClose releases the lock when the socket actually goes away.
					await this.persist();
					this.broadcastRoomState();
					await this.scheduleNextAlarm();
					break;
				case 'start_hand': {
					// If the current host is absent (no open socket and not seated),
					// transfer host to a connected seated player so the room remains
					// startable.  This covers the gap where the creator disconnects
					// before any successor exists — webSocketClose tried to transfer
					// but found no seated player, and no alarm fires to retry.
					const hostPresent =
						Array.from(this.sockets.values()).some(
							(id) => id.userId === this.room.config.hostUserId,
						) || this.room.seats.some((s) => s.userId === this.room.config.hostUserId);
					if (!hostPresent) {
						// Prefer the requesting user as successor so their start_hand
						// succeeds immediately; fall back to any connected seated player.
						const requesterSeated = this.room.seats.find(
							(s) => s.userId === identity.userId && s.connected,
						);
						const successor = requesterSeated
							? requesterSeated
							: this.room.seats.find((s) => s.userId !== null && s.connected);
						if (successor?.userId) {
							// The old host may have an mp_membership row in D1 but no
							// socket or seat in the DO (e.g. creator whose tab crashed
							// before opening the WS). Track them for alarm-based lock
							// release so they aren't permanently blocked from joining
							// another room.
							this.pendingLockReleases.add(this.room.config.hostUserId);
							this.room = {
								...this.room,
								config: { ...this.room.config, hostUserId: successor.userId },
							};
							await this.persist();
							// Schedule a retry alarm immediately so the old host's
							// membership lock is released even if start_hand returns
							// early (non-host requester, < 2 connected players, etc.).
							await this.scheduleNextAlarm();
							this.broadcastRoomState();
						}
					}
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
					// Guard against concurrent start_hand invocations: fetchSnapshot()
					// is a non-storage await that releases the DO input gate, allowing
					// a second start_hand to pass the phase checks above. Set the flag
					// synchronously (before any await) so the second handler bails out.
					if (this.isStartingHand) {
						this.send(ws, {
							type: 'error',
							code: 'INVALID_ACTION',
							message: 'hand already starting',
						});
						return;
					}
					this.isStartingHand = true;
					try {
						// Only escrow connected players — disconnected seats retain their
						// userId for the 30 s reconnect window but cannot act, so dealing
						// them in would blind them out while offline.
						const connected = this.room.seats
							.filter((s) => s.userId !== null && s.connected)
							.map((s) => s.userId!);
						if (connected.length < 2) {
							this.send(ws, {
								type: 'error',
								code: 'NOT_ENOUGH_PLAYERS',
								message: 'need at least 2 connected players',
							});
							return;
						}
						const escrowedUserIds = connected;
						// Persist the list of escrowed user IDs BEFORE calling
						// fetchSnapshot.  The snapshot API moves chipBalance →
						// heldChips in D1.  If the DO crashes between fetchSnapshot
						// and the next persist(), the constructor will reload
						// pendingEscrowReleases and schedule an alarm to release
						// the escrow — preventing permanently stuck chips.
						// Merge into the existing set rather than overwriting so
						// prior failed releases are not lost.
						for (const uid of escrowedUserIds) {
							this.pendingEscrowReleases.add(uid);
						}
						await this.persist();
						let snapshots: Record<string, number>;
						try {
							snapshots = await this.fetchSnapshot(connected);
						} catch (snapErr) {
							// fetchSnapshot may have already escrowed chips in D1
							// (the snapshot API moves chipBalance → heldChips before
							// responding). If the fetch failed after escrow but before
							// we received the response, chips are locked. Release them.
							console.error('[start_hand] fetchSnapshot failed, releasing escrow:', snapErr);
							const escrowReleased = await this.releaseEscrow(escrowedUserIds);
							if (escrowReleased) {
								// Escrow released successfully — remove only the users
								// whose escrow was actually returned. Prior pending IDs
								// must remain for the alarm handler to retry.
								for (const uid of escrowedUserIds) {
									this.pendingEscrowReleases.delete(uid);
								}
							} else {
								// releaseEscrow also failed.  Keep the IDs in
								// pendingEscrowReleases, persist, and schedule an alarm
								// so the handler retries the release on the next tick.
								await this.persist();
								await this.scheduleNextAlarm();
							}
							throw snapErr;
						}
						// Re-filter connected seats — fetchSnapshot and each
						// releaseEscrow are non-storage awaits that release the DO
						// input gate, so webSocketClose may have marked players as
						// disconnected during these yields. The helper loops until
						// stable, releasing escrow for each newly disconnected batch.
						const liveConnected = await this.releaseEscrowForDisconnected(escrowedUserIds);
						// Only pass connected players' snapshots to the engine so
						// disconnected users are excluded from eligibility checks.
						const filteredSnapshots: Record<string, number> = {};
						for (const uid of liveConnected) {
							if (snapshots[uid] !== undefined) filteredSnapshots[uid] = snapshots[uid];
						}
						if (Object.keys(filteredSnapshots).length < 2) {
							// Release escrow for connected players — no hand will be
							// created so settlement will never clear their held chips.
							const released = await this.releaseEscrow(liveConnected);
							if (!released) {
								// Escrow release failed (transient error). Add users to
								// pendingEscrowReleases so the alarm handler retries the
								// escrow-only release (without releasing membership lock).
								// Unlike pendingLockReleases, this set is retried even for
								// active (seated/connected) users.
								for (const uid of liveConnected) {
									this.pendingEscrowReleases.add(uid);
								}
								await this.persist();
								await this.scheduleNextAlarm();
							} else {
								// Escrow released successfully — clear pre-snapshot
								// tracking for these users.
								for (const uid of liveConnected) {
									this.pendingEscrowReleases.delete(uid);
								}
								await this.persist();
							}
							this.send(ws, {
								type: 'error',
								code: 'NOT_ENOUGH_PLAYERS',
								message: 'too many players disconnected during snapshot fetch',
							});
							return;
						}
						this.currentHandId++;
						const cryptoSuffix = crypto.randomUUID();
						const handId = `${this.roomCode}-${this.currentHandId}-${cryptoSuffix}`;
						try {
							this.room = startHand(this.room, { snapshots: filteredSnapshots, deckSeed: handId });
						} catch (err) {
							// startHand rejected the hand (e.g. not enough eligible players).
							// Release the escrow we just took so chips aren't locked.
							const released = await this.releaseEscrow(liveConnected);
							if (!released) {
								// Escrow release failed — keep IDs in pendingEscrowReleases
								// (set at line ~433 before fetchSnapshot) and schedule an
								// alarm so the handler retries. Without this, the throw
								// below skips scheduleNextAlarm and chips stay locked until
								// an unrelated event fires.
								for (const uid of liveConnected) {
									this.pendingEscrowReleases.add(uid);
								}
								await this.persist();
								await this.scheduleNextAlarm();
							} else {
								for (const uid of liveConnected) {
									this.pendingEscrowReleases.delete(uid);
								}
							}
							throw err;
						}
						// Release escrow for connected seated players who were not dealt
						// into the hand (e.g. below big-blind threshold).  Their chips
						// should not stay locked for the entire hand duration.  Use
						// liveConnected (not escrowedUserIds) because disconnected
						// players already had their escrow released above.
						if (this.room.hand) {
							const dealtUserIds = new Set(Object.keys(this.room.hand.committed));
							const excluded = liveConnected.filter((uid) => !dealtUserIds.has(uid));
							if (excluded.length > 0) {
								const excludedReleased = await this.releaseEscrow(excluded);
								if (!excludedReleased) {
									// Escrow release failed for excluded players. They are
									// not in room.hand.committed so settlement won't clear
									// their heldChips. Track for alarm-based retry.
									for (const uid of excluded) {
										this.pendingEscrowReleases.add(uid);
									}
								} else {
									for (const uid of excluded) {
										this.pendingEscrowReleases.delete(uid);
									}
								}
							}
							this.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
						}
						// Clear pre-snapshot recovery tracking for dealt-in players.
						// The hand now manages their escrow — settlement will release it.
						if (this.room.hand) {
							for (const uid of Object.keys(this.room.hand.committed)) {
								this.pendingEscrowReleases.delete(uid);
							}
						}
						// Also clear for users whose escrow was already released
						// (disconnected during snapshot, or excluded and successfully
						// released above). Only remaining entries are failed releases.
						await this.persist();
						this.broadcastHandStarted();
						await this.scheduleNextAlarm();
					} finally {
						this.isStartingHand = false;
					}
					break;
				}
				case 'action': {
					// Guard: reject actions from players whose seat is disconnected
					// (reconnect grace expired). The alarm handler will fold/clear them.
					const playerSeat = this.room.seats.find((s) => s.userId === identity.userId);
					if (!playerSeat || !playerSeat.connected) {
						this.send(ws, {
							type: 'error',
							code: 'INVALID_ACTION',
							message: 'seat disconnected — reconnect grace expired',
						});
						return;
					}

					// Guard: if the turn deadline has already passed and the sender is the
					// current actor, auto-fold them.  This prevents a delayed alarm from
					// allowing a late action after the timeout has technically expired.
					if (
						this.room.phase === 'in-hand' &&
						this.room.hand &&
						this.turnDeadline !== null &&
						Date.now() > this.turnDeadline
					) {
						const currentSeat = this.room.hand.currentSeat;
						const currentUserId =
							currentSeat !== null ? this.room.seats[currentSeat]?.userId : null;
						if (currentUserId === identity.userId) {
							try {
								this.room = applyAction(this.room, identity.userId, { action: 'fold' });
								if (this.room.phase === 'settling') {
									this.broadcastHandEnded();
									await this.runSettlement();
								} else if (this.room.phase === 'in-hand' && this.room.hand) {
									this.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
								} else {
									this.turnDeadline = null;
								}
								await this.persist();
								this.broadcastRoomState();
							} catch {
								/* best-effort fold */
								this.turnDeadline = null;
							}
							this.send(ws, {
								type: 'error',
								code: 'INVALID_ACTION',
								message: 'turn timed out',
							});
							return;
						}
					}

					this.room = applyAction(this.room, identity.userId, parsed);
					if (this.room.phase === 'in-hand' && this.room.hand) {
						this.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
					} else {
						this.turnDeadline = null;
					}
					await this.persist();
					if (this.room.phase === 'settling') {
						this.broadcastHandEnded();
						await this.runSettlement();
					}
					await this.scheduleNextAlarm();
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

		// If user was never seated AND is not a hand participant, release their
		// membership lock immediately.  Hand participants (even unseated ones) may
		// still have chips escrowed in room.hand.committed; releasing membership
		// early lets them join another room where snapshot would reuse heldChips
		// as stack — a double-spend vector.  runSettlement releases membership for
		// committed users after the hand completes.
		const isSeated = this.room.seats.some((s) => s.userId === identity.userId);
		const isHandParticipant = this.room.hand && identity.userId in this.room.hand.committed;
		// Transfer host if the disconnecting user is the room host AND is not
		// currently seated.  When the host leaves their seat before disconnecting
		// (or was never seated — spectator-only), no seat is cleared by the alarm
		// handler so the regular host-transfer path never fires.  Without this the
		// remaining players get "host only" on start_hand and the room is stuck.
		if (!isSeated && this.room.config.hostUserId === identity.userId) {
			// Prefer a connected successor, but fall back to any seated player
			// (even disconnected — they're still in the reconnect window and
			// will likely come back). Without the fallback the alarm path won't
			// re-trigger host transfer for an unseated host, so the room stays
			// stuck with hostUserId pointing at the departed host.
			const successor =
				this.room.seats.find(
					(s) => s.userId !== null && s.connected && s.userId !== identity.userId,
				) ?? this.room.seats.find((s) => s.userId !== null && s.userId !== identity.userId);
			if (successor?.userId) {
				this.room = {
					...this.room,
					config: { ...this.room.config, hostUserId: successor.userId },
				};
			}
		}
		if (!isSeated && !isHandParticipant) {
			await this.releaseMembership(identity.userId);
		}

		// If the disconnected player is the active seat, do NOT fold immediately.
		// The 30-second reconnect window (via alarm) gives them a chance to rejoin.
		// The alarm handler will fold timed-out players after the grace period.

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

		// Retry stuck settlement: if the DO reloaded with phase='settling' after a crash,
		// or if a previous settlement attempt exhausted retries (phase='frozen'), re-attempt.
		if ((this.room.phase === 'settling' || this.room.phase === 'frozen') && this.room.hand) {
			await this.runSettlement();
			// Broadcast the updated state so hibernated clients see the room
			// transition back to seating instead of remaining stuck in-hand.
			this.broadcastRoomState();
			// If settlement succeeded, room is now in 'seating' phase — fall through
			// to normal alarm logic. If it failed (frozen), also fall through.
		}

		// Retry pending membership lock releases from previous failed attempts.
		// Skip users who have reconnected (seated or have an open socket) —
		// releasing their lock while active would break the one-room invariant.
		if (this.pendingLockReleases.size > 0) {
			const pending = [...this.pendingLockReleases];
			for (const uid of pending) {
				const stillSeated = this.room.seats.some((s) => s.userId === uid);
				const hasOpenSocket = Array.from(this.sockets.values()).some((id) => id.userId === uid);
				if (stillSeated || hasOpenSocket) {
					this.pendingLockReleases.delete(uid);
					continue;
				}
				await this.releaseMembership(uid);
			}
		}

		// Retry pending escrow-only releases. Unlike pendingLockReleases above,
		// these retries proceed even for active (seated/connected) users because
		// their chips are stuck in heldChips with no hand to settle them.
		// Escrow release does NOT release the membership lock, so the one-room
		// invariant is preserved.
		if (this.pendingEscrowReleases.size > 0) {
			const pendingEscrow = [...this.pendingEscrowReleases];
			for (const uid of pendingEscrow) {
				// If the user is now in the active hand's committed map, their
				// escrow will be settled normally — remove from retry set.
				const isHandParticipant = this.room.hand && uid in this.room.hand.committed;
				if (isHandParticipant) {
					this.pendingEscrowReleases.delete(uid);
					continue;
				}
				const released = await this.releaseEscrow([uid]);
				if (released) {
					this.pendingEscrowReleases.delete(uid);
				}
				// If release failed, keep the ID in pendingEscrowReleases for
				// the next alarm tick. Do NOT fall through to releaseMembership —
				// the user may still be active in this room.
			}
			if (this.pendingEscrowReleases.size !== pendingEscrow.length) {
				await this.persist();
			}
		}

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
				// All-in players have no pending action — never fold them
				if (this.room.hand.allIn.has(userId)) continue;

				const isCurrentActor =
					this.room.hand.currentSeat !== null &&
					this.room.seats[this.room.hand.currentSeat]?.userId === userId;

				try {
					if (isCurrentActor) {
						// Current actor timed out — fold normally so turn advances correctly
						this.room = applyAction(this.room, userId, { action: 'fold' });
						if (this.room.phase === 'in-hand' && this.room.hand) {
							this.turnDeadline = now + TURN_TIMEOUT_MS;
						} else {
							this.turnDeadline = null;
						}
					} else {
						// Non-current player — fold without moving the turn cursor
						this.room = forceFold(this.room, userId);
					}
					if (this.room.phase === 'settling') {
						this.broadcastHandEnded();
						await this.runSettlement();
						// runSettlement() clears this.room.hand to null on success.
						// Broadcast so clients see the room back in seating phase.
						this.broadcastRoomState();
						// Remaining timed-out players are no longer in a hand, so
						// stop folding — fall through to seat/membership cleanup below.
						break;
					}
				} catch {
					/* best-effort fold */
				}
			}
		}

		// Auto-fold connected players whose turn timer expired (kept WebSocket open
		// but never acted).  This prevents the hand from stalling indefinitely when
		// a seated player goes idle while connected.
		if (
			this.room.phase === 'in-hand' &&
			this.room.hand &&
			this.turnDeadline !== null &&
			now >= this.turnDeadline
		) {
			const currentSeat = this.room.hand.currentSeat;
			const seat = this.room.seats[currentSeat];
			const userId = seat?.userId;
			if (
				userId &&
				seat.connected &&
				!this.room.hand.folded.has(userId) &&
				!this.room.hand.allIn.has(userId)
			) {
				try {
					this.room = applyAction(this.room, userId, { action: 'fold' });
					if (this.room.phase === 'settling') {
						this.broadcastHandEnded();
						await this.runSettlement();
					} else if (this.room.phase === 'in-hand' && this.room.hand) {
						this.turnDeadline = now + TURN_TIMEOUT_MS;
					} else {
						this.turnDeadline = null;
					}
					await this.persist();
					this.broadcastRoomState();
				} catch {
					/* best-effort fold */
					this.turnDeadline = null;
				}
			} else {
				this.turnDeadline = null;
			}
		}

		// Clear the timed-out seats — but preserve seats for players still active in
		// the hand (not folded, e.g. all-in players). Folded+disconnected players have
		// already been folded above, so clearing their seat is safe.
		// Only non-folded dealt-in players need the seat preserved for buildSidePots / finishHand.
		const dealtInUserIds = this.room.hand
			? new Set(
					Object.keys(this.room.hand.holeCards).filter((uid) => !this.room.hand!.folded.has(uid)),
				)
			: new Set<string>();
		let mutated = false;
		const seats = this.room.seats.map((s) => {
			if (s.userId && s.disconnectedAt !== null && now - s.disconnectedAt >= RECONNECT_TIMEOUT_MS) {
				if (dealtInUserIds.has(s.userId)) {
					if (this.room.phase !== 'frozen' && this.room.phase !== 'settling') {
						// Player is still in the hand — keep the seat but reset the timeout marker
						// to now so scheduleNextAlarm() schedules a future alarm. After the hand
						// settles, the next alarm will see the player is no longer dealt-in and
						// clear their seat + release membership.
						mutated = true;
						return { ...s, disconnectedAt: now };
					}
					// Frozen/settling room — settlement uses seatIndexMap, not live seats,
					// so there's no reason to preserve disconnected dealt-in seats. Clearing
					// them ensures the anyHuman check below correctly reflects that no humans
					// are present, allowing the retry/eviction path to recover the room.
				}
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
			// If the host was among the cleared seats, transfer host to another
			// seated connected player so the room remains startable. If no
			// eligible player exists the room will be evicted below by the
			// anyHuman check.
			const hostStillSeated = seats.some((s) => s.userId === this.room!.config.hostUserId);
			if (!hostStillSeated) {
				// Prefer a connected successor, but fall back to any seated
				// player (even disconnected — they're still in the reconnect
				// window and will likely come back). Without the fallback, all
				// disconnected-but-seated players are skipped and the room is
				// left with a stale hostUserId pointing at a cleared seat.
				const successor =
					seats.find((s) => s.userId !== null && s.connected) ??
					seats.find((s) => s.userId !== null);
				if (successor?.userId) {
					this.room = {
						...this.room,
						seats,
						config: { ...this.room!.config, hostUserId: successor.userId },
					};
				} else {
					this.room = { ...this.room, seats };
				}
			} else {
				this.room = { ...this.room, seats };
			}
			await this.persist();
			this.broadcastRoomState();
		}

		// Release membership locks for users whose seats were actually cleared.
		// Must happen AFTER seat clearing so dealt-in preserved seats are still counted.
		// IMPORTANT: Do NOT release membership for users still in the active hand's
		// committed map. They have chips escrowed that will be settled when the hand
		// finishes. Releasing membership early would let them join another room, where
		// snapshot would return the same heldChips as a new stack (double-spend).
		// These deferred releases are handled in runSettlement() after hand completes.
		const pendingBefore = this.pendingLockReleases.size;
		for (const uid of timedOutUserIds) {
			const stillSeated = this.room.seats.some((s) => s.userId === uid);
			const isHandParticipant = this.room.hand && uid in this.room.hand.committed;
			if (!stillSeated && !isHandParticipant) {
				await this.releaseMembership(uid);
			}
		}
		// releaseMembership may have added users to pendingLockReleases after the
		// persist() at line ~664. Persist again so a DO restart doesn't lose those
		// entries — losing them would orphan the D1 mp_membership row and permanently
		// block the user from joining another room.
		if (this.pendingLockReleases.size !== pendingBefore) {
			await this.persist();
		}

		const anyHuman = this.room.seats.some((s) => s.userId !== null);
		const hasUnresolvedHand = this.room.hand !== null;
		if (!anyHuman && !hasUnresolvedHand) {
			// If there are still pending lock releases from prior failed attempts,
			// do NOT evict yet. The affected users may no longer appear in sockets,
			// timedOutUserIds, or hostUserId (their seats were cleared in a previous
			// alarm tick), so the release list below would miss them entirely.
			// Deleting storage now would orphan the D1 mp_membership row, permanently
			// blocking the user from joining another room.
			if (this.pendingLockReleases.size > 0) {
				// Retry the pending releases and reschedule — do not evict.
				// Skip users who have reconnected (seated or have an open socket).
				const pending = [...this.pendingLockReleases];
				for (const uid of pending) {
					const stillSeated = this.room.seats.some((s) => s.userId === uid);
					const hasOpenSocket = Array.from(this.sockets.values()).some((id) => id.userId === uid);
					if (stillSeated || hasOpenSocket) {
						this.pendingLockReleases.delete(uid);
						continue;
					}
					await this.releaseMembership(uid);
				}
				await this.persist();
				await this.scheduleNextAlarm();
				return;
			}

			// Release membership locks for ALL known identities before destroying
			// the room, so stale rows don't block future joins.
			const memberIds = new Set<string>();
			for (const id of this.sockets.values()) {
				memberIds.add(id.userId);
			}
			// Include the creator who may have never connected via WebSocket.
			// The membership row is inserted during POST /api/mp/rooms, but if
			// the creator's tab closed before opening the WS, neither sockets
			// nor timedOutUserIds will contain them.
			if (this.room.config.hostUserId) {
				memberIds.add(this.room.config.hostUserId);
			}
			const allReleaseIds = [...memberIds, ...timedOutUserIds];
			// Close and clear sockets BEFORE releasing membership locks.
			// releaseMembership checks isUserActive() which returns true for
			// open sockets, causing an early return without deleting the D1
			// mp_membership row. After deleteAll(), webSocketClose exits early
			// because this.room === null, so the lock is never released and
			// the user is blocked from joining another room until grace expires.
			const openSockets = [...this.sockets.keys()];
			this.sockets.clear();
			let allReleased = true;
			for (const uid of allReleaseIds) {
				const ok = await this.releaseMembership(uid);
				if (!ok) allReleased = false;
			}
			// If any membership release failed (transient error), do NOT
			// destroy the DO. Persist pendingLockReleases and schedule an
			// alarm so the next tick retries. Deleting storage would orphan
			// the D1 mp_membership row, permanently blocking the user from
			// joining another room.
			if (!allReleased) {
				// Re-add socket users to pendingLockReleases so the alarm
				// handler retries — sockets are already cleared so the
				// reconnection guard won't skip them on retry.
				await this.persist();
				await this.scheduleNextAlarm();
				// Close the sockets now (after persist) — the DO may stay
				// alive for retries but these users are no longer tracked.
				for (const ws of openSockets) {
					try {
						ws.close(1000, 'Room evicted (retry pending)');
					} catch {
						/* ignore */
					}
				}
				return;
			}
			await this.state.storage.deleteAll();
			this.room = null;
			this.roomCode = null;
			this.doSecret = null;
			for (const ws of openSockets) {
				try {
					ws.close(1000, 'Room evicted');
				} catch {
					/* ignore */
				}
			}
			return;
		}

		// If no humans are seated but an unresolved hand still holds escrowed chips,
		// attempt settlement before evicting. This prevents heldChips from being
		// permanently locked in D1 when all players disconnect during a frozen/settling hand.
		if (!anyHuman && hasUnresolvedHand) {
			if (this.room.phase === 'settling' || this.room.phase === 'frozen') {
				await this.runSettlement();
				// runSettlement succeeded → hand cleared, room back to 'seating'.
				// The next alarm will see no humans and no hand, then evict cleanly.
				// If settlement failed again, the room stays frozen and we schedule
				// another alarm to retry.
				if (this.room?.hand) {
					// Still unresolved — schedule retry, don't evict.
					await this.scheduleNextAlarm();
					return;
				}
				// Hand cleared, but room still has no humans — evict now.
				// If there are still pending lock releases from prior failed attempts,
				// do NOT evict — the same guard as the primary eviction path above.
				if (this.pendingLockReleases.size > 0) {
					const pending = [...this.pendingLockReleases];
					for (const uid of pending) {
						await this.releaseMembership(uid);
					}
					await this.persist();
					await this.scheduleNextAlarm();
					return;
				}
				// Release membership for all remaining identities.
				const memberIds = new Set<string>();
				for (const id of this.sockets.values()) {
					memberIds.add(id.userId);
				}
				if (this.room.config.hostUserId) {
					memberIds.add(this.room.config.hostUserId);
				}
				const allReleaseIds = [...memberIds, ...timedOutUserIds];
				// Close and clear sockets BEFORE releasing membership locks
				// so isUserActive() returns false (same pattern as primary
				// eviction path above).
				const openSockets = [...this.sockets.keys()];
				this.sockets.clear();
				let allReleased = true;
				for (const uid of allReleaseIds) {
					const ok = await this.releaseMembership(uid);
					if (!ok) allReleased = false;
				}
				if (!allReleased) {
					await this.persist();
					await this.scheduleNextAlarm();
					for (const ws of openSockets) {
						try {
							ws.close(1000, 'Room evicted after settlement (retry pending)');
						} catch {
							/* ignore */
						}
					}
					return;
				}
				await this.state.storage.deleteAll();
				this.room = null;
				this.roomCode = null;
				this.doSecret = null;
				for (const ws of openSockets) {
					try {
						ws.close(1000, 'Room evicted after settlement');
					} catch {
						/* ignore */
					}
				}
				return;
			}
			// Hand exists but room isn't in settling/frozen — likely mid-hand with
			// all-in players. Schedule another alarm to wait for hand completion.
			await this.scheduleNextAlarm();
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
		// Per-turn deadline: auto-fold connected players who never act so the hand
		// does not stall indefinitely.
		if (this.room.phase === 'in-hand' && this.room.hand && this.turnDeadline !== null) {
			if (earliest === null || this.turnDeadline < earliest) earliest = this.turnDeadline;
		}
		// If there are pending lock releases (from failed escrow or lock-release
		// attempts), ensure an alarm fires soon so the alarm handler can retry.
		if (this.pendingLockReleases.size > 0 || this.pendingEscrowReleases.size > 0) {
			const retryFireAt = now + 10_000; // 10s short-fuse retry
			if (earliest === null || retryFireAt < earliest) earliest = retryFireAt;
		}
		// If the room is frozen (settlement failed after all retries), schedule
		// a retry alarm so the alarm handler can re-attempt settlement instead
		// of leaving heldChips escrowed indefinitely.
		if (this.room.phase === 'frozen') {
			const retryFireAt = now + 30_000; // 30s settlement retry
			if (earliest === null || retryFireAt < earliest) earliest = retryFireAt;
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

	private broadcastEmote(fromUserId: string, emoteId: EmoteId): void {
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
		const timeRemainingMs =
			r.phase === 'in-hand' && r.hand && this.turnDeadline !== null
				? Math.max(0, this.turnDeadline - Date.now())
				: 0;
		return {
			type: 'room_state',
			phase: r.phase as Phase,
			seats,
			pot,
			board: r.hand?.board ?? [],
			currentSeat: r.hand?.currentSeat ?? null,
			betToCall: r.hand?.currentBet ?? 0,
			timeRemainingMs,
		};
	}

	/** Check whether a user has an open socket or a connected seat in this room. */
	private isUserActive(userId: string): boolean {
		if (Array.from(this.sockets.values()).some((id) => id.userId === userId)) return true;
		return this.room?.seats.some((s) => s.userId === userId && s.connected) ?? false;
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
			signal: AbortSignal.timeout(5_000),
		});
		if (!res.ok) throw new Error(`snapshot failed: ${res.status}`);
		const json = (await res.json()) as { balances: Record<string, number> };
		return json.balances;
	}

	/**
	 * Re-acquire the membership lock (D1 mp_membership row) for a user in
	 * this room.  Used when a reconnect-during-release race deletes the row
	 * while the user has an active socket — the lock must be restored to
	 * preserve the one-room-per-user invariant.
	 */
	private async acquireMembershipLock(userId: string): Promise<boolean> {
		const origin = this.env.WORKER_ORIGIN;
		if (!origin || !this.roomCode) return false;
		const mpAuth = this.env.MP_AUTH_SECRET ?? this.doSecret ?? '';
		try {
			const res = await fetch(`${origin}/api/mp/lock`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-arcturus-auth': mpAuth,
					'x-arcturus-user-id': userId,
				},
				body: JSON.stringify({ action: 'acquire', roomCode: this.roomCode }),
				signal: AbortSignal.timeout(5_000),
			});
			return res.ok;
		} catch (err) {
			console.error(
				`[acquireMembershipLock] failed for user=${userId} room=${this.roomCode}:`,
				err,
			);
			return false;
		}
	}

	private async releaseMembership(userId: string): Promise<boolean> {
		// Release escrow BEFORE releasing the membership lock to prevent a
		// double-spend race.  If the lock were released first, the player could
		// join Room B between the two awaits; Room B's snapshot would escrow the
		// same heldChips, and this releaseEscrow call would then move Room B's
		// escrow back to chipBalance while Room B still plays against that stack.
		// Releasing escrow first ensures chips are back in chipBalance before
		// the player is free to join another room.
		const isHandParticipant = this.room?.hand && userId in this.room.hand.committed;
		if (!isHandParticipant) {
			// Pre-escrow reconnection guard: if the user reconnected before we
			// even start the escrow release, skip it entirely.  They may have
			// been re-escrowed by a new start_hand — releasing their heldChips
			// now would free the new hand's buy-in (stale release).  The alarm
			// handler will retry when they disconnect again.
			if (this.isUserActive(userId)) {
				this.pendingLockReleases.add(userId);
				return false;
			}
			const escrowOk = await this.releaseEscrow([userId]);
			if (!escrowOk) {
				// Escrow release failed (transient server error).  Do NOT release
				// the membership lock — keeping it ensures a future alarm or
				// reconnect attempt can retry.  Releasing the lock here would let
				// the user join another room while their chips are still in
				// heldChips, creating a double-spend vector or permanently stuck
				// balance with no retry mechanism.
				// Track in pendingLockReleases so the alarm handler retries the
				// full releaseMembership flow (escrow + lock) on the next alarm.
				this.pendingLockReleases.add(userId);
				console.error(
					`[releaseMembership] escrow release failed, preserving membership lock for user=${userId} room=${this.roomCode}`,
				);
				return false;
			}
		}

		// Reconnection guard: if the user reconnected while we were awaiting
		// releaseEscrow (the DO input gate reopens during non-storage fetches,
		// allowing handleUpgrade to accept a new socket), abort the lock release.
		// Releasing the lock now would let the user join another room while
		// still connected to this one, breaking the one-room invariant.
		// Return false and track in pendingLockReleases so eviction callers
		// do NOT destroy the DO.  The alarm handler will see the user is
		// active, remove them from pendingLockReleases, and skip the release.
		if (this.isUserActive(userId)) {
			this.pendingLockReleases.add(userId);
			return false;
		}

		const origin = this.env.WORKER_ORIGIN;
		if (!origin) {
			// Cannot release lock without origin — treat as failure so the
			// caller adds the user to pendingLockReleases for alarm-based retry.
			console.error(
				`[releaseMembership] WORKER_ORIGIN not configured, cannot release lock for user=${userId} room=${this.roomCode}`,
			);
			return false;
		}
		const mpAuth = this.env.MP_AUTH_SECRET ?? this.doSecret ?? '';

		// Retry lock release up to 3 attempts to handle transient failures.
		// If all attempts fail, track the user for alarm-based retry so they
		// aren't permanently blocked from joining another room.
		const MAX_ATTEMPTS = 3;
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			// Pre-check: user may have reconnected during a previous failed
			// attempt's await (fetch or retry delay).  If so, abort — the lock
			// must remain held while the user is active in this room.
			// Return false and track in pendingLockReleases for the same
			// reason as the post-escrow reconnection guard above.
			if (this.isUserActive(userId)) {
				this.pendingLockReleases.add(userId);
				return false;
			}
			try {
				const res = await fetch(`${origin}/api/mp/lock`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-arcturus-auth': mpAuth,
						'x-arcturus-user-id': userId,
					},
					body: JSON.stringify({ action: 'release', roomCode: this.roomCode }),
					signal: AbortSignal.timeout(5_000),
				});
				if (res.ok) {
					// Post-fetch reconnection guard: the user may have
					// reconnected during the fetch await.  The membership
					// row was already deleted, so re-acquire the lock
					// immediately to preserve the one-room invariant.
					// Without this, the user could acquire a lock for
					// another room while still active on this socket.
					if (this.isUserActive(userId)) {
						const reacquired = await this.acquireMembershipLock(userId);
						if (!reacquired) {
							// Lock was deleted but re-acquire failed (transient error or
							// another room grabbed the user).  Mark the seat as
							// disconnected before closing the socket so webSocketClose
							// can run its normal cleanup path instead of no-oping.
							if (this.room) {
								const seats = this.room.seats.map((s) =>
									s.userId === userId ? { ...s, connected: false, disconnectedAt: Date.now() } : s,
								);
								this.room = { ...this.room, seats };
							}
							for (const [ws, id] of this.sockets.entries()) {
								if (id.userId === userId) {
									// Do NOT remove from this.sockets here — let
									// webSocketClose handle cleanup.
									try {
										ws.close(1012, 'Membership restore failed — reconnect required');
									} catch {
										/* ignore */
									}
								}
							}
						}
						this.pendingLockReleases.add(userId);
						return false;
					}
					this.pendingLockReleases.delete(userId);
					return true;
				}
				const body = await res.text().catch(() => '');
				if (res.status >= 400 && res.status < 500) {
					// The lock API returns 200 even when the row was already deleted
					// (DELETE is idempotent), so a 4xx means a genuine auth or request
					// failure — the membership row was NOT deleted.  Return false so
					// the caller keeps the user in pendingLockReleases for alarm-based
					// retry.  Without this, a secret mismatch (403) or malformed request
					// (400) would leave the user permanently stuck with ALREADY_IN_ROOM
					// after the DO evicts and loses the retry mechanism.
					console.warn(
						`[releaseMembership] lock release ${res.status} for user=${userId} room=${this.roomCode}: ${body}`,
					);
					return false;
				}
				// Transient server error — retry
				console.error(
					`[releaseMembership] attempt ${attempt}/${MAX_ATTEMPTS} failed for user=${userId} room=${this.roomCode} status=${res.status}: ${body}`,
				);
			} catch (err) {
				console.error(
					`[releaseMembership] attempt ${attempt}/${MAX_ATTEMPTS} network error for user=${userId} room=${this.roomCode}:`,
					err,
				);
			}
			if (attempt < MAX_ATTEMPTS) {
				await new Promise((r) => setTimeout(r, 300 * attempt));
			}
		}
		// All retries exhausted — track for alarm-based retry
		this.pendingLockReleases.add(userId);
		console.error(
			`[releaseMembership] all ${MAX_ATTEMPTS} attempts failed for user=${userId} room=${this.roomCode}, will retry on next alarm`,
		);
		return false;
	}

	private async releaseEscrowForDisconnected(escrowedUserIds: string[]): Promise<string[]> {
		// Loop until stable: each releaseEscrow await yields the DO input gate,
		// so webSocketClose may mark additional players as disconnected. Keep
		// releasing escrow for newly disconnected players until no new
		// disconnections are observed, then return the final connected list.
		//
		// Users whose escrow was released are excluded from the returned list
		// even if they reconnect during a subsequent await.  Their chips have
		// already been moved from heldChips back to chipBalance; including
		// them in the hand would use the stale snapshot amount while the real
		// funds are free in chipBalance — a double-spend vector.  They must
		// wait for the next hand to be re-snapshotted and re-escrowed.
		const released = new Set<string>();
		let prevConnected = escrowedUserIds;
		for (;;) {
			const connectedNow = this.room!.seats.filter((s) => s.userId !== null && s.connected).map(
				(s) => s.userId!,
			);
			const disconnected = prevConnected.filter((uid) => !connectedNow.includes(uid));
			if (disconnected.length === 0) {
				return connectedNow.filter((uid) => !released.has(uid));
			}
			await this.releaseEscrow(disconnected);
			for (const uid of disconnected) released.add(uid);
			prevConnected = connectedNow;
		}
	}

	private async releaseEscrow(userIds: string[]): Promise<boolean> {
		const origin = this.env.WORKER_ORIGIN;
		if (!origin) {
			if (userIds.length === 0) return true;
			// Cannot release escrow without origin — treat as failure so the
			// caller preserves the membership lock for alarm-based retry.
			console.error(
				`[releaseEscrow] WORKER_ORIGIN not configured, cannot release escrow for users=${userIds.join(',')} room=${this.roomCode}`,
			);
			return false;
		}
		const mpAuth = this.env.MP_AUTH_SECRET ?? this.doSecret ?? '';
		try {
			const res = await fetch(`${origin}/api/mp/release-escrow`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-arcturus-auth': mpAuth,
				},
				body: JSON.stringify({ userIds, roomCode: this.roomCode }),
				signal: AbortSignal.timeout(5_000),
			});
			if (!res.ok) {
				const body = await res.text().catch(() => '');
				console.error(
					`[releaseEscrow] failed for users=${userIds.join(',')} room=${this.roomCode} status=${res.status}: ${body}`,
				);
				return false;
			}
			return true;
		} catch (err) {
			console.error(
				`[releaseEscrow] network error for users=${userIds.join(',')} room=${this.roomCode}:`,
				err,
			);
			return false;
		}
	}

	private async runSettlement(): Promise<void> {
		if (!this.room?.hand || !this.roomCode) return;
		const handId = `${this.roomCode}-${this.currentHandId}-${this.doSecret}`;
		const lastWinners = this.room.handLog[this.room.handLog.length - 1]?.winners ?? [];
		// Resolve winners through the hand's deal-time seatIndexMap rather than live seats.
		// Seats may have been cleared (userId=null) during crash recovery or after
		// disconnect-timeout eviction, but seatIndexMap is immutable and always accurate.
		const seatToUser = new Map<number, string>();
		for (const [uid, seatIdx] of Object.entries(this.room.hand.seatIndexMap)) {
			seatToUser.set(seatIdx, uid);
		}
		const winnersByUserId = lastWinners
			.map((w) => {
				const userId = seatToUser.get(w.seatIndex);
				return userId ? { userId, amount: w.amount } : null;
			})
			.filter((x): x is { userId: string; amount: number } => x !== null);

		const payload = buildSettlePayload({
			roomCode: this.roomCode,
			handId,
			committed: this.room.hand.committed,
			winners: winnersByUserId,
		});

		const origin = this.env.WORKER_ORIGIN;
		if (!origin) throw new Error('WORKER_ORIGIN not configured');
		const mpAuth = this.env.MP_AUTH_SECRET ?? this.doSecret ?? '';
		for (let attempt = 1; attempt <= 3; attempt++) {
			let res: Response;
			try {
				res = await fetch(`${origin}/api/mp/settle`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-arcturus-auth': mpAuth,
					},
					body: JSON.stringify(payload),
					signal: AbortSignal.timeout(10_000),
				});
			} catch (err) {
				// Transient network error — retry
				console.error(`[settle] attempt ${attempt}/3 network error:`, err);
				if (attempt < 3) await new Promise((r) => setTimeout(r, 250 * attempt));
				continue;
			}

			if (res.ok) {
				// Capture committed users before clearing hand so we can release
				// deferred membership locks for players whose seats were cleared
				// during the hand (e.g. disconnect-timeout folded players).
				const committedUserIds = this.room.hand ? Object.keys(this.room.hand.committed) : [];

				// Pre-register users needing deferred release into pendingLockReleases
				// BEFORE clearing the hand. This ensures the list is durable — if the
				// DO is restarted or evicted after the persist below, the constructor
				// will reload pendingLockReleases and schedule a retry alarm rather
				// than permanently locking the user out of other rooms.
				for (const uid of committedUserIds) {
					const stillSeated = this.room.seats.some((s) => s.userId === uid);
					const hasOpenSocket = Array.from(this.sockets.values()).some((id) => id.userId === uid);
					if (!stillSeated && !hasOpenSocket) {
						this.pendingLockReleases.add(uid);
					}
				}

				this.room = { ...this.room, phase: 'seating', hand: null };
				await this.persist();

				// Actually release membership for pre-registered users. Re-check
				// seated/socket state because a user may have reconnected during
				// the persist() await (DO input gate allows WebSocket handlers to
				// interleave across awaits).
				for (const uid of committedUserIds) {
					if (!this.pendingLockReleases.has(uid)) continue;
					const stillSeated = this.room.seats.some((s) => s.userId === uid);
					const hasOpenSocket = Array.from(this.sockets.values()).some((id) => id.userId === uid);
					if (stillSeated || hasOpenSocket) {
						// User reconnected during persist — remove from pending and skip
						this.pendingLockReleases.delete(uid);
						continue;
					}
					await this.releaseMembership(uid);
				}
				// Persist again if pendingLockReleases changed (either releaseMembership
				// failures re-added entries, or reconnected users were removed).
				if (this.pendingLockReleases.size > 0) {
					await this.persist();
				}
				await this.scheduleNextAlarm();
				return;
			}

			const body = await res.text().catch(() => '');
			if (res.status >= 400 && res.status < 500) {
				// Permanent client error (e.g. 409 insufficient_balance) — don't retry
				console.error(
					`[settle] permanent failure ${res.status}: ${body}. Freezing room ${this.roomCode}.`,
				);
				break;
			}
			// Transient server error — retry
			console.error(`[settle] attempt ${attempt}/3 server error ${res.status}: ${body}`);
			if (attempt < 3) await new Promise((r) => setTimeout(r, 250 * attempt));
		}
		// Guard: if another concurrent runSettlement() invocation already settled
		// this hand (cleared this.room.hand to null and moved phase to 'seating'),
		// don't re-freeze the room — it would create a frozen room with hand: null,
		// which the alarm retry (line ~680) cannot self-recover from because it
		// requires a non-null hand.
		if (!this.room.hand) return;

		this.room = { ...this.room, phase: 'frozen' };
		await this.persist();
		// Schedule a retry alarm so the alarm handler re-attempts settlement
		// instead of leaving heldChips escrowed indefinitely.
		await this.scheduleNextAlarm();
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
			pendingLockReleases: Array.from(this.pendingLockReleases),
			pendingEscrowReleases: Array.from(this.pendingEscrowReleases),
			turnDeadline: this.turnDeadline,
		};
		await this.state.storage.put<PersistedState>('persisted', persisted);
	}
}
