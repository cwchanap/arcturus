# Isolated Private-Room Poker Design

**Status:** Approved for implementation  
**Date:** 2026-08-05  
**Issue:** HPA-542  
**Parent roadmap:** HPA-167  
**Scope:** Replace wallet-coupled multiplayer poker with one isolated private-room module using room-local chips.

---

## 1. Context

Arcturus is a single-player-first hobby game with optional AI experiences. Multiplayer remains only as a small private-room feature: create a room, share a code, join, take a seat, and play Texas Hold'em.

The current multiplayer implementation provides that user journey, but most of its code exists to coordinate persistent account chips across Cloudflare Durable Objects, D1, and Ranked Blackjack:

- `user.heldChips` escrow.
- `mp_membership` ownership locks.
- Snapshot, settle, escrow-release, and lock-release APIs.
- Ranked-session versus multiplayer exclusion.
- Pending release sets, indefinite retries, frozen rooms, and settlement-recovery alarms.
- Persistent chip receipts, mission updates, statistics, achievements, and cleanup exceptions.

Those systems solve financial-grade accounting and rare distributed-failure cases that are not required for a secondary play-money room in a hobby project. They also make multiplayer changes affect Ranked Blackjack, the shared wallet, scheduled jobs, database migrations, and unrelated tests.

HPA-542 replaces that architecture rather than wrapping it. Existing rooms, held chips, memberships, receipts, and protocol state are disposable. There is no backward-compatibility or data-migration requirement.

---

## 2. Goals and non-goals

### 2.1 Goals

- Preserve the normal private-room flow: create, join by code, sit, start, act, finish a hand, and play another hand.
- Give every seated player a fixed room-local stack that never reads or writes the account wallet.
- Keep poker rules and state transitions pure and thoroughly tested.
- Put the room engine, protocol, browser client, room-code helpers, and Durable Object behind one `multiplayer-poker` module boundary.
- Keep Astro pages and API routes as thin adapters.
- Retain a 60-second current-turn timeout, a 30-second reconnect grace window, and five-minute empty-room cleanup.
- Remove all persistent multiplayer economy, account-statistics, mission, achievement, leaderboard, and Ranked Blackjack coupling.
- Reduce the WebSocket protocol to messages with a current producer and consumer.
- Replace the old Durable Object namespace so obsolete room state is discarded without compatibility code.
- Keep one fast multiplayer happy-path E2E test.

### 2.2 Non-goals

- Persistent multiplayer chips, buy-ins, cash-outs, profit/loss, statistics, achievements, missions, leaderboards, or history.
- Public tables, matchmaking, friends, invitations, chat, emotes, spectators, replays, tournaments, or multiple multiplayer games.
- Anti-cheat, abuse prevention, audit trails, exactly-once settlement, or recovery from every Worker, alarm, storage, or deployment interruption.
- A generic realtime-game framework, event bus, repository abstraction, session framework, or Durable Object base class.
- Migrating existing D1 rows, room state, browser state, WebSocket payloads, or receipts.
- Renaming the public page and API URL structure solely for aesthetics.
- Migrating the Worker to Durable Object RPC or changing the global Cloudflare compatibility date.
- Refactoring shared single-player poker code unrelated to the multiplayer boundary.

---

## 3. Approved decisions

| Topic | Decision |
|---|---|
| Product role | Secondary private-room poker only |
| Authentication | Required to create, join, and connect |
| Seats | 2, 4, or 6, matching the current UI |
| Starting stack | `bigBlind * 100` room-local chips |
| Stack lifetime | Persists across hands while the player remains seated |
| Rebuy | Leave and retake a seat to receive a fresh starting stack |
| Wallet | Never read or written by multiplayer |
| Statistics and progression | No game stats, missions, achievements, or leaderboards |
| Hand starter | Any connected seated player may start when no hand is active |
| Host role | Removed |
| Start eligibility | At least two connected seated players with `chips >= bigBlind` |
| Short stack | Remains seated but sits out until leaving and retaking a seat |
| Leave during hand | Rejected; the player must fold or disconnect |
| Turn timeout | 60 seconds, then force-fold the current actor |
| Reconnect grace | 30 seconds for the same authenticated user |
| Disconnect expiry | Force-fold if dealt in, then clear the seat |
| Empty-room cleanup | Clear Durable Object storage after five minutes with no seat and no socket |
| Room corruption | Clear the room and require recreation |
| Protocol compatibility | None; update server and UI atomically |
| D1 compatibility | None; reset local, test, and hobby production data |
| Durable Object compatibility | None; delete the old class and create a new namespace |
| Delivery | One atomic implementation PR with reviewable commits |

The starting stack is derived from the big blind instead of adding another room setting. This keeps effective stack depth stable when blinds change and avoids a new configuration surface.

Removing host ownership eliminates host transfer, abandoned-host recovery, and the need to lock a creator to one room. A user may have multiple room tabs; only their seat state inside each room matters.

---

## 4. Architecture

```text
src/modules/multiplayer-poker/
  room.ts              # pure room, hand, action, stack, and pot transitions
  room.test.ts
  protocol.ts          # current Zod client/server message schemas
  protocol.test.ts
  client.ts            # browser WebSocket wrapper
  client.test.ts
  room-code.ts         # MP-XXXXXX generation and validation
  room-code.test.ts
  durable-object.ts    # room persistence, sockets, reconnect, and alarms
  durable-object.test.ts
  index.ts             # public module exports
```

Existing adapters remain outside the module:

```text
src/pages/api/mp/rooms/index.ts
src/pages/api/mp/rooms/[code].ts
src/pages/api/mp/rooms/[code]/ws.ts
src/pages/games/poker-mp/index.astro
src/pages/games/poker-mp/[code].astro
src/worker.ts
```

The API and page paths remain unchanged to avoid unrelated churn. This is not a compatibility commitment; it is simply the smallest clear change.

No `routes.ts` abstraction is introduced. After membership and settlement code is deleted, each route has one small responsibility and no meaningful duplicated domain logic.

### 4.1 Dependency direction

- Pages, routes, and the Worker import multiplayer behavior through `src/modules/multiplayer-poker/index.ts`.
- Pure room tests may import `room.ts` directly.
- `room.ts` may continue using the existing poker `Card` type and `determineShowdownWinners` implementation. These are concrete poker rules with multiple active consumers, not a reason to create a generic framework.
- The module must not import D1, wallet, mission, achievement, leaderboard, Ranked Blackjack, or game-statistics code.
- No code outside the module may import `Room`, `HandState`, or other internal room structures.

### 4.2 Public exports

```ts
export {
	MultiplayerPokerRoom,
	MultiplayerPokerClient,
	ClientMessage,
	ServerMessage,
	generateRoomCode,
	isValidRoomCode,
};
export type {
	ClientMessage as ClientMessageValue,
	ServerMessage as ServerMessageValue,
	RoomMetadata,
};
```

The pure room engine is not application-facing public API. The Durable Object owns it internally.

---

## 5. Room domain model

### 5.1 Configuration and phases

```ts
export interface RoomConfig {
	maxSeats: 2 | 4 | 6;
	smallBlind: number;
	bigBlind: number;
}

export type RoomPhase = 'waiting' | 'in-hand';
```

Validation rules:

- `maxSeats` is 2, 4, or 6.
- Blinds are positive safe integers.
- `bigBlind >= smallBlind * 2`.
- `bigBlind * 100` is a safe integer.

There are no `settling` or `frozen` phases. Hand completion and room-local payout happen in one pure transition.

### 5.2 Seat state

```ts
export interface SeatState {
	seatIndex: number;
	userId: string | null;
	displayName: string | null;
	chips: number;
	connected: boolean;
	disconnectedAt: number | null;
}
```

`chips` is the uncommitted room-local stack. Chips committed to the current hand live in `HandState.committed`. During a hand, `seat.chips + hand.committed[userId]` is the player's remaining room value before a pot award.

An empty seat always has zero chips and null identity. Taking a seat assigns `chips = bigBlind * 100`. Leaving and later retaking a seat intentionally resets the stack.

### 5.3 Hand state

```ts
export interface HandState {
	bettingRound: 'preflop' | 'flop' | 'turn' | 'river';
	dealerSeat: number;
	currentSeat: number;
	deck: Card[];
	board: Card[];
	holeCards: Record<string, Card[]>;
	committed: Record<string, number>;
	currentBet: number;
	lastRaiseAmount: number;
	folded: Set<string>;
	allIn: Set<string>;
	hasActed: Set<string>;
	seatIndexMap: Record<string, number>;
}
```

Delete `mainBalance`, wallet snapshots, `handStacks`, `handLog`, settlement IDs, receipt IDs, host identity, and settlement state.

Action affordability is calculated from `SeatState.chips`. Posting a blind or taking an action immediately decreases `seat.chips` and increases `hand.committed[userId]`.

### 5.4 Starting a hand

```ts
export function startHand(
	room: Room,
	args: { deckSeed: string },
): Room;
```

A hand can start only when:

- the room is `waiting`;
- the requester occupies a connected seat;
- at least two seats are connected and have at least one big blind;
- no hand exists.

Only eligible connected seats are dealt in. A seated player with too few chips stays visible but sits out.

The Durable Object generates the seed with `crypto.randomUUID()`. The seed is not a compatibility or audit contract and is not exposed.

### 5.5 Actions and completion

```ts
export type ActionInput =
	| { action: 'fold' }
	| { action: 'check' }
	| { action: 'call' }
	| { action: 'bet'; amount: number }
	| { action: 'raise'; amount: number }
	| { action: 'all_in' };

export interface HandResult {
	winners: Array<{ seatIndex: number; amount: number }>;
}

export interface RoomTransition {
	room: Room;
	handResult?: HandResult;
}

export function applyAction(
	room: Room,
	userId: string,
	input: ActionInput,
): RoomTransition;
```

The transition validates turn ownership, action legality, available local chips, minimum raises, and short-all-in reopening rules. When a hand ends, it calculates pots, awards chips directly to seats, clears the hand, returns the room to `waiting`, and includes a one-time result for the `hand_ended` message.

This return value is deliberately small. It is not a domain-event framework.

### 5.6 Disconnect behavior

- A socket close marks the player's seat disconnected and records `disconnectedAt`.
- A reconnect by the same authenticated user within 30 seconds restores that seat and stack.
- On grace expiry, a dealt player is force-folded. The seat is cleared after the fold transition is safe.
- A waiting disconnected seat is cleared immediately at expiry.
- A current actor who remains connected but idle for 60 seconds is force-folded.
- Leaving explicitly during `in-hand` is rejected.

---

## 6. Protocol

### 6.1 Client messages

```ts
export const ClientMessage = z.discriminatedUnion('type', [
	z.object({ type: z.literal('take_seat'), seatIndex: z.number().int().min(0).max(5) }),
	z.object({ type: z.literal('leave_seat') }),
	z.object({ type: z.literal('start_hand') }),
	ActionMessage,
]);
```

Supported commands are only `take_seat`, `leave_seat`, `start_hand`, and `action`.

### 6.2 Server messages

Supported messages are only:

- `room_state`
- `hand_started`
- `hand_ended`
- `error`

`room_state` contains phase, public seats, pot, board, and current seat. Public seat state exposes display name, local chips, current commitment, folded/all-in flags, and connection state; it does not expose internal user IDs.

`hand_started` contains only the receiving player's private hole cards. `hand_ended` contains winner seat indices and awarded amounts. `error` contains only errors reachable from the retained UI and server.

Remove protocol versions, state deltas, kicks, emotes, ping/pong, abort messages, settlement errors, membership errors, and fields with no current consumer.

There is no old-message parser or negotiation. Server and browser change in the same PR.

---

## 7. Durable Object

### 7.1 Class and binding

```ts
export class MultiplayerPokerRoom implements DurableObject {
	// Existing fetch/WebSocket style retained for this focused change.
}
```

```toml
[[durable_objects.bindings]]
name = "MULTIPLAYER_POKER_ROOMS"
class_name = "MultiplayerPokerRoom"
```

The old generic `Arcturus` class and lowercase `arcturus` binding are removed.

### 7.2 Persisted state

```ts
interface PersistedRoomState {
	room: PersistedRoom;
	roomCode: string;
	turnDeadline: number | null;
	emptyDeadline: number | null;
}
```

Sets are serialized as arrays and restored on load. The object stores no D1 references, secrets, hand IDs, receipt IDs, pending release sets, retry counters, or frozen state.

Persist before broadcasting a successful mutation. Corrupt or invalid persisted state is deleted and the room becomes unavailable; clients recreate it.

### 7.3 Object endpoints

- `POST /init`: validate config, create the room, persist it, schedule empty cleanup.
- `GET /metadata`: return room code, blinds, seats, and occupancy.
- `GET /ws`: validate trusted identity headers, accept a hibernatable WebSocket, restore a reconnecting seat, and send current state.

No internal callback secret is required because the object no longer calls application settlement APIs.

### 7.4 Alarm scheduling

One alarm is scheduled at the earliest of:

- current turn deadline;
- disconnected-seat expiry;
- empty-room deadline.

The alarm handler performs due work, persists once, broadcasts when public state changes, and schedules the next deadline. It has no retry loop for external services.

The empty deadline is set when the last socket closes and no seat remains. It is cleared when a socket opens or seat is occupied. If the room stays empty for five minutes, delete storage and close remaining sockets.

---

## 8. Routes and UI

### 8.1 Create route

`POST /api/mp/rooms` becomes:

1. Authentication.
2. JSON parsing and config validation.
3. Binding availability check.
4. Room-code generation.
5. Up to five Durable Object `/init` attempts for code collisions.
6. `{ code }` response with status 201.

It does not create a D1 client, inspect Ranked Blackjack, or create a membership row.

### 8.2 Metadata route

`GET /api/mp/rooms/[code]` keeps authentication, room-code validation, binding lookup, and `/metadata` forwarding. It switches to `MULTIPLAYER_POKER_ROOMS`.

### 8.3 WebSocket route

`GET /api/mp/rooms/[code]/ws` keeps room-code validation, authentication, same-origin validation, upgrade validation, binding lookup, trusted identity-header injection, and object forwarding.

It removes all D1 reads/writes, Ranked Blackjack checks, membership acquisition, escrow release, and compensating cleanup.

### 8.4 Lobby and room pages

The lobby retains current create/join controls.

The room page continues to use the small browser client and current action controls. Seat rendering shows room-local value, for example:

```text
Seat 0: Alice — 990 chips — 10 committed
```

The page does not show account-balance effects, host ownership, rebuy dialogs, protocol versions, or persistent results.

After `hand_ended`, the page logs winners, clears private hole cards, and waits for the following `room_state`, where the pot is zero and stacks include the payout.

---

## 9. Cross-system deletion

### 9.1 Multiplayer-only files

Delete:

```text
src/server/mp/membership.ts
src/server/mp/membership.test.ts
src/server/mp/settlement.ts
src/server/mp/settlement.test.ts
src/server/mp/lock.test.ts
src/server/mp/snapshot-api.test.ts
src/server/mp/settle-api.test.ts
src/server/mp/release-escrow.test.ts
src/lib/mp-poker/roomExists.ts
src/lib/mp-poker/roomExists.test.ts
src/pages/api/mp/lock.ts
src/pages/api/mp/snapshot.ts
src/pages/api/mp/settle.ts
src/pages/api/mp/release-escrow.ts
```

Delete other old object tests whose only subject is escrow, settlement retry, frozen-room, or membership recovery behavior. Replace retained reconnect and timeout coverage with tests against the new module.

### 9.2 Database schema and migrations

Remove:

- `user.heldChips`
- `mpMembership`
- `drizzle/0008_last_living_lightning.sql`
- `drizzle/0008_mp_membership.sql`

Do not add a compatibility migration or copy held values back to `chipBalance`. Reset D1 for local, test, and hobby production environments.

### 9.3 Wallet and roulette paths

Remove `heldChips` conditions and projections from:

- `src/pages/api/chips/update.ts`
- `src/lib/chips-update-api.test.ts`
- `src/pages/api/roulette/spin.ts`
- `src/lib/roulette/spin-batch-sql.ts`
- roulette tests and integration fixtures
- Ranked repository SQL and fixtures where wallet operations require `heldChips = 0`

Ordinary single-player wallet behavior remains unchanged apart from deleting the multiplayer escrow guard.

### 9.4 Ranked Blackjack

Remove multiplayer membership dependencies from:

- `src/server/ranked/coordinator.ts`
- `src/server/ranked/http.ts`
- `src/server/ranked/expiration.ts`
- `src/server/ranked/repository.ts`
- `src/lib/ranked/protocol.ts`
- corresponding tests and test-D1 fixtures
- `src/worker.ts`

Delete `MULTIPLAYER_CONFLICT` and `MULTIPLAYER_ESCROW_ORPHANED`. Ranked start, resume, action, and expiration no longer inspect room state.

Scheduled Ranked expiration no longer receives a Durable Object namespace or membership reconciler.

### 9.5 Missions and cleanup

Multiplayer hands no longer emit mission events. Remove `poker_mp` special handling, the `mpHandsCompleted` metric, multiplayer-specific mission definitions and tests, and the `poker_mp` receipt-retention exception.

Do not replace these with room-local progression.

### 9.6 Configuration and product copy

Remove `MP_AUTH_SECRET` from `src/env.d.ts`, Wrangler comments, `README.md`, and local setup documentation.

Delete `docs/leaderboard-future-improvements.md`.

Replace profile tips promising tournaments and friend rewards with copy about current single-player games and private-room poker.

Update `CLAUDE.md` to describe `src/modules/multiplayer-poker`, `MultiplayerPokerRoom`, and `MULTIPLAYER_POKER_ROOMS`.

---

## 10. Deployment and reset strategy

### 10.1 Durable Object migration

Keep the repository's current Wrangler migration format and add:

```toml
[[migrations]]
tag = "v2"
deleted_classes = ["Arcturus"]
new_sqlite_classes = ["MultiplayerPokerRoom"]
```

The binding points only to `MultiplayerPokerRoom`. `src/worker.ts` exports only the new class.

This intentionally invalidates old room codes and state. No alias, renamed-class migration, dual binding, or old-state parser is added.

### 10.2 D1 reset

Because obsolete historical migration files are deleted and no compatibility migration is added:

- remove local Wrangler D1 state;
- recreate and apply the remaining migrations;
- recreate E2E users through the existing bootstrap;
- reset hobby production D1 before deploying the breaking branch.

The implementation PR must state that account and historical game data are discarded by this reset. That is accepted for the current no-real-user stage.

---

## 11. Testing strategy

### 11.1 Pure room tests

Cover configuration validation, 100-big-blind seat stacks, occupancy and reset behavior, connected/local-stack hand eligibility, blind posting, legal actions, current-turn validation, street progression, short all-ins, fold-out, showdown, split and side pots, odd-chip allocation, immediate payout, return to `waiting`, force-fold, and disconnected-seat cleanup.

Delete tests whose only subject is wallet snapshots, settlement phases, frozen rooms, receipt IDs, or compatibility.

### 11.2 Protocol and client tests

Assert that only retained messages parse. Explicitly reject a removed server message such as `state_delta` and a removed client message such as `emote`.

Retain client coverage for successful connect, parsed message delivery, malformed-message drop, send-only-while-open, disconnect callbacks, and superseded-socket handling.

### 11.3 Durable Object tests

Cover initialization, metadata, duplicate init, seat/action persistence, reload, reconnect within grace, reconnect after grace, turn timeout, disconnected-player expiry, earliest-deadline scheduling, empty cleanup, and corrupt-state reset.

Use fake clocks, fake storage, and direct alarm invocation. Do not wait 30 or 60 real seconds.

### 11.4 Route tests

Create-route tests cover unauthorized, malformed JSON, invalid configuration, missing binding, successful init, collision retry, exhausted collisions, and object fetch failure.

WebSocket-route tests cover invalid code, unauthorized, cross-origin, non-upgrade, missing binding, trusted identity forwarding, successful 101 forwarding, and object failure forwarding.

There are no D1 or Ranked fixtures in multiplayer route tests.

### 11.5 E2E

Keep one serial two-browser-context test:

```text
A creates a two-seat room
A and B join and take seats
both receive 1,000 chips for 5/10 blinds
A starts a hand
the current actor folds
both clients observe hand_ended
the following room_state has pot 0
winner stack is greater than the pre-hand stack
loser stack is lower than the pre-hand stack
```

Delete the 30-second Playwright disconnect test. Reconnect and alarms are covered deterministically below E2E.

### 11.6 Verification commands

```bash
bun test src/modules/multiplayer-poker
bun test src/server/mp/rooms-api.test.ts src/server/mp/ws-route-logic.test.ts
bun run test
bun run lint
bun run format:check
bun run build
bun run db:migrate:local
bun run test:e2e:mp
```

The multiplayer E2E command still requires a Durable Object-capable Wrangler server.

---

## 12. Acceptance criteria mapping

| HPA-542 criterion | Design coverage |
|---|---|
| Create → join → seat → play one hand | Routes, room model, and one E2E |
| Room-local starting stacks | `bigBlind * 100` on `takeSeat` |
| No wallet or progression dependency | Cross-system deletion requirements |
| Delete held chips and memberships | Schema, migration, routes, and Ranked cleanup |
| Delete settlement/recovery machinery | Two-phase room model and small alarm scheduler |
| Every protocol message has a producer/consumer | Four client commands and four server messages |
| Normal reconnect works | 30-second same-user grace |
| No rare crash recovery | Corrupt room is cleared and recreated |
| No backward compatibility | New object namespace and D1 reset |
| Focused engine tests and one E2E | Testing strategy |

---

## 13. Implementation boundaries

The implementation must not introduce:

- a generic Durable Object superclass;
- a generic realtime protocol framework;
- repositories for Durable Object storage;
- command or domain-event buses;
- multiple room-stack policies;
- configurable reconnect or timeout settings;
- room-history tables;
- D1 room discovery;
- automatic reconnect/backoff beyond the browser's existing explicit connect call;
- compatibility parsing for old state or messages;
- feature flags or dual paths;
- new social UI;
- unrelated poker UI redesign.

A successful implementation materially reduces source and test complexity, leaves one understandable room module, and removes multiplayer concepts from the wallet and Ranked Blackjack.
