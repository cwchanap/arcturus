# Isolated Private-Room Poker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep private-room Texas Hold'em playable while replacing persistent wallet escrow and cross-system recovery with room-local stacks in the repository's existing multiplayer folders.

**Architecture:** Rewrite `src/lib/mp-poker/engine.ts` and the existing Durable Object behavior in place first so every intermediate commit builds. Then remove Ranked and route membership coupling, delete the persistent multiplayer economy and all `heldChips` fixtures, reduce the protocol/UI, and rename the Durable Object class/binding last. Pure poker logic remains under `src/lib/mp-poker`; Worker-only room runtime remains under `src/server/mp`.

**Tech Stack:** Astro 5 SSR, Cloudflare Workers, Cloudflare Durable Objects with hibernatable WebSockets, TypeScript, Zod 4, Bun, Miniflare/Vitest where already used, Playwright, Drizzle ORM, Cloudflare D1, Wrangler 4.

## Global Constraints

- Starting stack is exactly `bigBlind * 100`.
- Room phases are exactly `waiting` and `in-hand`.
- Turn timeout is exactly 60 seconds.
- Reconnect grace is exactly 30 seconds.
- Empty-room cleanup is exactly five minutes.
- Any connected eligible seated player may start; there is no host role.
- Multiplayer must not read or write D1, `user.chipBalance`, missions, achievements, statistics, leaderboards, or Ranked Blackjack state.
- Keep `src/lib/mp-poker` for pure/browser code and `src/server/mp` for Worker-only room code.
- Keep camelCase TypeScript filenames such as `roomCode.ts`.
- Keep the existing `/games/poker-mp` and `/api/mp/rooms` URLs.
- No backward-compatibility layer, dual path, old-state parser, or data migration.
- New Durable Object namespace uses `new_sqlite_classes`; SQLite-backed objects may still use `storage.get/put`.
- Do not introduce a generic realtime framework, Durable Object base class, repository, event bus, barrel package, or configurable stack policy.
- Preserve existing poker legality, shuffle, side-pot, showdown, and odd-chip behavior unless a local-stack regression test requires a targeted correction.
- Every commit below must pass its listed focused tests and `bun run build` before continuing.

---

## Preflight: authoritative blast-radius audit

Before Task 1, run:

```bash
git grep -nE \
	'heldChips|mp_membership|mpMembership|MP_AUTH_SECRET|reconcileMultiplayer|poker_mp|mpHandsCompleted|pendingEscrow|pendingLock|SETTLEMENT_FAILED' \
	-- src e2e scripts drizzle wrangler.toml README.md CLAUDE.md AGENTS.md \
	| tee /tmp/hpa-542-coupling.txt
```

Classify every line in `/tmp/hpa-542-coupling.txt` as:

```text
DELETE
EDIT
HISTORICAL_DOC_ONLY
```

The known runtime/test paths in Tasks 3–6 are a starting list. The fresh grep output is authoritative; do not finish Task 6 while an unclassified runtime/test match remains.

---

## Final file shape

| Action | Path | Responsibility |
|---|---|---|
| Modify in place | `src/lib/mp-poker/engine.ts` | Pure room-local state and poker transitions |
| Modify in place | `src/lib/mp-poker/engine.test.ts` | Local-stack, legality, pot, payout, and disconnect tests |
| Modify in place | `src/lib/mp-poker/protocol.ts` | Minimal current WebSocket protocol |
| Modify in place | `src/lib/mp-poker/protocol.test.ts` | Retained/removed protocol coverage |
| Modify in place | `src/lib/mp-poker/client.ts` | Browser WebSocket wrapper |
| Modify in place | `src/lib/mp-poker/client.test.ts` | Client connection and parsing tests |
| Keep | `src/lib/mp-poker/roomCode.ts` | Room-code generation and validation |
| Rename last | `src/server/mp/arcturus.ts` → `src/server/mp/multiplayer-poker-room.ts` | Durable Object runtime |
| Replace tests | `src/server/mp/multiplayer-poker-room.test.ts` | Projection, reconnect, alarm, and persistence behavior |
| Modify | `src/pages/api/mp/rooms/index.ts` | Thin create-room adapter |
| Modify | `src/pages/api/mp/rooms/[code].ts` | Thin metadata adapter |
| Modify | `src/pages/api/mp/rooms/[code]/ws.ts` | Thin authenticated WebSocket adapter |
| Modify | `src/pages/games/poker-mp/[code].astro` | Room-local stack UI and current-seat projection |
| Delete | `src/server/mp/membership.ts` and test | Persistent membership/reconciliation |
| Delete | `src/server/mp/settlement.ts` and test | Persistent settlement payload |
| Delete | `src/lib/mp-poker/roomExists.ts` and test | D1 membership repair probe |
| Delete | `src/pages/api/mp/{lock,snapshot,settle,release-escrow}.ts` | Internal economy callbacks |
| Delete | callback/escrow/recovery tests under `src/server/mp/` | Obsolete hardening coverage |
| Modify | Ranked, wallet, roulette, missions, cleanup, schema, fixtures, docs | Remove cross-system multiplayer concepts |
| Modify | `e2e/multiplayer-poker.spec.ts` | One fast two-user happy path |

Design reference: `docs/superpowers/specs/2026-08-05-isolated-multiplayer-poker-design.md`.

---

### Task 1: Convert the engine and Durable Object behavior to local stacks in place

**Files:**

- Modify: `src/lib/mp-poker/engine.ts`
- Modify: `src/lib/mp-poker/engine.test.ts`
- Modify: `src/server/mp/arcturus.ts`
- Delete: `src/server/mp/reconnect-guard.test.ts`
- Delete: `src/server/mp/turn-timeout.test.ts`
- Create: `src/server/mp/arcturus.test.ts`

**Interfaces:**

- Produces:

```ts
export interface RoomConfig {
	maxSeats: 2 | 4 | 6;
	smallBlind: number;
	bigBlind: number;
}

export interface SeatState {
	seatIndex: number;
	userId: string | null;
	displayName: string | null;
	chips: number;
	connected: boolean;
	disconnectedAt: number | null;
}

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

export function createRoom(config: RoomConfig): Room;
export function takeSeat(
	room: Room,
	args: { userId: string; displayName: string; seatIndex: number },
): Room;
export function leaveSeat(room: Room, userId: string): Room;
export function startHand(room: Room, args: { deckSeed: string }): Room;
export function applyAction(room: Room, userId: string, action: ActionInput): RoomTransition;
export function forceFold(room: Room, userId: string): RoomTransition;
export function clearDisconnectedSeat(room: Room, userId: string): Room;
```

- The Durable Object remains `class Arcturus` with binding `env.arcturus` throughout this task.
- No route or Ranked binding rename happens here.

- [ ] **Step 1: Add failing local-stack tests without moving files**

Replace wallet-oriented setup in `engine.test.ts` with:

```ts
function createHeadsUpRoom() {
	let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10 });
	room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0 });
	room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1 });
	return room;
}

test('taking a seat grants 100 big blinds', () => {
	const room = takeSeat(
		createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10 }),
		{ userId: 'u1', displayName: 'Alice', seatIndex: 0 },
	);
	expect(room.seats[0].chips).toBe(1_000);
});

test('fold-out pays locally and returns to waiting', () => {
	const room = startHand(createHeadsUpRoom(), { deckSeed: 'fold-out' });
	const transition = applyAction(room, 'u1', { action: 'fold' });
	expect(transition.room.phase).toBe('waiting');
	expect(transition.room.hand).toBeNull();
	expect(transition.handResult).toEqual({
		winners: [{ userId: 'u2', seatIndex: 1, amount: 15 }],
	});
	expect(transition.room.seats[0].chips).toBe(995);
	expect(transition.room.seats[1].chips).toBe(1_005);
});
```

Add the disconnect payout contract:

```ts
test('force-fold pays the remaining user before an expired seat is cleared', () => {
	let room = startHand(createHeadsUpRoom(), { deckSeed: 'disconnect-fold' });
	room = {
		...room,
		seats: room.seats.map((seat) =>
			seat.userId === 'u1'
				? { ...seat, connected: false, disconnectedAt: 1_000 }
				: seat,
		),
	};
	const transition = forceFold(room, 'u1');
	expect(transition.handResult?.winners).toEqual([
		{ userId: 'u2', seatIndex: 1, amount: 15 },
	]);
	const cleared = clearDisconnectedSeat(transition.room, 'u1');
	expect(cleared.seats[0].userId).toBeNull();
	expect(cleared.seats[1].chips).toBe(1_005);
});
```

Add an identity guard:

```ts
test('never credits a replacement occupant for an old hand winner', () => {
	const room = startHand(createHeadsUpRoom(), { deckSeed: 'identity-guard' });
	const replaced = {
		...room,
		seats: room.seats.map((seat) =>
			seat.seatIndex === 1
				? { ...seat, userId: 'replacement', displayName: 'Replacement' }
				: seat,
		),
	};
	const transition = applyAction(replaced, 'u1', { action: 'fold' });
	expect(transition.room.seats[1].chips).toBe(990);
});
```

Retain/adapt existing tests for legal actions, streets, side pots, short all-ins, ties, odd chips, and runout.

- [ ] **Step 2: Run the engine suite and verify the contract fails**

```bash
bun test src/lib/mp-poker/engine.test.ts
```

Expected: FAIL because the old API requires `hostUserId`, `mainBalance`, and snapshots, and completed hands enter `settling`.

- [ ] **Step 3: Replace wallet-oriented room types**

Use:

```ts
export interface Room {
	config: RoomConfig;
	phase: 'waiting' | 'in-hand';
	seats: SeatState[];
	hand: HandState | null;
	lastDealerSeat: number;
}
```

Delete from the engine:

```text
hostUserId
mainBalance
handStacks
handLog
settling
frozen
```

`createRoom` accepts only 2/4/6 seats, positive safe-integer blinds, `bigBlind >= smallBlind * 2`, and a safe-integer `bigBlind * 100`.

- [ ] **Step 4: Implement local debit and hand start**

`takeSeat` assigns:

```ts
chips: room.config.bigBlind * 100
```

`startHand` selects only occupied connected seats with `chips >= bigBlind`. It posts blinds by subtracting from `SeatState.chips` and adding to `hand.committed`.

Action affordability uses the current seat stack:

```ts
const seatIndex = room.seats.findIndex((seat) => seat.userId === userId);
if (seatIndex < 0) throw new EngineError('INVALID_ACTION', 'player is not seated');
const remaining = room.seats[seatIndex].chips;
const committedNow = hand.committed[userId] ?? 0;
const toCall = hand.currentBet - committedNow;
```

Call/bet/raise/all-in update the seat and committed map in one immutable transition.

- [ ] **Step 5: Make winner discovery independent of live seats**

For fold-out:

```ts
const remainingUserIds = Object.keys(hand.holeCards).filter(
	(userId) => !hand.folded.has(userId),
);
if (remainingUserIds.length !== 1) {
	throw new EngineError('INVALID_ACTION', 'fold-out requires one remaining player');
}
const winnerUserId = remainingUserIds[0];
const winnerSeatIndex = hand.seatIndexMap[winnerUserId];
```

For showdown, construct eligible players from `hand.holeCards` and `hand.seatIndexMap`, not `room.seats[seatIndex].userId`.

Keep `buildSidePots` engine-local and remove its unused live-seat argument.

- [ ] **Step 6: Apply payout with identity matching**

Use:

```ts
function completeHand(room: Room, winners: HandWinner[]): RoomTransition {
	const awardByUserId = new Map(winners.map((winner) => [winner.userId, winner]));
	const seats = room.seats.map((seat) => {
		if (!seat.userId) return seat;
		const winner = awardByUserId.get(seat.userId);
		if (!winner || winner.seatIndex !== seat.seatIndex) return seat;
		return { ...seat, chips: seat.chips + winner.amount };
	});
	return {
		room: { ...room, phase: 'waiting', seats, hand: null },
		handResult: { winners },
	};
}
```

`applyAction` and `forceFold` return `RoomTransition`.

- [ ] **Step 7: Implement explicit disconnect cleanup**

Use:

```ts
export function clearDisconnectedSeat(room: Room, userId: string): Room {
	const protectedByActiveHand =
		room.hand !== null &&
		room.hand.holeCards[userId] !== undefined &&
		!room.hand.folded.has(userId);
	if (protectedByActiveHand) return room;
	return {
		...room,
		seats: room.seats.map((seat) =>
			seat.userId === userId
				? {
						seatIndex: seat.seatIndex,
						userId: null,
						displayName: null,
						chips: 0,
						connected: false,
						disconnectedAt: null,
					}
				: seat,
		),
	};
}
```

The Durable Object must call `forceFold` before this helper. If the fold returns a result, payout has already occurred. Expired all-in/non-folded seats remain until hand completion.

- [ ] **Step 8: Rewrite the Durable Object in place**

Keep filename/class/binding unchanged. Remove from `arcturus.ts`:

```text
buildSettlePayload
fetchSnapshot
runSettlement
releaseEscrow
releaseMembership
doSecret
currentHandId
pendingLockReleases
pendingEscrowReleases
isStartingHand
settling/frozen recovery
host transfer
host-only start
```

Persist only:

```ts
interface PersistedState {
	room: PersistedRoom;
	roomCode: string;
	turnDeadline: number | null;
	emptyDeadline: number | null;
}
```

`start_hand` calls `startHand(this.room, { deckSeed: crypto.randomUUID() })` with no external fetch. Any connected eligible seated user may start.

For an action:

```ts
const transition = applyAction(this.room, identity.userId, parsed);
this.room = transition.room;
if (transition.handResult) this.broadcastHandEnded(transition.handResult);
for (const userId of expiredDisconnectedUserIds) {
	this.room = clearDisconnectedSeat(this.room, userId);
}
await this.persistAndBroadcast();
```

At disconnect expiry, fold first, then call `clearDisconnectedSeat` for each expired user.

- [ ] **Step 9: Replace detached timeout tests with runtime-helper tests**

Delete:

```bash
git rm src/server/mp/reconnect-guard.test.ts src/server/mp/turn-timeout.test.ts
```

Create `src/server/mp/arcturus.test.ts`. Export and test:

```ts
export const TURN_TIMEOUT_MS = 60_000;
export const RECONNECT_TIMEOUT_MS = 30_000;
export const EMPTY_ROOM_TIMEOUT_MS = 5 * 60_000;

export function getNextAlarmAt(
	room: Room,
	turnDeadline: number | null,
	emptyDeadline: number | null,
	now: number,
): number | null;
```

`getNextAlarmAt` must omit already-expired reconnect deadlines for users protected by an active hand, preventing immediate alarm loops.

Cover init state, persistence decode, reconnect within grace, expired fold/payout/clear ordering, all-in seat retention, turn timeout, empty deadline, and corrupt-state deletion using fakes/direct helpers.

- [ ] **Step 10: Run focused tests and build**

```bash
bun test src/lib/mp-poker/engine.test.ts src/server/mp/arcturus.test.ts
bun run build
```

Expected: PASS. Verify the active runtime no longer calls economy endpoints:

```bash
! git grep -E \
	'fetchSnapshot|runSettlement|releaseEscrow|releaseMembership|pendingEscrow|pendingLock|SETTLEMENT_FAILED' \
	-- src/server/mp/arcturus.ts src/lib/mp-poker/engine.ts
```

- [ ] **Step 11: Commit the buildable vertical slice**

```bash
git add src/lib/mp-poker/engine.ts src/lib/mp-poker/engine.test.ts \
	src/server/mp/arcturus.ts src/server/mp/arcturus.test.ts
git add -u src/server/mp
git commit -m 'refactor(mp): use room-local poker stacks'
```

---

### Task 2: Reduce the protocol and expose current actor through the existing UI

**Files:**

- Modify: `src/lib/mp-poker/protocol.ts`
- Modify: `src/lib/mp-poker/protocol.test.ts`
- Modify: `src/lib/mp-poker/client.ts`
- Modify: `src/lib/mp-poker/client.test.ts`
- Modify: `src/server/mp/arcturus.ts`
- Modify: `src/server/mp/arcturus.test.ts`
- Modify: `src/pages/games/poker-mp/[code].astro`

**Interfaces:**

- Produces only four client message types and four server message types.
- Produces:

```ts
export function toRoomStateMessage(room: Room): Extract<ServerMessage, { type: 'room_state' }>;
```

- [ ] **Step 1: Write protocol failures first**

Use:

```ts
test('accepts retained messages', () => {
	expect(ClientMessage.parse({ type: 'take_seat', seatIndex: 0 }).type).toBe('take_seat');
	expect(ClientMessage.parse({ type: 'leave_seat' }).type).toBe('leave_seat');
	expect(ClientMessage.parse({ type: 'start_hand' }).type).toBe('start_hand');
	expect(ClientMessage.parse({ type: 'action', action: 'fold' }).type).toBe('action');
});

test('rejects removed messages', () => {
	expect(() => ClientMessage.parse({ type: 'emote', emoteId: 'good_game' })).toThrow();
	expect(() => ServerMessage.parse({ type: 'state_delta', patch: {} })).toThrow();
	expect(() => ServerMessage.parse({ type: 'ping' })).toThrow();
});
```

A valid room state contains `phase`, public seats, `pot`, `board`, and `currentSeat`.

- [ ] **Step 2: Run and verify failure**

```bash
bun test src/lib/mp-poker/protocol.test.ts
```

Expected: FAIL because obsolete messages still parse.

- [ ] **Step 3: Implement the minimal schemas**

Client:

```text
take_seat
leave_seat
start_hand
action
```

Server:

```text
room_state
hand_started
hand_ended
error
```

Remove:

```text
PROTOCOL_VERSION
EMOTES
state_delta
kicked
hand_aborted
ping/pong
membership and settlement error codes
hand_ended.pots
hand_ended.showdownCards
room_state.betToCall
room_state.timeRemainingMs
```

Keep `room_state.currentSeat`.

- [ ] **Step 4: Centralize the public projection**

In `arcturus.ts`:

```ts
export function toRoomStateMessage(
	room: Room,
): Extract<ServerMessage, { type: 'room_state' }> {
	const hand = room.hand;
	return {
		type: 'room_state',
		phase: room.phase,
		seats: room.seats.map((seat) => ({
			seatIndex: seat.seatIndex,
			displayName: seat.displayName,
			chips: seat.chips,
			committed: seat.userId && hand ? (hand.committed[seat.userId] ?? 0) : 0,
			folded: Boolean(seat.userId && hand?.folded.has(seat.userId)),
			allIn: Boolean(seat.userId && hand?.allIn.has(seat.userId)),
			connected: seat.connected,
		})),
		pot: hand ? Object.values(hand.committed).reduce((sum, value) => sum + value, 0) : 0,
		board: hand?.board ?? [],
		currentSeat: hand?.currentSeat ?? null,
	};
}
```

Add a test asserting `userId`, deck, and private hole cards are absent.

- [ ] **Step 5: Update the page consumer**

Render:

```ts
div.textContent = s.displayName
	? `Seat ${s.seatIndex}: ${s.displayName} — ${s.chips} chips — ${s.committed} committed`
	: `Seat ${s.seatIndex}: (empty)`;
```

On every `room_state`:

```ts
root.dataset.currentSeat =
	msg.currentSeat === null ? '' : String(msg.currentSeat);
```

Keep handling only the four retained server messages.

- [ ] **Step 6: Keep client behavior narrow**

Retain successful connect, parsed delivery, malformed-message drop, send-only-while-open, disconnect callback, and superseded-socket behavior. Do not add reconnect/backoff.

- [ ] **Step 7: Run focused tests and build**

```bash
bun test src/lib/mp-poker/protocol.test.ts src/lib/mp-poker/client.test.ts \
	src/server/mp/arcturus.test.ts
bun run build
```

Verify removed symbols are absent from runtime:

```bash
! git grep -E \
	'PROTOCOL_VERSION|state_delta|emote_received|hand_aborted|type: .ping.|type: .pong.' \
	-- src/lib/mp-poker src/server/mp src/pages/games/poker-mp
```

- [ ] **Step 8: Commit**

```bash
git add src/lib/mp-poker src/server/mp/arcturus.ts src/server/mp/arcturus.test.ts \
	'src/pages/games/poker-mp/[code].astro'
git commit -m 'refactor(mp): reduce room protocol'
```

---

### Task 3: Remove Ranked Blackjack's multiplayer dependency

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
- Modify: `src/server/cleanup.ts`
- Modify: `src/server/cleanup.test.ts`

**Interfaces:**

```ts
export interface RankedCoordinatorDeps {
	repository: RankedRepository;
	getAdapter: typeof getRankedAdapter;
	now: () => Date;
	randomBytes: (length: number) => Uint8Array;
	log?: (entry: RankedLogEntry) => void;
}
```

- [ ] **Step 1: Replace conflict tests**

Delete tests expecting:

```text
MULTIPLAYER_CONFLICT
MULTIPLAYER_ESCROW_ORPHANED
```

Add a construction/start test that supplies no membership dependency and uses the exact current ranked request helper.

- [ ] **Step 2: Verify failure**

```bash
bun test src/server/ranked/coordinator.test.ts src/server/ranked/http.test.ts
```

Expected: FAIL because production types/factories still require membership fields.

- [ ] **Step 3: Remove coordinator membership logic**

Delete:

```text
MembershipResolution
reconcileMembership
membershipDb
membershipNamespace
classifyMembership
resolveMembership
reconcileCurrentActionMembership
```

Remove calls from start, resume, action, and expiration.

- [ ] **Step 4: Simplify HTTP and Worker construction**

`RankedHttpCoordinatorBindings` contains only `db`. Remove the membership import and namespace plumbing.

Change scheduled dependency:

```ts
rankedExpiration(db: D1Database, nowSeconds: number): Promise<void>;
```

Update `src/worker.ts` and cleanup tests to call the two-argument function.

- [ ] **Step 5: Remove Ranked protocol errors**

Delete both multiplayer errors from status maps, schemas, and tests.

- [ ] **Step 6: Remove Ranked `heldChips` guards**

Ranked account projections and guarded updates use only `chipBalance` and existing Ranked concurrency conditions.

Delete `heldChips` from Ranked test schemas and insert helpers.

- [ ] **Step 7: Run Ranked and scheduled tests**

```bash
bun test src/server/ranked src/lib/ranked src/server/cleanup.test.ts
bun run build
```

Verify:

```bash
! git grep -E \
	'reconcileMultiplayerMembership|MULTIPLAYER_CONFLICT|MULTIPLAYER_ESCROW_ORPHANED|membershipNamespace|membershipDb|heldChips' \
	-- src/server/ranked src/lib/ranked src/worker.ts
```

- [ ] **Step 8: Commit**

```bash
git add src/server/ranked src/lib/ranked src/worker.ts \
	src/server/cleanup.ts src/server/cleanup.test.ts
git commit -m 'refactor(ranked): remove multiplayer exclusion'
```

---

### Task 4: Thin room routes and delete persistent membership

**Files:**

- Modify: `src/pages/api/mp/rooms/index.ts`
- Modify: `src/pages/api/mp/rooms/[code].ts`
- Modify: `src/pages/api/mp/rooms/[code]/ws.ts`
- Rewrite: `src/server/mp/rooms-api.test.ts`
- Rewrite: `src/server/mp/ws-route-logic.test.ts`
- Delete: `src/server/mp/membership.ts`
- Delete: `src/server/mp/membership.test.ts`
- Delete: `src/pages/api/mp/lock.ts`
- Delete: `src/server/mp/lock.test.ts`
- Delete: `src/lib/mp-poker/roomExists.ts`
- Delete: `src/lib/mp-poker/roomExists.test.ts`

**Interfaces:**

- Binding remains `env.arcturus` in this task.
- Routes have no D1 dependency.

- [ ] **Step 1: Rewrite create-route tests with stubs**

Use:

```ts
function makeLocals(namespace?: DurableObjectNamespace) {
	return {
		user: { id: 'rooms-api-user', name: 'Room Creator' },
		runtime: { env: { arcturus: namespace } },
	};
}
```

Cover unauthorized, malformed JSON, invalid config, missing binding, init success, collision retry, exhausted collisions, non-409 object error, and thrown fetch.

- [ ] **Step 2: Verify failure**

```bash
bun test src/server/mp/rooms-api.test.ts
```

Expected: FAIL because the route still imports D1/membership/Ranked helpers.

- [ ] **Step 3: Replace create route**

Validate:

```ts
const valid =
	(body.maxSeats === 2 || body.maxSeats === 4 || body.maxSeats === 6) &&
	Number.isSafeInteger(body.smallBlind) &&
	Number.isSafeInteger(body.bigBlind) &&
	body.smallBlind > 0 &&
	body.bigBlind >= body.smallBlind * 2 &&
	Number.isSafeInteger(body.bigBlind * 100);
```

Generate/init up to five codes, retry only 409, and return 201 with the code. No database access.

- [ ] **Step 4: Rewrite WebSocket route tests**

Use stub namespace/forwarded headers. Cover invalid code, unauthorized, cross-origin, malformed origin, non-upgrade, missing binding, trusted identity forwarding, successful 101, non-101 forwarding, and thrown fetch.

- [ ] **Step 5: Replace WebSocket route**

Keep validation and trusted headers. Delete every D1/membership/escrow branch. Forward to `env.arcturus`.

- [ ] **Step 6: Keep metadata route thin**

Validate code/auth/binding and forward `/metadata`.

- [ ] **Step 7: Delete membership files**

```bash
git rm \
	src/server/mp/membership.ts \
	src/server/mp/membership.test.ts \
	src/pages/api/mp/lock.ts \
	src/server/mp/lock.test.ts \
	src/lib/mp-poker/roomExists.ts \
	src/lib/mp-poker/roomExists.test.ts
```

- [ ] **Step 8: Test and build**

```bash
bun test src/server/mp/rooms-api.test.ts src/server/mp/ws-route-logic.test.ts
bun run build
```

Verify:

```bash
! git grep -E \
	'createDb|mpMembership|reconcileMultiplayerMembership|hasActiveRankedSession|mp_membership' \
	-- src/pages/api/mp/rooms src/server/mp src/lib/mp-poker
```

- [ ] **Step 9: Commit**

```bash
git add src/pages/api/mp/rooms src/server/mp/rooms-api.test.ts \
	src/server/mp/ws-route-logic.test.ts
git add -u src/server/mp src/pages/api/mp src/lib/mp-poker
git commit -m 'refactor(mp): remove persistent room membership'
```

---

### Task 5: Delete multiplayer settlement and progression sinks

**Files:**

- Delete: `src/server/mp/settlement.ts`
- Delete: `src/server/mp/settlement.test.ts`
- Delete: `src/pages/api/mp/snapshot.ts`
- Delete: `src/pages/api/mp/settle.ts`
- Delete: `src/pages/api/mp/release-escrow.ts`
- Delete obsolete API/recovery tests:
  - `src/server/mp/snapshot-api.test.ts`
  - `src/server/mp/settle-api.test.ts`
  - `src/server/mp/release-escrow.test.ts`
  - any remaining escrow/settlement-only file from the preflight grep
- Modify: `src/lib/missions/types.ts`
- Modify: `src/lib/missions/registry.ts`
- Modify: `src/lib/missions/progress.ts`
- Modify mission tests, including:
  - `src/lib/missions/progress.test.ts`
  - `src/lib/missions/progress-mock.test.ts`
  - `src/lib/missions/progress-integration.test.ts`
- Modify: `src/server/cleanup.ts`
- Modify: `src/server/cleanup.test.ts`

**Interfaces:**

- No `poker_mp` event enters wallet receipts or mission progress.
- `chip_sync_receipt` cleanup retains only the roulette-specific extended tombstone policy.

- [ ] **Step 1: Delete callback and settlement files**

```bash
git rm \
	src/server/mp/settlement.ts \
	src/server/mp/settlement.test.ts \
	src/pages/api/mp/snapshot.ts \
	src/pages/api/mp/settle.ts \
	src/pages/api/mp/release-escrow.ts \
	src/server/mp/snapshot-api.test.ts \
	src/server/mp/settle-api.test.ts \
	src/server/mp/release-escrow.test.ts
```

Delete any additional settlement-only test identified by `/tmp/hpa-542-coupling.txt`.

- [ ] **Step 2: Remove multiplayer mission semantics**

Delete `mpHandsCompleted`, dedicated registry entries, and `poker_mp` special cases from `computeIncrement`.

Delete tests that count multiplayer hands/wins/game-mode participation. Keep ordinary single-player mission behavior.

- [ ] **Step 3: Remove cleanup exception**

Change the 30-day receipt cleanup from:

```sql
gameType NOT IN ('poker_mp', 'roulette')
```

to the existing non-multiplayer rule that only protects roulette through its separate 90-day pass.

Remove multiplayer comments/fixtures.

- [ ] **Step 4: Run focused tests**

```bash
bun test src/lib/missions src/server/cleanup.test.ts
bun run build
```

Verify:

```bash
! git grep -E 'poker_mp|mpHandsCompleted|SETTLEMENT_FAILED' -- src e2e
```

- [ ] **Step 5: Commit**

```bash
git add -u src/server/mp src/pages/api/mp
git add src/lib/missions src/server/cleanup.ts src/server/cleanup.test.ts
git commit -m 'refactor(mp): delete settlement and progression sinks'
```

---

### Task 6: Remove `heldChips` and `mp_membership` from schema, runtime SQL, fixtures, and migration history

**Files:**

- Modify: `src/db/schema.ts`
- Modify: `src/pages/api/chips/update.ts`
- Modify: `src/lib/chips-update-api.test.ts`
- Modify: `src/lib/roulette/spin-batch-sql.ts`
- Modify: `src/pages/api/roulette/spin.ts`
- Modify:
  - `src/lib/roulette/spin-api.test.ts`
  - `src/lib/roulette/spin-cascade.integration.test.ts`
- Modify known mission fixtures:
  - `src/lib/missions/seed.test.ts`
  - `src/lib/missions/claim.test.ts`
  - `src/lib/missions/reroll.test.ts`
  - `src/lib/missions/board-integration.test.ts`
  - `src/lib/missions/progress-integration.test.ts`
- Modify:
  - `src/server/daily-challenge/repository.integration.test.ts`
  - `src/server/ranked/test-d1.ts`
  - `src/server/ranked/repository.integration.test.ts`
  - `scripts/apply-migrations.test.ts`
- Delete:
  - `drizzle/0008_last_living_lightning.sql`
  - `drizzle/0008_mp_membership.sql`
- Modify every additional runtime/test path from the preflight grep.

**Interfaces:**

- `user` contains `chipBalance` but no `heldChips`.
- No `mp_membership` table exists in a freshly recreated database.
- Wallet/roulette operations no longer check an inactive multiplayer escrow column.

- [ ] **Step 1: Remove schema definitions**

Delete:

```ts
heldChips: integer('heldChips').notNull().default(0)
```

and the full `mpMembership` table definition.

- [ ] **Step 2: Remove runtime SQL/projections**

In chip update, roulette, and any remaining repository:

- remove `heldChips` from `SELECT`, `INSERT`, `UPDATE`, and result types;
- remove `heldChips = 0` guards;
- preserve existing chip-balance optimistic locking and receipt behavior unrelated to multiplayer.

- [ ] **Step 3: Update every fixture from fresh grep output**

Run again:

```bash
git grep -nE 'heldChips|mp_membership|mpMembership' -- src e2e scripts drizzle
```

For each result:

- remove the column from test schemas;
- remove the value from positional `INSERT` column/value lists;
- remove membership setup/assertions;
- keep unrelated assertions unchanged.

The known list above is not exhaustive if the fresh grep reports more files.

- [ ] **Step 4: Delete obsolete migration files**

```bash
git rm drizzle/0008_last_living_lightning.sql drizzle/0008_mp_membership.sql
```

Do not add a forward copy/drop migration. This branch recreates every database.

- [ ] **Step 5: Reset local binding state exactly**

```bash
rm -rf .wrangler/state
bun run db:migrate:local
```

Verify fresh schema:

```bash
bunx wrangler d1 execute arcturus --local --command \
	"SELECT name FROM sqlite_schema WHERE type='table' AND name='mp_membership';"
```

Expected: zero rows.

```bash
bunx wrangler d1 execute arcturus --local --command \
	"SELECT name FROM pragma_table_info('user') WHERE name='heldChips';"
```

Expected: zero rows.

- [ ] **Step 6: Run broad tests immediately after schema deletion**

```bash
bun run test
bun run lint
bun run build
```

Resolve every failure before continuing. This early full-suite gate is required because fixture blast radius is the highest-risk part of the change.

- [ ] **Step 7: Verify zero active matches**

```bash
! git grep -E 'heldChips|mp_membership|mpMembership' -- \
	src e2e scripts drizzle wrangler.toml
```

Historical planning documents may still mention the removed names; runtime/config/test paths may not.

- [ ] **Step 8: Commit**

```bash
git add -A src e2e scripts drizzle
git commit -m 'refactor(wallet): remove multiplayer escrow schema'
```

---

### Task 7: Rename the Durable Object class, file, and binding last

**Files:**

- Rename: `src/server/mp/arcturus.ts` → `src/server/mp/multiplayer-poker-room.ts`
- Rename: `src/server/mp/arcturus.test.ts` → `src/server/mp/multiplayer-poker-room.test.ts`
- Modify: `src/worker.ts`
- Modify: `src/env.d.ts`
- Modify: `wrangler.toml`
- Modify binding references in:
  - `src/pages/api/mp/rooms/index.ts`
  - `src/pages/api/mp/rooms/[code].ts`
  - `src/pages/api/mp/rooms/[code]/ws.ts`
  - `src/server/mp/rooms-api.test.ts`
  - `src/server/mp/ws-route-logic.test.ts`

**Interfaces:**

```ts
export class MultiplayerPokerRoom implements DurableObject;
```

```ts
interface Env {
	MULTIPLAYER_POKER_ROOMS: DurableObjectNamespace;
}
```

- [ ] **Step 1: Rename files and symbols atomically**

```bash
git mv src/server/mp/arcturus.ts src/server/mp/multiplayer-poker-room.ts
git mv src/server/mp/arcturus.test.ts src/server/mp/multiplayer-poker-room.test.ts
```

Rename class/import/export references from `Arcturus` to `MultiplayerPokerRoom`.

- [ ] **Step 2: Rename binding everywhere**

Use `MULTIPLAYER_POKER_ROOMS` in environment types, routes, and route tests. Remove `arcturus` from `Env`.

- [ ] **Step 3: Add the breaking Durable Object migration**

Keep v1 and append:

```toml
[[migrations]]
tag = "v2"
deleted_classes = ["Arcturus"]
new_sqlite_classes = ["MultiplayerPokerRoom"]
```

Binding:

```toml
[[durable_objects.bindings]]
name = "MULTIPLAYER_POKER_ROOMS"
class_name = "MultiplayerPokerRoom"
```

Do **not** use `new_classes`. The new namespace is SQLite-backed even though code uses `storage.get/put`.

- [ ] **Step 4: Export the new class**

In `src/worker.ts`:

```ts
import { MultiplayerPokerRoom } from './server/mp/multiplayer-poker-room';

return { default: { fetch, scheduled }, MultiplayerPokerRoom };
```

- [ ] **Step 5: Run focused tests and build**

```bash
bun test src/server/mp/multiplayer-poker-room.test.ts \
	src/server/mp/rooms-api.test.ts src/server/mp/ws-route-logic.test.ts
bun run build
```

Verify old active names are absent:

```bash
! git grep -E 'class Arcturus|env\.arcturus|runtime\.env\.arcturus|server/mp/arcturus' -- \
	src wrangler.toml
```

- [ ] **Step 6: Commit**

```bash
git add -A src/server/mp src/pages/api/mp/rooms src/worker.ts src/env.d.ts wrangler.toml
git commit -m 'refactor(mp): rename multiplayer room durable object'
```

---

### Task 8: Update product/docs, rewrite E2E, document destructive reset, and verify the full branch

**Files:**

- Modify: `src/pages/profile.astro`
- Delete: `docs/leaderboard-future-improvements.md`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`
- Rewrite: `e2e/multiplayer-poker.spec.ts`
- Modify only if binding command requires it: `playwright.config.mp.ts`
- Modify PR description after fresh verification.

**Interfaces:**

- Produces one current product description and one representative multiplayer E2E.
- Documents exact local and remote reset operations.

- [ ] **Step 1: Replace obsolete product copy**

Replace tournament/friend-reward tips with current copy equivalent to:

```text
Try a different single-player table to explore another strategy.
Create a private poker room and share its code for a casual match.
```

Delete:

```bash
git rm docs/leaderboard-future-improvements.md
```

- [ ] **Step 2: Update repository guidance**

Document:

```text
src/lib/mp-poker/*               pure/browser multiplayer code
src/server/mp/multiplayer-poker-room.ts
MultiplayerPokerRoom
MULTIPLAYER_POKER_ROOMS
room-local chips; no D1 settlement
```

Remove `MP_AUTH_SECRET`, `Arcturus`, persistent membership, snapshot, and settlement instructions.

- [ ] **Step 3: Rewrite E2E without membership/settlement waits**

Delete:

```text
waitForSettlement
membership-release navigation delay
30-second disconnect test
serial lock workarounds
```

The one test must:

1. create two authenticated contexts;
2. create a two-seat 5/10 room;
3. seat A at 0 and B at 1;
4. assert both start at 1,000 local chips;
5. start a hand;
6. read `data-current-seat`;
7. fold from the corresponding browser;
8. assert both receive `Hand ended`;
9. assert pot becomes zero immediately;
10. assert winner stack rises and loser stack falls.

- [ ] **Step 4: Run local reset and full verification**

```bash
rm -rf .wrangler/state
bun run db:migrate:local
bun run test
bun run lint
bun run format:check
bun run build
bun run test:e2e:mp
```

Record exact outputs. Do not claim success from partial suites.

- [ ] **Step 5: Run final residue checks**

```bash
git diff --check main...HEAD

! git grep -E \
	'heldChips|mp_membership|mpMembership|MP_AUTH_SECRET|pendingLockReleases|pendingEscrowReleases|SETTLEMENT_FAILED|MULTIPLAYER_CONFLICT|MULTIPLAYER_ESCROW_ORPHANED' \
	-- src e2e scripts drizzle wrangler.toml README.md CLAUDE.md AGENTS.md

! git grep -E 'tournaments page|Invite friends for exclusive' -- src/pages/profile.astro
```

Confirm:

- no `src/modules` directory was introduced;
- `src/lib/mp-poker` remains the pure module;
- only the Durable Object stores multiplayer room state;
- routes have no D1 imports;
- every protocol message and field has a consumer;
- no old binding/class alias exists.

- [ ] **Step 6: Document the remote reset in the PR**

Include this destructive release procedure:

```bash
bunx wrangler d1 delete arcturus --skip-confirmation
bunx wrangler d1 create arcturus
# Copy returned database ID into wrangler.toml
bun run db:migrate:remote
bun run deploy
```

State explicitly that all hobby-stage account/game data and old rooms are discarded.

Do not run the remote reset while implementing/reviewing the PR; it is a merge/deploy operation.

- [ ] **Step 7: Commit docs and E2E**

```bash
git add -A src/pages/profile.astro docs README.md CLAUDE.md AGENTS.md \
	e2e playwright.config.mp.ts
git commit -m 'docs(mp): finalize isolated room rollout'
```

- [ ] **Step 8: Update the implementation PR description**

Use:

```markdown
## Summary
- Replace multiplayer wallet escrow with 100-BB room-local stacks.
- Keep pure multiplayer code in `src/lib/mp-poker` and Worker runtime in `src/server/mp`.
- Delete membership, settlement callbacks, Ranked exclusion, progression, and recovery machinery.
- Replace the old Durable Object namespace with SQLite-backed `MultiplayerPokerRoom`.
- Recreate D1 rather than migrate held chips or memberships.

## Verification
- `bun run test`
- `bun run lint`
- `bun run format:check`
- `bun run build`
- `bun run test:e2e:mp`

## Breaking reset
This hobby-stage release deletes and recreates the D1 database and invalidates all existing multiplayer rooms. No compatibility or data migration is provided.
```

---

## Plan self-review checklist

Before execution begins, confirm:

- [ ] Every task ends with tests/build green.
- [ ] No task moves a file before its consumers are updated in the same commit.
- [ ] The binding/class rename happens only in Task 7.
- [ ] Fold-out/showdown winner discovery uses hand state, not live seats.
- [ ] Payout occurs before disconnect seat clear.
- [ ] All-in disconnected seats survive until hand completion.
- [ ] `currentSeat` has a real page/E2E consumer.
- [ ] `new_sqlite_classes` remains in the final migration.
- [ ] The preflight grep output is fully classified.
- [ ] Schema deletion is followed immediately by the full test suite.
- [ ] Exact local and remote reset commands are documented.
- [ ] No `src/modules`, barrel package, compatibility layer, or generic framework is introduced.
