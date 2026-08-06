# Isolated Private-Room Poker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep private-room Texas Hold'em playable while replacing persistent wallet escrow and cross-system recovery with one isolated room-local multiplayer module.

**Architecture:** Move the pure room engine, protocol, browser client, room-code helpers, and Durable Object into `src/modules/multiplayer-poker`. The Durable Object owns room-local stacks, WebSockets, persistence, reconnect grace, turn timeout, and empty-room cleanup; Astro routes remain thin authenticated adapters. Delete D1 membership, escrow, settlement callbacks, Ranked Blackjack exclusion, progression effects, protocol compatibility, and rare-failure retry machinery in the same breaking branch.

**Tech Stack:** Astro 5 SSR, Cloudflare Workers, Cloudflare Durable Objects with hibernatable WebSockets, TypeScript, Zod 4, Bun test runner, Miniflare/Vitest where already used, Playwright, Drizzle ORM, Cloudflare D1, Wrangler 4.

## Global Constraints

- Private rooms remain the only multiplayer product: create, share code, join, seat, and play.
- Starting stack is exactly `bigBlind * 100` room-local chips.
- Room phases are exactly `waiting` and `in-hand`.
- Turn timeout is exactly 60 seconds.
- Reconnect grace is exactly 30 seconds.
- Empty-room cleanup delay is exactly five minutes.
- Any connected eligible seated player may start a hand; there is no host role.
- Multiplayer must not read or write D1, `user.chipBalance`, missions, achievements, statistics, leaderboards, or Ranked Blackjack state.
- No backward-compatibility layer, old WebSocket parser, old Durable Object alias, or data migration.
- D1 reset and old-room invalidation are accepted.
- Keep the existing `/games/poker-mp` and `/api/mp/rooms` URLs; do not spend scope renaming routes.
- Do not introduce a generic realtime-game framework, Durable Object base class, repository, event bus, or configurable stack policy.
- Preserve existing poker action legality, hand evaluation, side-pot calculation, and odd-chip allocation unless a local-stack test proves a required change.
- Use tabs, single quotes, semicolons, and the repository's current ESLint and Prettier rules.

---

## File structure

| Action | Path | Responsibility |
|---|---|---|
| Create via move | `src/modules/multiplayer-poker/room.ts` | Pure room-local poker state and transitions |
| Create via move | `src/modules/multiplayer-poker/room.test.ts` | Room, action, stack, pot, and payout tests |
| Create via move | `src/modules/multiplayer-poker/protocol.ts` | Minimal Zod WebSocket protocol |
| Create via move | `src/modules/multiplayer-poker/protocol.test.ts` | Producer/consumer protocol coverage |
| Create via move | `src/modules/multiplayer-poker/client.ts` | Browser WebSocket wrapper |
| Create via move | `src/modules/multiplayer-poker/client.test.ts` | Client connection and parsing tests |
| Create via move | `src/modules/multiplayer-poker/room-code.ts` | Room-code generation and validation |
| Create via move | `src/modules/multiplayer-poker/room-code.test.ts` | Room-code tests |
| Create via rewrite | `src/modules/multiplayer-poker/durable-object.ts` | Room storage, sockets, reconnect, and alarms |
| Create | `src/modules/multiplayer-poker/durable-object.test.ts` | Deterministic object behavior tests |
| Create | `src/modules/multiplayer-poker/index.ts` | Narrow public exports |
| Modify | `src/pages/api/mp/rooms/index.ts` | Thin create-room adapter |
| Modify | `src/pages/api/mp/rooms/[code].ts` | Thin metadata adapter |
| Modify | `src/pages/api/mp/rooms/[code]/ws.ts` | Thin authenticated WebSocket adapter |
| Modify | `src/pages/games/poker-mp/index.astro` | Existing lobby using the isolated create route |
| Modify | `src/pages/games/poker-mp/[code].astro` | Local-stack room UI |
| Modify | `src/worker.ts` | Export new object and remove Ranked membership composition |
| Modify | `src/env.d.ts` | Rename object binding and remove `MP_AUTH_SECRET` |
| Modify | `wrangler.toml` | New object binding and breaking migration |
| Modify | `src/db/schema.ts` | Remove `heldChips` and `mpMembership` |
| Delete | `drizzle/0008_last_living_lightning.sql` | Obsolete `heldChips` migration |
| Delete | `drizzle/0008_mp_membership.sql` | Obsolete membership migration |
| Delete | `src/server/mp/membership.ts` and test | Persistent room lock and reconciliation |
| Delete | `src/server/mp/settlement.ts` and test | Persistent hand settlement payload |
| Delete | `src/pages/api/mp/{lock,snapshot,settle,release-escrow}.ts` | Internal economy callbacks |
| Delete | callback, lock, escrow, recovery, and frozen-room tests under `src/server/mp/` | Compatibility and rare-failure coverage |
| Modify | Ranked, wallet, roulette, missions, cleanup, configuration, and documentation files listed below | Remove cross-system multiplayer concepts |
| Modify | `e2e/multiplayer-poker.spec.ts` | One fast local-stack happy path |

The design reference is `docs/superpowers/specs/2026-08-05-isolated-multiplayer-poker-design.md`.

---

### Task 1: Replace the poker room engine with room-local stacks

**Files:**

- Move and rewrite: `src/lib/mp-poker/engine.ts` → `src/modules/multiplayer-poker/room.ts`
- Move and rewrite: `src/lib/mp-poker/engine.test.ts` → `src/modules/multiplayer-poker/room.test.ts`

**Interfaces:**

- Consumes: `Card` from `src/lib/poker/types.ts` and `determineShowdownWinners` from `src/lib/poker/handEvaluator.ts`.
- Produces:

```ts
export interface RoomConfig {
	maxSeats: 2 | 4 | 6;
	smallBlind: number;
	bigBlind: number;
}

export type RoomPhase = 'waiting' | 'in-hand';

export interface HandResult {
	winners: Array<{ seatIndex: number; amount: number }>;
}

export interface RoomTransition {
	room: Room;
	handResult?: HandResult;
}

export function createRoom(config: RoomConfig): Room;
export function takeSeat(
	room: Room,
	args: { userId: string; displayName: string; seatIndex: number },
): Room;
export function leaveSeat(room: Room, userId: string): Room;
export function startHand(room: Room, args: { deckSeed: string }): Room;
export function applyAction(room: Room, userId: string, action: ActionInput): RoomTransition;
export function forceFold(room: Room, userId: string): RoomTransition;
```

- [ ] **Step 1: Move the engine and test files before changing behavior**

```bash
mkdir -p src/modules/multiplayer-poker
git mv src/lib/mp-poker/engine.ts src/modules/multiplayer-poker/room.ts
git mv src/lib/mp-poker/engine.test.ts src/modules/multiplayer-poker/room.test.ts
sed -i.bak "s#from './engine'#from './room'#" src/modules/multiplayer-poker/room.test.ts
rm src/modules/multiplayer-poker/room.test.ts.bak
```

- [ ] **Step 2: Replace seating tests with the local-stack contract**

Add these first assertions:

```ts
test('takeSeat grants exactly one hundred big blinds', () => {
	let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10 });
	room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0 });
	expect(room.phase).toBe('waiting');
	expect(room.seats[0].chips).toBe(1000);
});

test('leave and retake resets the local stack', () => {
	let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10 });
	room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0 });
	room = { ...room, seats: room.seats.map((seat, index) => index === 0 ? { ...seat, chips: 125 } : seat) };
	room = leaveSeat(room, 'u1');
	room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0 });
	expect(room.seats[0].chips).toBe(1000);
});
```

- [ ] **Step 3: Run the local-stack tests and verify the old API fails**

```bash
bun test src/modules/multiplayer-poker/room.test.ts --test-name-pattern 'one hundred big blinds|resets the local stack'
```

Expected: FAIL because `hostUserId` and `mainBalance` are still required and seats do not own local chips.

- [ ] **Step 4: Simplify configuration, phase, and seat types**

Make `RoomConfig` contain only `maxSeats`, `smallBlind`, and `bigBlind`. Validate 2, 4, or 6 seats; positive safe-integer blinds; `bigBlind >= smallBlind * 2`; and a safe `bigBlind * 100` starting stack.

Use only:

```ts
export type RoomPhase = 'waiting' | 'in-hand';

export interface SeatState {
	seatIndex: number;
	userId: string | null;
	displayName: string | null;
	chips: number;
	connected: boolean;
	disconnectedAt: number | null;
}
```

Delete `mainBalance`, `hostUserId`, `handLog`, `settling`, and `frozen`.

- [ ] **Step 5: Change hand start to use connected local stacks**

Change the signature to `startHand(room, { deckSeed })`. Build eligibility from connected seats where `chips >= bigBlind`. Post blinds by decrementing seat chips and recording the same amounts in `hand.committed`.

Add and run:

```ts
test('startHand debits blinds from seat chips', () => {
	let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10 });
	room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0 });
	room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1 });
	room = startHand(room, { deckSeed: 'blind-test' });
	expect(room.seats[0].chips + room.seats[1].chips).toBe(1985);
	expect(Object.values(room.hand!.committed).reduce((sum, amount) => sum + amount, 0)).toBe(15);
});
```

```bash
bun test src/modules/multiplayer-poker/room.test.ts --test-name-pattern 'debits blinds'
```

Expected after implementation: PASS.

- [ ] **Step 6: Debit every betting action from `seat.chips`**

For call, bet, raise, and all-in, calculate affordability from the current seat's chips. Subtract the paid amount from the seat and add it to `hand.committed`. Preserve existing action-order, minimum-raise, and short-all-in reopening rules.

Add an invariant helper in tests:

```ts
function totalRoomChips(room: Room): number {
	return room.seats.reduce((sum, seat) => sum + seat.chips, 0) +
		Object.values(room.hand?.committed ?? {}).reduce((sum, amount) => sum + amount, 0);
}
```

Assert total room chips remain constant throughout actions.

- [ ] **Step 7: Finish and pay out a hand synchronously**

Change `applyAction` and `forceFold` to return `RoomTransition`. When fold-out or showdown completes:

1. Build pots with existing side-pot rules.
2. Allocate odd chips using existing dealer-relative order.
3. Add awarded amounts directly to winner seats.
4. Clear `room.hand`.
5. Set `phase: 'waiting'`.
6. Return `{ room, handResult: { winners } }`.

Add:

```ts
test('fold-out pays the winner and returns to waiting', () => {
	let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10 });
	room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0 });
	room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1 });
	room = startHand(room, { deckSeed: 'fold-out' });
	const transition = applyAction(room, 'u1', { action: 'fold' });
	expect(transition.room.phase).toBe('waiting');
	expect(transition.room.hand).toBeNull();
	expect(transition.handResult?.winners).toEqual([{ seatIndex: 1, amount: 15 }]);
	expect(transition.room.seats[1].chips).toBe(1005);
});
```

- [ ] **Step 8: Adapt force-fold and disconnected-seat payout safety**

Keep `seatIndexMap` captured at deal time. Force-folding a disconnected player must not allow that cleared seat to win a pot. Add one test that force-folds, clears the seat after completion, and asserts all awarded seat indices still refer to occupied eligible winners.

- [ ] **Step 9: Delete wallet and settlement-only engine tests**

Delete test cases centered on snapshot omission, late seating during snapshot fetch, settling-phase leave, frozen phase, hand-log persistence, or settlement payload preparation.

Retain and adapt legal actions, streets, short all-ins, side pots, ties, odd chips, all-in runout, and disconnect force-fold tests.

- [ ] **Step 10: Run and inspect the focused room suite**

```bash
bun test src/modules/multiplayer-poker/room.test.ts
! grep -E 'hostUserId|mainBalance|snapshots|handStacks|handLog|settling|frozen' \
	src/modules/multiplayer-poker/room.ts
```

Expected: room tests PASS and the absence check succeeds.

- [ ] **Step 11: Commit**

```bash
git add -A src/lib/mp-poker src/modules/multiplayer-poker
git commit -m 'refactor(mp): use room-local poker stacks'
```

---

### Task 2: Move and reduce the protocol, client, and room-code API

**Files:**

- Move: `src/lib/mp-poker/protocol.ts` → `src/modules/multiplayer-poker/protocol.ts`
- Move: `src/lib/mp-poker/protocol.test.ts` → `src/modules/multiplayer-poker/protocol.test.ts`
- Move: `src/lib/mp-poker/client.ts` → `src/modules/multiplayer-poker/client.ts`
- Move: `src/lib/mp-poker/client.test.ts` → `src/modules/multiplayer-poker/client.test.ts`
- Move: `src/lib/mp-poker/roomCode.ts` → `src/modules/multiplayer-poker/room-code.ts`
- Move: `src/lib/mp-poker/roomCode.test.ts` → `src/modules/multiplayer-poker/room-code.test.ts`
- Create: `src/modules/multiplayer-poker/index.ts`
- Delete: `src/lib/mp-poker/roomExists.ts`
- Delete: `src/lib/mp-poker/roomExists.test.ts`
- Modify imports in current pages, routes, and `src/server/mp/arcturus.ts`

**Interfaces:**

- Consumes: `RoomTransition` and public room projection from Task 1.
- Produces: `ClientMessage`, `ServerMessage`, `MultiplayerPokerClient`, room-code helpers, and the module public entry point.

- [ ] **Step 1: Move files with Git history**

```bash
git mv src/lib/mp-poker/protocol.ts src/modules/multiplayer-poker/protocol.ts
git mv src/lib/mp-poker/protocol.test.ts src/modules/multiplayer-poker/protocol.test.ts
git mv src/lib/mp-poker/client.ts src/modules/multiplayer-poker/client.ts
git mv src/lib/mp-poker/client.test.ts src/modules/multiplayer-poker/client.test.ts
git mv src/lib/mp-poker/roomCode.ts src/modules/multiplayer-poker/room-code.ts
git mv src/lib/mp-poker/roomCode.test.ts src/modules/multiplayer-poker/room-code.test.ts
git rm src/lib/mp-poker/roomExists.ts src/lib/mp-poker/roomExists.test.ts
```

Update moved room-code test imports from `./roomCode` to `./room-code`.

- [ ] **Step 2: Write the reduced-protocol tests first**

Replace protocol tests with positive cases for four client and four server message types. Add explicit rejection:

```ts
test('rejects removed messages', () => {
	expect(() => ClientMessage.parse({ type: 'emote', emoteId: 'good_game' })).toThrow();
	expect(() => ServerMessage.parse({ type: 'state_delta', patch: {} })).toThrow();
});
```

- [ ] **Step 3: Run protocol tests and verify removed messages still parse**

```bash
bun test src/modules/multiplayer-poker/protocol.test.ts
```

Expected: FAIL because the old schemas still accept removed protocol branches.

- [ ] **Step 4: Reduce `protocol.ts`**

Keep client messages `take_seat`, `leave_seat`, `start_hand`, and `action` only. Keep server messages `room_state`, `hand_started`, `hand_ended`, and `error` only.

Delete `PROTOCOL_VERSION`, `EMOTES`, `state_delta`, `kicked`, `hand_aborted`, emotes, ping/pong, membership/settlement error codes, and unused message fields.

Public seat schema must include `seatIndex`, `displayName`, `chips`, `committed`, `folded`, `allIn`, and `connected`, but not `userId` or `disconnectedAt`.

- [ ] **Step 5: Retain the small browser client without adding reconnect machinery**

Keep explicit `connect`, `send`, `on`, `onDisconnect`, and `close`. Preserve malformed-message dropping and superseded-socket handling. Do not add automatic retry, backoff, heartbeat, or protocol negotiation.

Run:

```bash
bun test src/modules/multiplayer-poker/client.test.ts
```

Expected: PASS after imports and schemas are updated.

- [ ] **Step 6: Add the narrow public entry point**

Create `src/modules/multiplayer-poker/index.ts`:

```ts
export { MultiplayerPokerClient } from './client';
export { ClientMessage, ServerMessage } from './protocol';
export { generateRoomCode, isValidRoomCode } from './room-code';
export type { ClientMessage as ClientMessageValue, ServerMessage as ServerMessageValue } from './protocol';
```

Task 3 adds the Durable Object and metadata exports.

- [ ] **Step 7: Update all old imports**

List old imports:

```bash
git grep -n 'lib/mp-poker' -- src || true
```

Pages and routes import public values from `modules/multiplayer-poker`. Until Task 3 moves the object, `src/server/mp/arcturus.ts` may import internal room/protocol files directly from `../../modules/multiplayer-poker`.

- [ ] **Step 8: Run focused tests and absence checks**

```bash
bun test \
	src/modules/multiplayer-poker/protocol.test.ts \
	src/modules/multiplayer-poker/client.test.ts \
	src/modules/multiplayer-poker/room-code.test.ts
! git grep -E 'PROTOCOL_VERSION|state_delta|emote_received|hand_aborted|type: .ping.|type: .pong.' -- src
```

Expected: tests PASS and no obsolete runtime symbol remains.

- [ ] **Step 9: Commit**

```bash
git add -A src/lib/mp-poker src/modules/multiplayer-poker src/pages src/server/mp/arcturus.ts
git commit -m 'refactor(mp): reduce and relocate room protocol'
```

---

### Task 3: Replace the Durable Object with the isolated room runtime

**Files:**

- Move and rewrite: `src/server/mp/arcturus.ts` → `src/modules/multiplayer-poker/durable-object.ts`
- Create: `src/modules/multiplayer-poker/durable-object.test.ts`
- Delete: `src/server/mp/reconnect-guard.test.ts`
- Rewrite: `src/server/mp/turn-timeout.test.ts` into the module object test, then delete the old file
- Modify: `src/modules/multiplayer-poker/index.ts`
- Modify: `src/worker.ts`
- Modify: `src/env.d.ts`
- Modify: `wrangler.toml`

**Interfaces:**

- Consumes: room transitions and protocol from Tasks 1–2.
- Produces: `MultiplayerPokerRoom`, `RoomMetadata`, `MULTIPLAYER_POKER_ROOMS` binding, and persisted room state with only room/deadline data.

- [ ] **Step 1: Move the class and create an object test seam**

```bash
git mv src/server/mp/arcturus.ts src/modules/multiplayer-poker/durable-object.ts
git rm src/server/mp/reconnect-guard.test.ts
```

Extract pure deadline selection used by the class:

```ts
export interface RoomDeadlines {
	turnDeadline: number | null;
	emptyDeadline: number | null;
}

export function nextAlarmAt(room: Room, deadlines: RoomDeadlines): number | null;
```

The function chooses the earliest turn deadline, disconnected-seat expiry, or empty deadline.

- [ ] **Step 2: Write deadline tests before deleting retry branches**

Create `durable-object.test.ts` with cases proving turn deadline, reconnect expiry, and empty deadline ordering. Include a test where no deadline returns `null`.

```bash
bun test src/modules/multiplayer-poker/durable-object.test.ts
```

Expected initially: FAIL because the helper does not exist.

- [ ] **Step 3: Replace persisted state**

Use only:

```ts
interface PersistedRoomState {
	room: PersistedRoom;
	roomCode: string;
	turnDeadline: number | null;
	emptyDeadline: number | null;
}
```

Delete `doSecret`, `currentHandId`, `pendingLockReleases`, `pendingEscrowReleases`, `isStartingHand`, settlement state, external callbacks, and retry counters.

- [ ] **Step 4: Simplify initialization and metadata**

`POST /init` validates `RoomConfig`, creates the room, persists it, and schedules empty cleanup. It returns `{ ok: true }` without a secret.

`GET /metadata` returns:

```ts
export interface RoomMetadata {
	roomCode: string;
	maxSeats: number;
	smallBlind: number;
	bigBlind: number;
	occupancy: number;
}
```

Duplicate initialization returns 409.

- [ ] **Step 5: Rewrite WebSocket message handling around pure transitions**

For `take_seat`, call `takeSeat`. For `leave_seat`, call `leaveSeat`. For `start_hand`, require the requester to be connected and seated, generate `crypto.randomUUID()` as the seed, and call `startHand`. For `action`, call `applyAction`.

After every accepted mutation:

1. Persist.
2. Send private `hand_started` cards where applicable.
3. Broadcast `hand_ended` if the transition contains a result.
4. Broadcast the latest `room_state`.
5. Schedule the next alarm.

There is no fetch to D1 or application APIs.

- [ ] **Step 6: Implement reconnect and close behavior**

On upgrade, restore a seat only when the same `userId` reconnects within 30 seconds. On close, mark the matching seat disconnected and set the timestamp. Do not release a membership row.

Use hibernatable WebSocket attachments containing only `userId` and `displayName`.

- [ ] **Step 7: Replace the alarm handler**

At alarm time:

- Force-fold a connected current actor whose 60-second deadline elapsed.
- Force-fold and clear seats whose 30-second disconnect grace elapsed.
- Delete room storage when the five-minute empty deadline elapsed and the room still has no seat or socket.
- Persist and broadcast once after all due mutations.
- Schedule the next deadline.

No alarm branch performs network I/O.

- [ ] **Step 8: Handle corrupt state by resetting**

Wrap persisted-state restoration in schema/shape validation. On failure, delete the persisted key, clear in-memory state, and return room-not-found until recreated. Do not preserve old room shapes.

Add a test with malformed persisted data and assert storage deletion.

- [ ] **Step 9: Rename class, binding, and Worker export**

Update `src/worker.ts` to import and return `MultiplayerPokerRoom`.

Update `src/env.d.ts`:

```ts
MULTIPLAYER_POKER_ROOMS: DurableObjectNamespace;
```

Remove `arcturus` and `MP_AUTH_SECRET`.

Update `wrangler.toml`:

```toml
[[durable_objects.bindings]]
name = "MULTIPLAYER_POKER_ROOMS"
class_name = "MultiplayerPokerRoom"

[[migrations]]
tag = "v2"
deleted_classes = ["Arcturus"]
new_sqlite_classes = ["MultiplayerPokerRoom"]
```

Keep the existing v1 migration entry; append v2.

- [ ] **Step 10: Export the object from the module**

Add to `index.ts`:

```ts
export { MultiplayerPokerRoom } from './durable-object';
export type { RoomMetadata } from './durable-object';
```

- [ ] **Step 11: Run module tests and build**

```bash
bun test src/modules/multiplayer-poker
bun run build
! git grep -E '\bArcturus\b|pendingLockReleases|pendingEscrowReleases|SETTLEMENT_FAILED' -- src wrangler.toml
```

Expected: tests PASS, build exits 0, and obsolete object/retry symbols are absent.

- [ ] **Step 12: Commit**

```bash
git add -A src/modules/multiplayer-poker src/worker.ts src/env.d.ts wrangler.toml src/server/mp
git commit -m 'refactor(mp): replace wallet-coupled room object'
```

---

### Task 4: Collapse multiplayer routes and update the room UI

**Files:**

- Modify: `src/pages/api/mp/rooms/index.ts`
- Modify: `src/pages/api/mp/rooms/[code].ts`
- Modify: `src/pages/api/mp/rooms/[code]/ws.ts`
- Modify: `src/server/mp/rooms-api.test.ts`
- Modify: `src/server/mp/ws-route-logic.test.ts`
- Modify: `src/pages/games/poker-mp/index.astro`
- Modify: `src/pages/games/poker-mp/[code].astro`

**Interfaces:**

- Consumes: public helpers and `MULTIPLAYER_POKER_ROOMS` from Tasks 2–3.
- Produces: thin create, metadata, and upgrade routes with no D1 dependency; UI shows room-local stacks.

- [ ] **Step 1: Rewrite create-route tests without D1 or Ranked fixtures**

Delete Miniflare D1 setup and membership assertions. Keep exact cases:

- unauthenticated → 401;
- malformed JSON → 400 `INVALID_JSON`;
- invalid seats or blinds → 400 `INVALID_CONFIG`;
- missing binding → 503 `DO_UNAVAILABLE`;
- successful init → 201 with `MP-XXXXXX`;
- collision then success → 201;
- five collisions → 500 `CODE_GENERATION_FAILED`;
- object fetch throw → 502 `DO_UNAVAILABLE`.

The locals fixture contains only `user` and `runtime.env.MULTIPLAYER_POKER_ROOMS`.

- [ ] **Step 2: Run create-route tests and confirm old dependencies fail**

```bash
bun test src/server/mp/rooms-api.test.ts
```

Expected: FAIL because the route still creates D1 and membership dependencies.

- [ ] **Step 3: Simplify `POST /api/mp/rooms`**

Implement authentication, parse/validate, binding check, code generation, and up to five `/init` attempts. Forward object errors without creating or cleaning any D1 row.

Use:

```ts
const namespace = locals.runtime.env.MULTIPLAYER_POKER_ROOMS;
const stub = namespace.get(namespace.idFromName(code));
```

- [ ] **Step 4: Rewrite WebSocket-route tests around adapter responsibilities**

Remove Ranked, membership, escrow, and cleanup scenarios. Cover invalid code, unauthenticated, cross-origin, malformed origin, non-upgrade, missing binding, object throw, object status forwarding, trusted `x-arcturus-user-id`/display-name replacement, and successful 101 forwarding.

- [ ] **Step 5: Simplify metadata and WebSocket routes**

Metadata performs auth, code validation, binding lookup, and `/metadata` forwarding.

WebSocket performs auth, code/origin/upgrade validation, strips incoming `x-arcturus-*` headers, injects trusted identity headers, and forwards to `/ws`. It never opens D1.

- [ ] **Step 6: Run route tests**

```bash
bun test src/server/mp/rooms-api.test.ts src/server/mp/ws-route-logic.test.ts
```

Expected: PASS with no D1 fixture setup in either file.

- [ ] **Step 7: Update the room page for local stacks and reduced messages**

Import `MultiplayerPokerClient` from `../../../modules/multiplayer-poker`.

Render each seat as:

```ts
div.textContent = `Seat ${s.seatIndex}: ${s.displayName ?? '(empty)'} — ${s.chips} chips — ${s.committed} committed`;
```

Handle only `room_state`, `hand_started`, `hand_ended`, and `error`. Preserve existing action buttons and test IDs. Remove assumptions about settlement completion; the first post-result room state already contains awarded stacks and pot zero.

- [ ] **Step 8: Update the lobby import and copy**

Keep the current create/join form and URLs. Make copy clear that chips are room-local and do not affect the account balance.

- [ ] **Step 9: Run focused route and page checks**

```bash
bun test src/server/mp/rooms-api.test.ts src/server/mp/ws-route-logic.test.ts
bun run build
! git grep -E 'mpMembership|reconcileMultiplayerMembership|hasActiveRankedSession|heldChips' -- src/pages/api/mp/rooms src/pages/games/poker-mp
```

- [ ] **Step 10: Commit**

```bash
git add -A src/pages/api/mp/rooms src/pages/games/poker-mp src/server/mp/rooms-api.test.ts src/server/mp/ws-route-logic.test.ts
git commit -m 'refactor(mp): make room routes thin adapters'
```

---

### Task 5: Remove Ranked Blackjack's multiplayer exclusion

**Files:**

- Modify: `src/server/ranked/coordinator.ts`
- Modify: `src/server/ranked/coordinator.test.ts`
- Modify: `src/server/ranked/http.ts`
- Modify: `src/server/ranked/http.test.ts`
- Modify: `src/server/ranked/expiration.ts`
- Modify: `src/server/ranked/expiration.test.ts`
- Modify: `src/server/ranked/repository.ts`
- Modify: `src/server/ranked/repository.integration.test.ts`
- Modify: `src/server/ranked/test-d1.ts`
- Modify: `src/lib/ranked/protocol.ts`
- Modify: `src/lib/ranked/protocol.test.ts`
- Modify: `src/worker.ts`
- Modify: `src/server/cleanup.ts` scheduled dependency type only
- Modify: `src/server/cleanup.test.ts` scheduled dependency stubs only

**Interfaces:**

- Consumes: existing Ranked repository and adapter only.
- Produces: a Ranked coordinator with no `reconcileMembership`, `membershipDb`, or `membershipNamespace` dependency.

- [ ] **Step 1: Replace membership-conflict tests with an overlap-allowed construction test**

Delete tests expecting `MULTIPLAYER_CONFLICT` or `MULTIPLAYER_ESCROW_ORPHANED`.

Add:

```ts
test('starts without a multiplayer membership dependency', async () => {
	const coordinator = createRankedCoordinator({
		repository,
		getAdapter,
		now: () => new Date('2026-08-05T12:00:00Z'),
		randomBytes: deterministicRandomBytes,
	});
	const response = await coordinator.start({
		userId: 'u1',
		body: {
			requestId: 'request-00000001',
			gameType: 'blackjack',
			rulesetVersion: 'blackjack-ranked-v1',
			wager: 100,
		},
	});
	expect(response.status).toBe('active');
});
```

The assertion is that construction and start require no multiplayer dependency.

- [ ] **Step 2: Run coordinator tests and verify dependency removal fails**

```bash
bun test src/server/ranked/coordinator.test.ts
```

Expected: FAIL because `RankedCoordinatorDeps` still requires membership fields.

- [ ] **Step 3: Remove membership types and checks from the coordinator**

Use:

```ts
export interface RankedCoordinatorDeps {
	repository: RankedRepository;
	getAdapter: typeof getRankedAdapter;
	now: () => Date;
	randomBytes: (length: number) => Uint8Array;
	log?: (entry: RankedLogEntry) => void;
}
```

Delete `MembershipResolution`, classification/resolution helpers, and every membership call from start, resume, act, and expire.

- [ ] **Step 4: Simplify Ranked HTTP construction**

Change bindings to:

```ts
export interface RankedHttpCoordinatorBindings {
	db: D1Database;
}
```

`coordinatorFor` passes only `{ db }`. Remove the membership import and object namespace from production construction and HTTP tests.

- [ ] **Step 5: Remove membership handling from expiration and the Worker**

Change scheduled Ranked expiration dependencies to receive only `(db, nowSeconds)`. Remove the object namespace argument from `ScheduledJobDeps.rankedExpiration`, `runScheduledJobs`, Worker construction, and cleanup tests.

- [ ] **Step 6: Remove Ranked protocol error codes**

Delete `MULTIPLAYER_CONFLICT` and `MULTIPLAYER_ESCROW_ORPHANED` from `RANKED_ERROR_STATUS`, types, tests, logging assertions, and response fixtures.

- [ ] **Step 7: Remove `heldChips` predicates from Ranked repository SQL**

Where Ranked account settlement/start currently requires `heldChips = 0`, retain only the relevant account balance and active-session conditions. Update `test-d1.ts` schemas and repository integration expectations.

- [ ] **Step 8: Run Ranked and scheduled-job tests**

```bash
bun test \
	src/server/ranked/coordinator.test.ts \
	src/server/ranked/http.test.ts \
	src/server/ranked/expiration.test.ts \
	src/server/ranked/repository.integration.test.ts \
	src/lib/ranked/protocol.test.ts \
	src/server/cleanup.test.ts
! git grep -E 'reconcileMultiplayerMembership|MULTIPLAYER_CONFLICT|MULTIPLAYER_ESCROW_ORPHANED|membershipNamespace|membershipDb' -- src/server/ranked src/lib/ranked src/worker.ts
```

Expected: tests PASS and the absence check succeeds.

- [ ] **Step 9: Commit**

```bash
git add -A src/server/ranked src/lib/ranked src/worker.ts src/server/cleanup.ts src/server/cleanup.test.ts
git commit -m 'refactor(ranked): remove multiplayer exclusion'
```

---

### Task 6: Delete the persistent multiplayer economy and wallet guards

**Files:**

- Delete: `src/server/mp/membership.ts`
- Delete: `src/server/mp/membership.test.ts`
- Delete: `src/server/mp/settlement.ts`
- Delete: `src/server/mp/settlement.test.ts`
- Delete: `src/server/mp/lock.test.ts`
- Delete: `src/server/mp/snapshot-api.test.ts`
- Delete: `src/server/mp/settle-api.test.ts`
- Delete: `src/server/mp/release-escrow.test.ts`
- Delete: `src/pages/api/mp/lock.ts`
- Delete: `src/pages/api/mp/snapshot.ts`
- Delete: `src/pages/api/mp/settle.ts`
- Delete: `src/pages/api/mp/release-escrow.ts`
- Modify: `src/db/schema.ts`
- Delete: `drizzle/0008_last_living_lightning.sql`
- Delete: `drizzle/0008_mp_membership.sql`
- Modify: `src/pages/api/chips/update.ts`
- Modify: `src/lib/chips-update-api.test.ts`
- Modify: `src/pages/api/roulette/spin.ts`
- Modify: `src/lib/roulette/spin-batch-sql.ts`
- Modify: `src/lib/roulette/spin-api.test.ts`
- Modify: `src/lib/roulette/spin-cascade.integration.test.ts`

**Interfaces:**

- Consumes: isolated multiplayer from Tasks 1–4 and Ranked decoupling from Task 5.
- Produces: D1 schema and single-player wallet paths with no multiplayer escrow concept.

- [ ] **Step 1: Delete obsolete multiplayer economy code and tests**

```bash
git rm \
	src/server/mp/membership.ts \
	src/server/mp/membership.test.ts \
	src/server/mp/settlement.ts \
	src/server/mp/settlement.test.ts \
	src/server/mp/lock.test.ts \
	src/server/mp/snapshot-api.test.ts \
	src/server/mp/settle-api.test.ts \
	src/server/mp/release-escrow.test.ts \
	src/pages/api/mp/lock.ts \
	src/pages/api/mp/snapshot.ts \
	src/pages/api/mp/settle.ts \
	src/pages/api/mp/release-escrow.ts
```

- [ ] **Step 2: Remove schema fields and obsolete migration files**

Delete `heldChips` from `user` and delete the entire `mpMembership` table declaration.

```bash
git rm drizzle/0008_last_living_lightning.sql drizzle/0008_mp_membership.sql
```

Do not generate a migration that preserves or copies these values.

- [ ] **Step 3: Update chip-update tests before implementation**

Change fixtures and selected account rows to use only `chipBalance`. Add an assertion that chip updates do not reference an escrow column by making the test schema omit `heldChips`.

Run:

```bash
bun test src/lib/chips-update-api.test.ts
```

Expected initially: FAIL because production still selects `user.heldChips`.

- [ ] **Step 4: Remove escrow guards from `chips/update.ts`**

Select only `chipBalance`. Delete normalization of `heldChips`, multiplayer-lock rejection, and related error responses. Preserve current authentication, limits, optimistic balance check, receipts, statistics, achievements, and mission behavior for supported single-player game types.

- [ ] **Step 5: Remove escrow guards from roulette**

Delete `heldChips = 0` conditions and bindings from roulette spin SQL. Update shared batch SQL, tests, and Miniflare schemas to omit the column while preserving atomic roulette settlement.

- [ ] **Step 6: Recreate local D1 from the remaining migrations**

Because a reset is approved, remove local D1 state rather than applying a compatibility migration. Use the repository's Wrangler state location, then run:

```bash
bun run db:migrate:local
wrangler d1 execute arcturus --local --command="PRAGMA table_info('user')"
wrangler d1 execute arcturus --local --command="SELECT name FROM sqlite_master WHERE type='table' AND name='mp_membership'"
```

Expected: the user table has no `heldChips` column and the membership query returns zero rows.

- [ ] **Step 7: Run wallet and roulette tests**

```bash
bun test \
	src/lib/chips-update-api.test.ts \
	src/lib/roulette/spin-api.test.ts \
	src/lib/roulette/spin-cascade.integration.test.ts
! git grep -E 'heldChips|mp_membership|mpMembership|MP_AUTH_SECRET' -- src drizzle
```

At this point the grep may still find configuration/documentation references scheduled for Task 7; it must find no runtime or schema reference. Record any remaining paths and remove them in Task 7.

- [ ] **Step 8: Commit**

```bash
git add -A src drizzle
git commit -m 'refactor(mp): delete persistent room economy'
```

---

### Task 7: Remove multiplayer progression, cleanup exceptions, and obsolete product surface

**Files:**

- Modify: `src/lib/missions/types.ts`
- Modify: `src/lib/missions/registry.ts`
- Modify: `src/lib/missions/progress.ts`
- Modify: `src/lib/missions/progress.test.ts`
- Modify: `src/lib/missions/progress-mock.test.ts`
- Modify: `src/server/cleanup.ts`
- Modify: `src/server/cleanup.test.ts`
- Modify: `src/env.d.ts`
- Modify: `wrangler.toml`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `src/pages/profile.astro`
- Delete: `docs/leaderboard-future-improvements.md`
- Review and update any current docs that claim multiplayer settlement, membership, tournaments, or friend rewards

**Interfaces:**

- Consumes: local-only multiplayer and schema deletion from prior tasks.
- Produces: no progression or cleanup sink for multiplayer; documentation reflects actual product scope.

- [ ] **Step 1: Remove the multiplayer mission metric and definitions**

Delete `mpHandsCompleted` from the mission metric union, remove its registry entries, and remove `poker_mp` special cases from `computeIncrement`.

Delete tests asserting multiplayer completion, multiplayer wins, or multiplayer game-mode progression. Keep ordinary single-player mission tests unchanged.

- [ ] **Step 2: Run mission tests**

```bash
bun test src/lib/missions/progress.test.ts src/lib/missions/progress-mock.test.ts
```

Expected: PASS with no `poker_mp` or `mpHandsCompleted` reference.

- [ ] **Step 3: Remove the receipt-retention exception**

Change the 30-day `chip_sync_receipt` cleanup so it no longer excludes `poker_mp`; retain the separate roulette tombstone policy. Remove multiplayer-specific comments and cleanup-test fixtures.

Run:

```bash
bun test src/server/cleanup.test.ts
```

Expected: PASS.

- [ ] **Step 4: Remove secret and old binding documentation**

Delete `MP_AUTH_SECRET`, `arcturus` binding instructions, and internal callback descriptions from `src/env.d.ts`, `wrangler.toml` comments, `README.md`, and `CLAUDE.md`.

Document:

```text
src/modules/multiplayer-poker/
MultiplayerPokerRoom
MULTIPLAYER_POKER_ROOMS
room-local chips; no D1 settlement
```

- [ ] **Step 5: Replace speculative profile copy**

Replace tournament and friend-reward tips with current features. Use copy equivalent to:

```text
Try a different single-player table to explore another strategy.
Create a private poker room and share its code for a casual match.
```

Do not add a social roadmap section.

- [ ] **Step 6: Delete the obsolete future-improvements document**

```bash
git rm docs/leaderboard-future-improvements.md
```

Do not replace it with another speculative PRD.

- [ ] **Step 7: Run global absence checks**

```bash
! git grep -E 'heldChips|mp_membership|mpMembership|MP_AUTH_SECRET|poker_mp|mpHandsCompleted|MULTIPLAYER_CONFLICT|MULTIPLAYER_ESCROW_ORPHANED' -- . 
! git grep -E 'tournaments page|Invite friends for exclusive' -- src/pages/profile.astro
```

The first command may match historical design documents under `docs/superpowers`; restrict a second verification to runtime/config paths if historical docs are intentionally retained:

```bash
! git grep -E 'heldChips|mp_membership|mpMembership|MP_AUTH_SECRET|poker_mp|mpHandsCompleted' -- src drizzle wrangler.toml README.md CLAUDE.md
```

- [ ] **Step 8: Run formatting, lint, and build**

```bash
bun run format
bun run lint
bun run build
```

Expected: all commands exit 0.

- [ ] **Step 9: Commit**

```bash
git add -A src README.md CLAUDE.md wrangler.toml docs
git commit -m 'chore(mp): remove obsolete multiplayer surface'
```

---

### Task 8: Replace multiplayer E2E coverage and run full verification

**Files:**

- Rewrite: `e2e/multiplayer-poker.spec.ts`
- Modify only when required by the new binding: `playwright.config.mp.ts`
- Modify only if the existing command changes: `package.json`

**Interfaces:**

- Consumes: final public room flow from Tasks 1–7.
- Produces: one representative two-user happy-path test and release evidence.

- [ ] **Step 1: Delete settlement and membership E2E helpers**

Remove `waitForSettlement`, lock-release navigation delays, membership comments, the 30-second disconnect test, and serial reuse workarounds that existed only for D1 locks.

- [ ] **Step 2: Add local-stack test IDs only where necessary**

Reuse current seat, pot, connection, action, and log test IDs. Add `data-testid="seat-stack-{index}"` only if parsing the current seat text would make assertions brittle. Do not redesign the page.

- [ ] **Step 3: Write the single happy-path E2E**

The test must:

1. Open two authenticated browser contexts.
2. Have A create a two-seat 5/10 room.
3. Have A and B connect and take seats.
4. Assert both start with 1,000 local chips.
5. Start the hand from a connected seated player.
6. Read `currentSeat` from rendered state or choose the visible legal actor.
7. Fold the current actor.
8. Assert both clients receive `Hand ended`.
9. Assert pot becomes zero without waiting for an external settlement.
10. Assert winner stack is above its post-blind value and loser stack is below 1,000.
11. Assert no account-balance UI change is required.

- [ ] **Step 4: Run the E2E against the Durable Object server**

```bash
bun run db:migrate:local
bun run test:e2e:mp
```

Expected: one multiplayer test passes without a real-time 30-second wait.

- [ ] **Step 5: Run every focused suite**

```bash
bun test src/modules/multiplayer-poker
bun test src/server/mp/rooms-api.test.ts src/server/mp/ws-route-logic.test.ts
bun test src/server/ranked
bun test src/lib/ranked
bun test src/lib/missions
bun test src/server/cleanup.test.ts
bun test src/lib/chips-update-api.test.ts src/lib/roulette
```

Expected: all commands exit 0.

- [ ] **Step 6: Run repository-wide verification**

```bash
bun run test
bun run lint
bun run format:check
bun run build
bun run db:migrate:local
bun run test:e2e:mp
```

Record the exact pass/fail output in the PR description. Do not claim completion from focused tests alone.

- [ ] **Step 7: Inspect the final diff for accidental architecture residue**

```bash
git diff --stat main...HEAD
git diff --check main...HEAD
! git grep -E 'heldChips|mp_membership|mpMembership|MP_AUTH_SECRET|pendingLockReleases|pendingEscrowReleases|SETTLEMENT_FAILED|MULTIPLAYER_CONFLICT|MULTIPLAYER_ESCROW_ORPHANED' -- src drizzle wrangler.toml
```

Confirm:

- no old `src/lib/mp-poker` or `src/server/mp/arcturus.ts` file remains;
- no new generic realtime abstraction was introduced;
- route and page URLs stayed unchanged;
- the only multiplayer persistence is Durable Object room state;
- the test suite is materially smaller in recovery and settlement coverage.

- [ ] **Step 8: Commit the E2E and final verification adjustments**

```bash
git add -A e2e playwright.config.mp.ts package.json
git commit -m 'test(mp): cover isolated private-room happy path'
```

- [ ] **Step 9: Prepare the implementation PR description**

Include:

```markdown
## Summary
- Replace multiplayer wallet escrow with 100-BB room-local stacks.
- Move private-room poker into `src/modules/multiplayer-poker`.
- Delete membership, settlement callbacks, Ranked exclusion, and recovery machinery.
- Replace the old Durable Object namespace; old room state is intentionally invalidated.
- Reset D1 rather than migrate held chips or memberships.

## Verification
- `bun run test`
- `bun run lint`
- `bun run format:check`
- `bun run build`
- `bun run db:migrate:local`
- `bun run test:e2e:mp`

## Breaking reset
This hobby-stage change discards existing account/game data and all old multiplayer rooms. No compatibility or data migration is provided.
```

---

## Plan self-review checklist

Before execution begins, verify:

- Every HPA-542 acceptance criterion maps to at least one task.
- The room engine has no wallet snapshots or settlement phases.
- Protocol messages have a current producer and consumer.
- The object has only turn, reconnect, and empty-room deadlines.
- Ranked construction no longer receives multiplayer dependencies.
- D1 reset is explicit and no migration copies old values.
- Missions, statistics, achievements, and cleanup have no multiplayer sink.
- The E2E covers the retained normal journey only.
- No task introduces a generic framework or compatibility layer.
