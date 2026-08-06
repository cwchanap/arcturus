# Isolated Private-Room Poker Design

**Status:** Revised after repository review; approved for implementation  
**Date:** 2026-08-05  
**Issue:** HPA-542  
**Parent roadmap:** HPA-167  
**Scope:** Replace wallet-coupled multiplayer poker with an isolated private-room feature using room-local chips.

---

## 1. Context

Arcturus is a single-player-first hobby game with optional AI experiences. Multiplayer remains only as a small private-room feature: create a room, share a code, join, take a seat, and play Texas Hold'em.

The current private-room journey is useful, but its implementation is dominated by persistent account-chip coordination:

- `user.heldChips` escrow.
- `mp_membership` ownership locks.
- Snapshot, settle, escrow-release, and lock-release APIs.
- Ranked Blackjack versus multiplayer exclusion.
- Pending release sets, frozen rooms, and settlement-recovery alarms.
- Persistent receipts, mission updates, statistics, achievements, and cleanup exceptions.

Those systems solve accounting and rare distributed-failure cases that are not required for a secondary play-money room in a hobby project. HPA-542 removes them rather than generalizing or wrapping them.

Existing rooms, memberships, held chips, multiplayer receipts, and old WebSocket payloads are disposable. There is no backward-compatibility or data-migration requirement.

---

## 2. Goals and non-goals

### 2.1 Goals

- Preserve create room → join by code → seat → start → act → finish one hand.
- Give every seated player a fixed room-local stack.
- Never read or write the account wallet from multiplayer.
- Keep the existing pure poker rules, seeded shuffle, side-pot logic, showdown evaluator, and odd-chip allocation.
- Reduce room phases to `waiting | in-hand`.
- Remove the host role; any connected eligible seated player may start.
- Retain a 60-second turn timeout, 30-second reconnect grace, and five-minute empty-room cleanup.
- Keep the existing repository layout and make isolation a dependency rule rather than introducing a new top-level package structure.
- Reduce the protocol to messages and fields with a current producer and consumer.
- Replace the old Durable Object class/namespace only after behavior and cross-system deletion are green.
- Keep one representative two-user E2E happy path.

### 2.2 Non-goals

- Persistent multiplayer chips, profit/loss, statistics, missions, achievements, leaderboards, or history.
- Public tables, matchmaking, friends, invitations, chat, emotes, spectators, replays, or tournaments.
- Anti-cheat, abuse detection, audit trails, exactly-once settlement, or recovery from every Worker/storage interruption.
- A generic realtime-game framework, Durable Object base class, repository abstraction, event bus, or session framework.
- Migrating old D1 rows, room storage, browser state, protocol versions, or receipts.
- Refactoring unrelated single-player poker code.
- Renaming public page/API URLs.
- Migrating the Worker from the existing Wrangler `migrations` configuration to declarative `exports`.

---

## 3. Approved decisions

| Topic | Decision |
|---|---|
| Product role | Secondary private-room poker only |
| Authentication | Required to create, join, and connect |
| Seats | 2, 4, or 6 |
| Starting stack | `bigBlind * 100` room-local chips |
| Stack lifetime | Persists across hands while the player remains seated |
| Rebuy | Leave and retake a seat |
| Wallet | Never read or written |
| Progression | No multiplayer statistics, missions, achievements, or leaderboards |
| Room phases | `waiting | in-hand` |
| Hand starter | Any connected eligible seated player |
| Start eligibility | At least two connected seated players with `chips >= bigBlind` |
| Short stack | Remains seated but sits out until leaving and retaking the seat |
| Leave during hand | Rejected |
| Turn timeout | 60 seconds, then force-fold current actor |
| Reconnect grace | 30 seconds for the same authenticated user |
| Disconnect expiry | Fold first when required, settle locally if that ends the hand, then clear the seat |
| Disconnected all-in player | Retain the seat until immediate showdown/hand completion, then clear |
| Empty cleanup | Delete room storage after five minutes with no seat and no socket |
| Corrupt state | Delete room storage and require recreation |
| Compatibility | None |
| Delivery | One atomic implementation PR with buildable, testable commits |

---

## 4. Repository layout and dependency boundary

Keep the existing project structure:

```text
src/lib/mp-poker/
  engine.ts            # pure room/hand state transitions and local stacks
  engine.test.ts
  protocol.ts          # current WebSocket messages only
  protocol.test.ts
  client.ts            # browser WebSocket wrapper
  client.test.ts
  roomCode.ts          # room code generation/validation
  roomCode.test.ts

src/server/mp/
  multiplayer-poker-room.ts       # Durable Object runtime
  multiplayer-poker-room.test.ts
  rooms-api.test.ts
  ws-route-logic.test.ts
```

Astro pages and routes remain under their existing URLs.

This deliberately does **not** create `src/modules/`, rename `roomCode.ts` to kebab case, or add a barrel file. The current repository already separates pure Bun-testable game code under `src/lib` from Worker-only runtime code under `src/server`. Isolation is enforced through dependencies:

```text
multiplayer pages/routes
        |
        +--> src/lib/mp-poker/*
        |
        +--> Durable Object binding

src/server/mp/multiplayer-poker-room.ts
        |
        +--> src/lib/mp-poker/engine.ts
        +--> src/lib/mp-poker/protocol.ts
        +--> shared poker card/evaluator primitives

forbidden dependencies:
wallet, D1, Ranked Blackjack, missions, achievements,
statistics, leaderboard, settlement callbacks
```

The only server runtime file exported from the Worker is `MultiplayerPokerRoom`.

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

Validation requires positive safe-integer blinds, `bigBlind >= smallBlind * 2`, and a safe-integer `bigBlind * 100` starting stack.

### 5.2 Seats

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

An empty seat has `chips: 0`. Taking a seat assigns `bigBlind * 100`. Leaving and retaking resets the stack.

### 5.3 Hand state

Retain the existing engine-local fields needed for legal actions and payouts:

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

Delete wallet snapshots, `mainBalance`, `handStacks`, hand logs, host identity, settlement IDs, and receipt IDs.

### 5.4 Local chip movement

Posting a blind or taking a call/bet/raise/all-in action:

1. subtracts the paid amount from `SeatState.chips`;
2. adds it to `HandState.committed[userId]`;
3. never reads a D1 balance.

The existing minimum-raise, action-reopening, street progression, seeded shuffle, all-in runout, side-pot, and odd-chip behavior remains.

### 5.5 Completion result and payout identity

Internal engine results retain user identity so payout cannot accidentally target a different occupant:

```ts
export interface HandWinner {
	userId: string;
	seatIndex: number;
	amount: number;
}

export interface HandResult {
	winners: HandWinner[];
}

export interface RoomTransition {
	room: Room;
	handResult: HandResult | null;
}
```

Winner discovery uses only the immutable hand snapshot:

- `holeCards`
- `folded`
- `committed`
- `seatIndexMap`

It must not discover winners by scanning current `seat.userId`.

Payout credits a seat only when both conditions still match:

```ts
seat.seatIndex === winner.seatIndex &&
seat.userId === winner.userId
```

The normal disconnect contract guarantees an eligible winner's seat remains present until payout. The identity check is still retained as a correctness guard.

After payout:

- `phase` becomes `waiting`;
- `hand` becomes `null`;
- `HandResult` is emitted;
- expired disconnected seats are cleared.

The WebSocket `hand_ended` projection removes `userId` and exposes only `{ seatIndex, amount }`.

### 5.6 Disconnect ordering

At reconnect expiry:

1. If the user was dealt in, is not folded, and is not all-in, force-fold.
2. If that fold ends the hand, calculate and apply payout **before** clearing any seat.
3. Clear expired folded or non-participating seats.
4. Keep an expired all-in/non-folded seat until the hand completes.
5. After any later action completes the hand, apply payout and then clear expired disconnected seats.

`finishHand` and showdown evaluation therefore remain independent of live seat identity, while local stack credit remains tied to the original user occupying the original seat.

No alarm busy-loop is allowed: reconnect deadlines already expired for retained active-hand seats are omitted from the next-alarm calculation. The next action or immediate all-in runout performs final cleanup.

---

## 6. Protocol

### 6.1 Client to server

Keep:

```text
take_seat
leave_seat
start_hand
action
```

### 6.2 Server to client

Keep:

```text
room_state
hand_started
hand_ended
error
```

`room_state` contains:

```ts
{
	type: 'room_state';
	phase: 'waiting' | 'in-hand';
	seats: Array<{
		seatIndex: number;
		displayName: string | null;
		chips: number;
		committed: number;
		folded: boolean;
		allIn: boolean;
		connected: boolean;
	}>;
	pot: number;
	board: ProtocolCard[];
	currentSeat: number | null;
}
```

`currentSeat` is retained and consumed by the room page through a `data-current-seat` attribute used by the E2E flow.

`betToCall` and `timeRemainingMs` are removed because the current UI does not consume them. They should return only with a concrete UI use case.

### 6.3 Projection helper

The Durable Object file exports one pure helper:

```ts
export function toRoomStateMessage(room: Room): RoomStateMessage;
```

It is the single place that projects private engine state into the public room state. It strips `userId`, private hole cards, deck, and internal sets. This is a focused serialization helper, not a generic presenter framework.

Private hole cards continue to be sent only through `hand_started` to the matching authenticated socket.

### 6.4 Deleted surface

Delete:

- protocol version constants;
- `state_delta`;
- `kicked`;
- `hand_aborted`;
- emote messages;
- ping/pong messages;
- membership/settlement error codes;
- unused hand-ended pots/showdown payload fields.

---

## 7. Durable Object

### 7.1 Incremental implementation order

Behavior is rewritten while the file/class/binding remain:

```text
src/server/mp/arcturus.ts
class Arcturus
binding arcturus
```

This keeps intermediate commits buildable while routes and Ranked code are decoupled.

Only after every runtime dependency on the old binding is removed does the final rename happen atomically:

```text
src/server/mp/multiplayer-poker-room.ts
class MultiplayerPokerRoom
binding MULTIPLAYER_POKER_ROOMS
```

### 7.2 Persisted state

```ts
interface PersistedRoomState {
	room: PersistedRoom;
	roomCode: string;
	turnDeadline: number | null;
	emptyDeadline: number | null;
}
```

Delete `doSecret`, hand IDs used for settlement receipts, pending lock/escrow sets, start-hand external-I/O guards, and frozen-state recovery.

### 7.3 Internal endpoints

Keep:

```text
POST /init
GET  /metadata
GET  /ws
```

No internal authenticated callbacks remain.

### 7.4 Alarms

One scheduler considers:

- current turn deadline;
- clearable reconnect deadlines;
- persisted empty-room deadline.

It does not consider settlement retry, escrow release, membership release, or frozen-room recovery.

The alarm handler processes:

1. reconnect expiry and fold/payout ordering;
2. turn expiry;
3. empty-room deletion;
4. one persistence write, one broadcast, and one reschedule where practical.

Tests use fake time and direct alarm/helper invocation.

### 7.5 Corrupt state

If persisted room state cannot be decoded, call `storage.deleteAll()`, clear in-memory state, close sockets, and require room recreation. No old-state parser is added.

---

## 8. Durable Object migration

Retain the existing Wrangler migration format:

```toml
[[migrations]]
tag = "v1"
new_classes = ["Arcturus"]

[[migrations]]
tag = "v2"
deleted_classes = ["Arcturus"]
new_sqlite_classes = ["MultiplayerPokerRoom"]
```

The new namespace intentionally uses `new_sqlite_classes`.

This remains correct even though the implementation uses `state.storage.get/put`: SQLite-backed Durable Objects support the key-value storage API, and Cloudflare recommends/requires SQLite for new namespaces. The task does not introduce SQL tables or migrate the Worker to declarative `exports`.

Old room state is intentionally invalidated.

---

## 9. Routes and UI

### 9.1 Create route

`POST /api/mp/rooms`:

1. require authentication;
2. parse and validate room configuration;
3. generate a room code;
4. initialize the Durable Object;
5. retry only room-code collisions;
6. return the code.

No D1, membership, Ranked, or compensating cleanup.

### 9.2 WebSocket route

The WebSocket adapter keeps:

- room-code validation;
- authentication;
- same-origin validation;
- Upgrade validation;
- trusted user ID/display-name headers;
- forwarding to the room object.

It performs no D1 access.

### 9.3 Room page

The existing page:

- renders room-local stack and committed chips;
- handles only retained server messages;
- writes `room_state.currentSeat` to `data-current-seat`;
- does not add host UI, timers, rebuys, chat, emotes, or history.

---

## 10. Cross-system deletion

Before editing, run the authoritative audit:

```bash
git grep -nE \
	'heldChips|mp_membership|mpMembership|MP_AUTH_SECRET|reconcileMultiplayer|poker_mp|mpHandsCompleted|pendingEscrow|pendingLock|SETTLEMENT_FAILED' \
	-- src e2e scripts drizzle wrangler.toml README.md CLAUDE.md AGENTS.md
```

Every result must be classified as delete, edit, or intentionally retained historical documentation. The implementation plan contains the currently known blast radius, but the fresh grep output is authoritative.

Delete or update:

- multiplayer settlement, snapshot, lock, release, membership, and room-probe files;
- Ranked coordinator/HTTP/repository/expiration composition;
- wallet and roulette `heldChips` guards;
- schema and migrations;
- mission `poker_mp` metrics and fixtures;
- receipt cleanup exceptions;
- daily-challenge, Ranked, roulette, chip-sync, mission, and migration-runner test fixtures;
- `MP_AUTH_SECRET`;
- obsolete social/tournament copy and speculative leaderboard document.

No replacement cross-system lock is introduced. Multi-tab and multi-room participation is acceptable for this hobby private-room mode.

---

## 11. D1 reset and migration-file policy

The historical migrations that introduced only the discarded fields are removed:

```text
drizzle/0008_last_living_lightning.sql
drizzle/0008_mp_membership.sql
```

Deleting them is valid only because every target database is explicitly recreated. It is not presented as a forward migration for an already-applied database.

### 11.1 Local reset

From the repository root:

```bash
rm -rf .wrangler/state
bun run db:migrate:local
```

This resets local D1 and Durable Object state.

### 11.2 Remote hobby database reset

This is a deliberate destructive release operation:

```bash
bunx wrangler d1 delete arcturus --skip-confirmation
bunx wrangler d1 create arcturus
```

Copy the returned database ID into `wrangler.toml`, then run:

```bash
bun run db:migrate:remote
```

The implementation PR must state that existing account/game data is discarded. If a future environment cannot be recreated, it must use a separate forward drop migration; that is outside HPA-542.

---

## 12. Testing

### 12.1 Engine

Retain/adapt legal-action, seeded shuffle, side-pot, tie, odd-chip, short-all-in, and runout tests.

Add:

- 100-BB starting stack;
- blind/action debit;
- immediate fold-out payout;
- showdown payout;
- leave/reseat reset;
- winner discovery independent of live seats;
- disconnect-expired eventual winner is paid before seat clear;
- disconnected all-in winner is paid, then cleared;
- identity mismatch never credits a replacement occupant.

### 12.2 Durable Object

Cover:

- init and metadata;
- duplicate init;
- persistence/reload;
- public-state projection;
- reconnect within grace;
- expired fold → payout → clear ordering;
- all-in disconnected seat retention;
- turn timeout;
- earliest deadline;
- empty cleanup;
- corrupt-state deletion.

No real-time sleeps.

### 12.3 Routes

Route tests use stubs, not D1 or Ranked fixtures.

### 12.4 E2E

One two-context flow:

```text
A creates 2-seat 5/10 room
A and B take seats with 1,000 chips
A or B starts
page exposes currentSeat
current actor folds
both observe hand_ended
pot returns to zero immediately
winner stack rises and loser stack falls
```

Delete the 30-second Playwright disconnect test.

---

## 13. Acceptance criteria mapping

| Criterion | Coverage |
|---|---|
| Create/join/seat/play one hand | Routes, room runtime, E2E |
| Room-local stacks | Engine model and tests |
| No wallet/progression/Ranked dependency | Cross-system audit and deletion |
| Delete escrow/membership/recovery | DO and schema deletion |
| Every protocol field consumed | Minimal protocol and page current-seat consumer |
| Normal reconnect | 30-second grace tests |
| No rare crash recovery | Corrupt room reset |
| No compatibility/data migration | New namespace and explicit D1 recreation |
| Focused tests and one E2E | Test strategy |

---

## 14. Implementation boundaries

Do not introduce:

- `src/modules/` as part of this task;
- a barrel/public package layer;
- a generic Durable Object superclass;
- a generic realtime protocol;
- repositories for room storage;
- event/command buses;
- multiple stack policies;
- configurable timeout policies;
- room-history tables;
- D1 room discovery;
- compatibility parsers;
- feature flags or dual paths;
- unrelated UI redesign.

The result should be a materially smaller private-room implementation that follows the repository's existing layout and removes multiplayer concepts from the wallet and Ranked Blackjack.
