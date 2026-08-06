# Isolated Private-Room Poker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep private-room Texas Hold'em playable while replacing persistent wallet escrow and cross-system recovery with room-local stacks in the repository's existing multiplayer folders.

**Architecture:** Rewrite the existing pure engine and Durable Object behavior in place first so every intermediate commit builds. Add a personalized public protocol and a human-usable room UI, then prove the happy path through E2E before removing Ranked, route, wallet, schema, and progression coupling. Rename the Durable Object class and binding only after all old dependencies are gone.

**Tech Stack:** Astro 5 SSR, Cloudflare Workers, Cloudflare Durable Objects with hibernatable WebSockets, TypeScript, Zod 4, Bun, Miniflare/Vitest where already used, Playwright, Drizzle ORM, Cloudflare D1, Wrangler 4.

## Global Constraints

- Starting stack is exactly `bigBlind * 100`.
- Room phases are exactly `waiting` and `in-hand`.
- Turn timeout is exactly 60 seconds.
- Reconnect grace is exactly 30 seconds.
- Empty-room cleanup is exactly five minutes.
- Any connected eligible seated player may start; there is no host role.
- Multiplayer must not read or write D1, `user.chipBalance`, missions, achievements, statistics, leaderboards, or Ranked Blackjack state.
- Keep pure/browser code under `src/lib/mp-poker` and Worker-only room code under `src/server/mp`.
- Keep camelCase filenames such as `roomCode.ts`.
- Keep the existing `/games/poker-mp` and `/api/mp/rooms` URLs.
- No backward-compatibility layer, dual path, old-state parser, or data migration.
- New Durable Object namespace uses `new_sqlite_classes`; SQLite-backed objects may still use `storage.get/put`.
- Do not introduce a generic realtime framework, Durable Object base class, repository, event bus, barrel package, or configurable stack policy.
- Preserve existing poker legality, shuffle, side-pot, showdown, split-pot, and odd-chip behavior.
- Existing rules tests may change only in setup and local-stack assertions. If an expected legal action, board, pot, tie, side-pot, runout, or odd-chip result must change, stop and surface it as a separate finding.
- Every task must pass its focused tests and `bun run build` before continuing.

---

## Preflight: authoritative coupling and type baselines

### Coupling audit

- [ ] Run the authoritative repository audit:

```bash
git grep -nE \
	'heldChips|mp_membership|mpMembership|MP_AUTH_SECRET|reconcileMultiplayer|poker_mp|mpHandsCompleted|pendingEscrow|pendingLock|SETTLEMENT_FAILED' \
	-- src e2e scripts drizzle wrangler.toml README.md CLAUDE.md AGENTS.md \
	| tee /tmp/hpa-542-coupling.txt
```

- [ ] Classify every line in `/tmp/hpa-542-coupling.txt` as exactly one of:

```text
DELETE
EDIT
HISTORICAL_DOC_ONLY
```

The explicit file lists in Tasks 3–6 are the known blast radius. The fresh grep is authoritative; no runtime, test, configuration, or migration match may remain unclassified.

### TypeScript error baseline

The repository currently has no clean project-wide `tsc` gate. Capture a normalized baseline rather than pretending `astro build` type-checks the code.

- [ ] Capture the pre-change error set:

```bash
bunx tsc --noEmit --pretty false > /tmp/hpa-542-tsc-before.raw 2>&1 || true

sed -E -e 's#src/server/mp/(arcturus|multiplayer-poker-room)#src/server/mp/ROOM#g' \
	-e 's/\([0-9]+,[0-9]+\)/(:LINE)/g' /tmp/hpa-542-tsc-before.raw \
	| grep -E 'src/(lib/mp-poker|server/mp|pages/api/mp|pages/games/poker-mp|server/ranked|lib/ranked|pages/api/chips/update|pages/api/roulette|lib/roulette|lib/missions|server/daily-challenge|db/schema)' \
	| sort -u \
	> /tmp/hpa-542-tsc-before.filtered

cat /tmp/hpa-542-tsc-before.filtered
```

This is a **new-error guard**, not a claim that the repository type-checks cleanly.

---

## Final file shape

| Action | Path | Responsibility |
|---|---|---|
| Modify in place | `src/lib/mp-poker/engine.ts` | Room-local state, poker transitions, payout |
| Modify in place | `src/lib/mp-poker/engine.test.ts` | Existing rule coverage plus local stacks and payout |
| Modify in place | `src/lib/mp-poker/protocol.ts` | Schemas and pure public message projections |
| Modify in place | `src/lib/mp-poker/protocol.test.ts` | Retained/removed messages, privacy, personalization |
| Create | `src/lib/mp-poker/timers.ts` | Timeout constants and pure next-alarm calculation |
| Create | `src/lib/mp-poker/timers.test.ts` | Deadline selection and busy-loop prevention |
| Modify in place | `src/lib/mp-poker/client.ts` | Browser WebSocket wrapper |
| Modify in place | `src/lib/mp-poker/client.test.ts` | Connection, parse, send, disconnect behavior |
| Keep | `src/lib/mp-poker/roomCode.ts` | Room-code generation and validation |
| Rewrite then rename last | `src/server/mp/arcturus.ts` → `src/server/mp/multiplayer-poker-room.ts` | Durable Object sockets, storage, orchestration |
| Replace tests | `src/server/mp/arcturus.test.ts` → `src/server/mp/multiplayer-poker-room.test.ts` | Transition finalization, reconnect, alarm, persistence |
| Modify | `src/pages/api/mp/rooms/index.ts` | Thin create-room adapter |
| Modify | `src/pages/api/mp/rooms/[code].ts` | Thin metadata adapter |
| Modify | `src/pages/api/mp/rooms/[code]/ws.ts` | Thin authenticated WebSocket adapter |
| Modify | `src/pages/games/poker-mp/[code].astro` | Stack, own-seat, active-seat, showdown UI |
| Rewrite early | `e2e/multiplayer-poker.spec.ts` | One fast two-user human-visible happy path |
| Delete | `src/server/mp/membership.ts` and test | Persistent membership/reconciliation |
| Delete | `src/server/mp/settlement.ts` and test | Persistent settlement payload |
| Delete | `src/lib/mp-poker/roomExists.ts` and test | Membership repair probe |
| Delete | `src/pages/api/mp/{lock,snapshot,settle,release-escrow}.ts` | Internal economy callbacks |
| Delete/modify | Ranked, wallet, roulette, missions, cleanup, schema, fixtures, docs | Remove cross-system multiplayer concepts |

Design reference: `docs/superpowers/specs/2026-08-05-isolated-multiplayer-poker-design.md`.

---

## Delivery risks carried into execution

| Risk | Required control |
|---|---|
| Alarm-triggered completion strands a retained disconnected seat | One `applyTransition` path plus the explicit turn-timeout/all-in regression test |
| Personalized protocol leaks identity | `yourSeat` is a seat index only; projection tests assert `userId`, deck, and hole-card privacy |
| Showdown pruning makes poker unreadable | Retain and visibly render contested `showdownCards`; keep fold-outs private |
| Schema deletion misses a positional fixture | Treat preflight grep as authoritative and run the full suite immediately in Task 6 |
| Existing TypeScript debt hides new errors | Normalize path/line noise and reject new touched-path errors after Tasks 6 and 7 |
| Rules tests are rewritten to match regressions | Preserve existing rule expectations; stop on any non-setup expected-value change |
| Happy path is untested during destructive work | Restore E2E in Task 2 and rerun it after Tasks 3–7 |

---

## Task 1: Convert the engine and Durable Object behavior to local stacks in place

**Files:**

- Modify: `src/lib/mp-poker/engine.ts`
- Modify: `src/lib/mp-poker/engine.test.ts`
- Create: `src/lib/mp-poker/timers.ts`
- Create: `src/lib/mp-poker/timers.test.ts`
- Modify: `src/server/mp/arcturus.ts`
- Delete: `src/server/mp/reconnect-guard.test.ts`
- Delete: `src/server/mp/turn-timeout.test.ts`
- Create: `src/server/mp/arcturus.test.ts`

**Interfaces produced:**

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

export interface ShowdownCard {
	userId: string;
	seatIndex: number;
	cards: [Card, Card];
}

export interface HandResult {
	winners: HandWinner[];
	showdownCards: ShowdownCard[];
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

The file remains `src/server/mp/arcturus.ts`, the class remains `Arcturus`, and the binding remains `env.arcturus` throughout this task.

- [ ] **Step 1: Pin the existing rules safety net**

Before editing, run and record:

```bash
bun test src/lib/mp-poker/engine.test.ts
```

Then list the existing test names:

```bash
grep -n "test('" src/lib/mp-poker/engine.test.ts \
	> /tmp/hpa-542-engine-tests-before.txt
```

During this task, adapt existing tests only by replacing `hostUserId`, `mainBalance`, and snapshots with room-local seat setup. Do not rename or rewrite legality, side-pot, tie, runout, or odd-chip tests merely to make the implementation easier.

- [ ] **Step 2: Add failing local-stack and payout tests**

Add helpers and assertions equivalent to:

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
		showdownCards: [],
	});
	expect(transition.room.seats[0].chips).toBe(995);
	expect(transition.room.seats[1].chips).toBe(1_005);
});
```

Add these explicit cases:

- contested showdown returns non-folded `showdownCards`;
- winner discovery still works when live seat identity is absent;
- payout credits only a matching `{ userId, seatIndex }`;
- an expired disconnected all-in winner is paid before clear;
- a replacement occupant is never credited for the old hand.

- [ ] **Step 3: Verify the new contract fails**

```bash
bun test src/lib/mp-poker/engine.test.ts
```

Expected: FAIL because the old API requires wallet snapshots and completed hands enter `settling`.

- [ ] **Step 4: Replace wallet-oriented room state**

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

Delete:

```text
hostUserId
mainBalance
handStacks
handLog
settling
frozen
```

Validate 2/4/6 seats, positive safe-integer blinds, `bigBlind >= smallBlind * 2`, and safe-integer `bigBlind * 100`.

- [ ] **Step 5: Implement local debit and start eligibility**

`takeSeat` assigns `room.config.bigBlind * 100` chips.

`startHand` deals only connected occupied seats with `chips >= bigBlind`. Posting blinds and every call/bet/raise/all-in subtract from `SeatState.chips` and add to `hand.committed` in the same immutable transition.

- [ ] **Step 6: Make completion independent of live seats**

Fold-out remaining users come from:

```ts
const remainingUserIds = Object.keys(hand.holeCards).filter(
	(userId) => !hand.folded.has(userId),
);
```

Seat indices come from `hand.seatIndexMap`.

Showdown players are built from `hand.holeCards`, `hand.committed`, and `hand.seatIndexMap`; do not read `room.seats[seatIndex].userId` to discover winners.

Keep `buildSidePots` engine-local and remove its unused live-seat argument.

- [ ] **Step 7: Apply payout with identity matching**

Implement one completion helper:

```ts
function completeHand(
	room: Room,
	winners: HandWinner[],
	showdownCards: ShowdownCard[],
): RoomTransition {
	const awardByUserId = new Map(winners.map((winner) => [winner.userId, winner]));
	const seats = room.seats.map((seat) => {
		if (!seat.userId) return seat;
		const winner = awardByUserId.get(seat.userId);
		if (!winner || winner.seatIndex !== seat.seatIndex) return seat;
		return { ...seat, chips: seat.chips + winner.amount };
	});
	return {
		room: { ...room, phase: 'waiting', seats, hand: null },
		handResult: { winners, showdownCards },
	};
}
```

- [ ] **Step 8: Add pure timer helpers**

Create `src/lib/mp-poker/timers.ts`:

```ts
import type { Room } from './engine';

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

The calculation includes the current turn deadline, clearable future reconnect deadlines, and persisted empty deadline. It excludes an already-expired reconnect deadline while that user is protected by an active hand, preventing an immediate alarm loop.

Test exact constants and deadline precedence in `timers.test.ts`.

- [ ] **Step 9: Rewrite the Durable Object behavior in place**

Remove from `arcturus.ts`:

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

Create one private finalization seam:

```ts
private async applyTransition(
	transition: RoomTransition,
	now: number,
): Promise<void>;
```

Its exact order is:

1. set `this.room = transition.room`;
2. emit `hand_ended` when `transition.handResult` exists;
3. clear every expired disconnected seat no longer protected by `this.room.hand`;
4. persist;
5. send room state;
6. schedule the next alarm.

Call it from normal action handling, disconnect `forceFold`, and connected-player turn timeout.

- [ ] **Step 10: Add the missing alarm regression test**

In `src/server/mp/arcturus.test.ts`, model:

```text
A is all-in, disconnected, and past reconnect grace
B is current actor
B's turn deadline expires
alarm force-folds B
A wins and receives payout
shared applyTransition clears A's now-unprotected expired seat
the room can become empty and receive an emptyDeadline
```

Also cover reconnect within grace, corrupt-state deletion, persistence reload, and empty-room cleanup without real-time sleeps.

- [ ] **Step 11: Run focused tests and build**

```bash
bun test src/lib/mp-poker/engine.test.ts \
	src/lib/mp-poker/timers.test.ts \
	src/server/mp/arcturus.test.ts
bun run build
```

Verify economy calls are gone from the active runtime:

```bash
! git grep -E \
	'fetchSnapshot|runSettlement|releaseEscrow|releaseMembership|pendingEscrow|pendingLock|SETTLEMENT_FAILED' \
	-- src/server/mp/arcturus.ts src/lib/mp-poker/engine.ts
```

- [ ] **Step 12: Commit the buildable vertical slice**

```bash
git add src/lib/mp-poker/engine.ts src/lib/mp-poker/engine.test.ts \
	src/lib/mp-poker/timers.ts src/lib/mp-poker/timers.test.ts \
	src/server/mp/arcturus.ts src/server/mp/arcturus.test.ts
git add -u src/server/mp
git commit -m 'refactor(mp): use room-local poker stacks'
```

---

## Task 2: Personalize the protocol, render a usable room, and restore E2E early

**Files:**

- Modify: `src/lib/mp-poker/protocol.ts`
- Modify: `src/lib/mp-poker/protocol.test.ts`
- Modify: `src/lib/mp-poker/client.ts`
- Modify: `src/lib/mp-poker/client.test.ts`
- Modify: `src/server/mp/arcturus.ts`
- Modify: `src/server/mp/arcturus.test.ts`
- Modify: `src/pages/games/poker-mp/[code].astro`
- Rewrite: `e2e/multiplayer-poker.spec.ts`

**Interfaces produced:**

```ts
export interface RoomStateMessage {
	type: 'room_state';
	phase: 'waiting' | 'in-hand';
	seats: PublicSeat[];
	pot: number;
	board: ProtocolCard[];
	currentSeat: number | null;
	yourSeat: number | null;
}

export interface HandEndedMessage {
	type: 'hand_ended';
	winners: Array<{ seatIndex: number; amount: number }>;
	showdownCards: Array<{
		seatIndex: number;
		cards: [ProtocolCard, ProtocolCard];
	}>;
}

export function toRoomStateMessage(
	room: Room,
	viewerUserId: string,
): RoomStateMessage;

export function toHandEndedMessage(result: HandResult): HandEndedMessage;
```

- [ ] **Step 1: Write protocol failures first**

Test retained messages and explicitly reject removed messages:

```ts
test('rejects removed messages', () => {
	expect(() => ClientMessage.parse({ type: 'emote', emoteId: 'good_game' })).toThrow();
	expect(() => ServerMessage.parse({ type: 'state_delta', patch: {} })).toThrow();
	expect(() => ServerMessage.parse({ type: 'ping' })).toThrow();
});
```

Add projection tests:

```ts
test('personalizes room state without exposing user ids', () => {
	const message = toRoomStateMessage(room, 'u2');
	expect(message.yourSeat).toBe(1);
	expect(message.currentSeat).toBe(0);
	expect(JSON.stringify(message)).not.toContain('"userId"');
	expect(JSON.stringify(message)).not.toContain('holeCards');
	expect(JSON.stringify(message)).not.toContain('deck');
});

test('retains showdown cards but strips internal user ids', () => {
	const message = toHandEndedMessage(showdownResult);
	expect(message.showdownCards).toHaveLength(2);
	expect(JSON.stringify(message)).not.toContain('"userId"');
});
```

- [ ] **Step 2: Implement the minimal current protocol**

Keep client messages:

```text
take_seat
leave_seat
start_hand
action
```

Keep server messages:

```text
room_state
hand_started
hand_ended
error
```

Delete:

```text
PROTOCOL_VERSION
EMOTES
state_delta
kicked
hand_aborted
ping/pong
membership/settlement errors
hand_ended.pots
room_state.betToCall
room_state.timeRemainingMs
```

Retain `hand_ended.showdownCards` and add `room_state.yourSeat`.

- [ ] **Step 3: Keep pure projection in `protocol.ts`**

Implement `toRoomStateMessage(room, viewerUserId)` and `toHandEndedMessage(result)` beside the schemas. Use a type-only engine import; do not export these helpers from the Worker file.

The Durable Object sends `room_state` per socket:

```ts
private sendRoomState(): void {
	if (!this.room) return;
	for (const [socket, identity] of this.sockets) {
		this.send(socket, toRoomStateMessage(this.room, identity.userId));
	}
}
```

- [ ] **Step 4: Render own seat and active seat**

On every room state:

```ts
root.dataset.currentSeat = msg.currentSeat === null ? '' : String(msg.currentSeat);
root.dataset.yourSeat = msg.yourSeat === null ? '' : String(msg.yourSeat);
```

For each seat, apply separate own/active indicators. Use stable attributes for tests:

```ts
div.dataset.seatIndex = String(seat.seatIndex);
div.dataset.yourSeat = String(seat.seatIndex === msg.yourSeat);
div.dataset.activeSeat = String(seat.seatIndex === msg.currentSeat);
```

Visible text must include stack and commitment:

```text
Seat 1: Alice — 995 chips — 5 committed
```

Add visible labels such as `You` and `Acting` rather than relying only on color.

- [ ] **Step 5: Render contested showdown cards**

When `hand_ended.showdownCards` is non-empty, append a log line equivalent to:

```text
Showdown: seat 0 A♠ K♠; seat 1 Q♥ Q♣
```

Use the existing `getSuitGlyph` helper. Fold-outs must not reveal cards.

- [ ] **Step 6: Keep the browser client narrow**

Retain successful connect, parsed delivery, malformed-message drop, send-only-while-open, disconnect callbacks, and superseded-socket behavior. Do not add automatic reconnect/backoff.

- [ ] **Step 7: Rewrite the E2E now, not after schema deletion**

Delete settlement waits, membership-release navigation delays, the 30-second disconnect test, and serial lock workarounds.

The one test must:

1. open two authenticated contexts;
2. create a two-seat 5/10 room;
3. seat A at 0 and B at 1;
4. assert both receive 1,000 local chips;
5. assert A sees `yourSeat=0` and B sees `yourSeat=1`;
6. start a hand;
7. assert both pages identify the same active seat;
8. fold from the active player's browser;
9. assert both receive `Hand ended`;
10. assert pot becomes zero immediately;
11. assert winner stack rises and loser stack falls.

Protocol tests prove the projected showdown payload and the page implementation visibly consumes it. The representative E2E remains the fast fold-out path to keep one stable end-to-end journey.

- [ ] **Step 8: Run protocol, UI build, and E2E**

```bash
bun test src/lib/mp-poker/protocol.test.ts \
	src/lib/mp-poker/client.test.ts \
	src/server/mp/arcturus.test.ts
bun run build
bun run test:e2e:mp
```

- [ ] **Step 9: Verify protocol residue**

```bash
! git grep -E \
	'PROTOCOL_VERSION|state_delta|emote_received|hand_aborted|type: .ping.|type: .pong.' \
	-- src/lib/mp-poker src/server/mp src/pages/games/poker-mp e2e
```

- [ ] **Step 10: Commit the usable room slice**

```bash
git add src/lib/mp-poker/protocol.ts src/lib/mp-poker/protocol.test.ts \
	src/lib/mp-poker/client.ts src/lib/mp-poker/client.test.ts \
	src/server/mp/arcturus.ts src/server/mp/arcturus.test.ts \
	'src/pages/games/poker-mp/[code].astro' e2e/multiplayer-poker.spec.ts
git commit -m 'refactor(mp): expose usable room state'
```

---

## Task 3: Remove Ranked Blackjack's multiplayer dependency

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

**Interface after this task:**

```ts
export interface RankedCoordinatorDeps {
	repository: RankedRepository;
	getAdapter: typeof getRankedAdapter;
	now: () => Date;
	randomBytes: (length: number) => Uint8Array;
	log?: (entry: RankedLogEntry) => void;
}
```

- [ ] **Step 1: Delete conflict expectations and verify failure**

Remove tests for `MULTIPLAYER_CONFLICT` and `MULTIPLAYER_ESCROW_ORPHANED`. Add a coordinator construction/start test with no membership dependency.

```bash
bun test src/server/ranked/coordinator.test.ts src/server/ranked/http.test.ts
```

Expected: FAIL because production factories still require membership fields.

- [ ] **Step 2: Remove membership logic**

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

- [ ] **Step 3: Simplify HTTP and scheduled construction**

`RankedHttpCoordinatorBindings` contains only `db`. Remove namespace plumbing from Ranked HTTP and Worker construction.

Change scheduled dependency to:

```ts
rankedExpiration(db: D1Database, nowSeconds: number): Promise<void>;
```

- [ ] **Step 4: Remove protocol errors and Ranked `heldChips` guards**

Delete both multiplayer errors from maps/types/tests. Ranked account reads and conditional updates use only `chipBalance` and existing Ranked concurrency fields.

- [ ] **Step 5: Run Ranked, cleanup, build, and multiplayer E2E**

```bash
bun test src/server/ranked src/lib/ranked src/server/cleanup.test.ts
bun run build
bun run test:e2e:mp
```

Verify:

```bash
! git grep -E \
	'reconcileMultiplayerMembership|MULTIPLAYER_CONFLICT|MULTIPLAYER_ESCROW_ORPHANED|membershipNamespace|membershipDb|heldChips' \
	-- src/server/ranked src/lib/ranked src/worker.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/server/ranked src/lib/ranked src/worker.ts \
	src/server/cleanup.ts src/server/cleanup.test.ts
git commit -m 'refactor(ranked): remove multiplayer exclusion'
```

---

## Task 4: Thin room routes, remove membership, and delete the internal secret

**Files:**

- Modify: `src/pages/api/mp/rooms/index.ts`
- Modify: `src/pages/api/mp/rooms/[code].ts`
- Modify: `src/pages/api/mp/rooms/[code]/ws.ts`
- Rewrite: `src/server/mp/rooms-api.test.ts`
- Rewrite: `src/server/mp/ws-route-logic.test.ts`
- Modify: `src/env.d.ts`
- Modify: `wrangler.toml` comments only; keep class/binding names until Task 7
- Modify: `README.md` secret/setup references if present
- Delete: `src/server/mp/membership.ts`
- Delete: `src/server/mp/membership.test.ts`
- Delete: `src/pages/api/mp/lock.ts`
- Delete: `src/server/mp/lock.test.ts`
- Delete: `src/lib/mp-poker/roomExists.ts`
- Delete: `src/lib/mp-poker/roomExists.test.ts`

Routes still use `env.arcturus` during this task and perform no D1 access.

- [ ] **Step 1: Rewrite create-route tests with namespace stubs**

Cover unauthorized, malformed JSON, invalid config, missing binding, successful init, 409 collision retry, exhausted collisions, non-409 response, and thrown fetch.

Use locals without DB:

```ts
function makeLocals(namespace?: DurableObjectNamespace) {
	return {
		user: { id: 'rooms-api-user', name: 'Room Creator' },
		runtime: { env: { arcturus: namespace } },
	};
}
```

- [ ] **Step 2: Replace create and metadata routes**

Create route validates 2/4/6 seats, safe-integer blinds, `bigBlind >= smallBlind * 2`, and safe-integer `bigBlind * 100`. Generate/init up to five room codes and retry only 409.

Metadata route validates code/auth/binding and forwards `/metadata`.

- [ ] **Step 3: Rewrite and replace the WebSocket route**

Keep room-code validation, authentication, same-origin validation, Upgrade validation, trusted user ID/display-name headers, and forwarding. Delete every D1/membership/escrow branch.

- [ ] **Step 4: Delete membership and room-probe files**

```bash
git rm \
	src/server/mp/membership.ts \
	src/server/mp/membership.test.ts \
	src/pages/api/mp/lock.ts \
	src/server/mp/lock.test.ts \
	src/lib/mp-poker/roomExists.ts \
	src/lib/mp-poker/roomExists.test.ts
```

- [ ] **Step 5: Remove `MP_AUTH_SECRET` explicitly**

Delete:

```ts
MP_AUTH_SECRET?: string;
```

from `src/env.d.ts`. Remove the corresponding Wrangler secret setup comments and README instructions. No replacement secret is introduced because the callback APIs are being deleted.

- [ ] **Step 6: Run route tests, build, and E2E**

```bash
bun test src/server/mp/rooms-api.test.ts src/server/mp/ws-route-logic.test.ts
bun run build
bun run test:e2e:mp
```

Verify:

```bash
! git grep -E \
	'createDb|mpMembership|reconcileMultiplayerMembership|hasActiveRankedSession|mp_membership|MP_AUTH_SECRET' \
	-- src/pages/api/mp/rooms src/server/mp src/lib/mp-poker src/env.d.ts wrangler.toml README.md
```

- [ ] **Step 7: Commit**

```bash
git add src/pages/api/mp/rooms src/server/mp/rooms-api.test.ts \
	src/server/mp/ws-route-logic.test.ts src/env.d.ts wrangler.toml README.md
git add -u src/server/mp src/pages/api/mp src/lib/mp-poker
git commit -m 'refactor(mp): remove persistent room membership'
```

---

## Task 5: Delete multiplayer settlement and progression sinks

**Files:**

- Delete: `src/server/mp/settlement.ts`
- Delete: `src/server/mp/settlement.test.ts`
- Delete: `src/pages/api/mp/snapshot.ts`
- Delete: `src/pages/api/mp/settle.ts`
- Delete: `src/pages/api/mp/release-escrow.ts`
- Delete: `src/server/mp/snapshot-api.test.ts`
- Delete: `src/server/mp/settle-api.test.ts`
- Delete: `src/server/mp/release-escrow.test.ts`
- Modify: `src/lib/missions/types.ts`
- Modify: `src/lib/missions/registry.ts`
- Modify: `src/lib/missions/progress.ts`
- Modify: `src/lib/missions/progress.test.ts`
- Modify: `src/lib/missions/progress-mock.test.ts`
- Modify: `src/lib/missions/progress-integration.test.ts`
- Modify: `src/server/cleanup.ts`
- Modify: `src/server/cleanup.test.ts`

- [ ] **Step 1: Delete callbacks, payload, and obsolete tests**

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

Delete any additional settlement-only test identified by the preflight audit.

- [ ] **Step 2: Remove multiplayer mission semantics**

Delete `mpHandsCompleted`, dedicated definitions, and `poker_mp` branches from mission progress. Delete tests that count multiplayer hands, wins, or game-mode participation. Keep ordinary single-player mission assertions unchanged.

- [ ] **Step 3: Remove the receipt-retention exception**

Remove the permanent `poker_mp` exception. Keep only roulette's separate bounded tombstone policy.

- [ ] **Step 4: Run focused suites, build, and E2E**

```bash
bun test src/lib/missions src/server/cleanup.test.ts
bun run build
bun run test:e2e:mp
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

## Task 6: Remove `heldChips` and `mp_membership` from schema, SQL, fixtures, and migration history

**Files:**

- Modify: `src/db/schema.ts`
- Modify: `src/pages/api/chips/update.ts`
- Modify: `src/lib/chips-update-api.test.ts`
- Modify: `src/lib/roulette/spin-batch-sql.ts`
- Modify: `src/pages/api/roulette/spin.ts`
- Modify: `src/lib/roulette/spin-api.test.ts`
- Modify: `src/lib/roulette/spin-cascade.integration.test.ts`
- Modify: `src/lib/missions/seed.test.ts`
- Modify: `src/lib/missions/claim.test.ts`
- Modify: `src/lib/missions/reroll.test.ts`
- Modify: `src/lib/missions/board-integration.test.ts`
- Modify: `src/lib/missions/progress-integration.test.ts`
- Modify: `src/server/daily-challenge/repository.integration.test.ts`
- Modify: `src/server/ranked/test-d1.ts`
- Modify: `src/server/ranked/repository.integration.test.ts`
- Modify: `scripts/apply-migrations.test.ts`
- Delete: `drizzle/0008_last_living_lightning.sql`
- Delete: `drizzle/0008_mp_membership.sql`
- Modify every additional active path returned by the preflight grep.

- [ ] **Step 1: Remove schema definitions and runtime guards**

Delete `user.heldChips` and the full `mpMembership` table definition.

Remove `heldChips` from chip-update and roulette SELECT/INSERT/UPDATE/result types. Preserve ordinary `chipBalance` optimistic locking, receipts, and roulette atomicity.

- [ ] **Step 2: Update every positional fixture**

Run:

```bash
git grep -nE 'heldChips|mp_membership|mpMembership' -- src e2e scripts drizzle
```

For each result, remove the column and its corresponding positional value, or delete membership setup/assertions. Do not change unrelated expected balances, rankings, missions, or outcomes.

- [ ] **Step 3: Delete obsolete migrations**

```bash
git rm drizzle/0008_last_living_lightning.sql drizzle/0008_mp_membership.sql
```

Do not add a forward migration. Every target database is recreated for this hobby-stage breaking release.

- [ ] **Step 4: Reset local state and verify schema**

```bash
rm -rf .wrangler/state
bun run db:migrate:local

bunx wrangler d1 execute arcturus --local --command \
	"SELECT name FROM sqlite_schema WHERE type='table' AND name='mp_membership';"

bunx wrangler d1 execute arcturus --local --command \
	"SELECT name FROM pragma_table_info('user') WHERE name='heldChips';"
```

Expected: both queries return zero rows.

- [ ] **Step 5: Run the broad suite immediately**

```bash
bun run test
bun run lint
bun run build
bun run test:e2e:mp
```

Resolve every failure before proceeding.

- [ ] **Step 6: Reject new normalized TypeScript errors**

```bash
bunx tsc --noEmit --pretty false > /tmp/hpa-542-tsc-after-task6.raw 2>&1 || true

sed -E -e 's#src/server/mp/(arcturus|multiplayer-poker-room)#src/server/mp/ROOM#g' \
	-e 's/\([0-9]+,[0-9]+\)/(:LINE)/g' /tmp/hpa-542-tsc-after-task6.raw \
	| grep -E 'src/(lib/mp-poker|server/mp|pages/api/mp|pages/games/poker-mp|server/ranked|lib/ranked|pages/api/chips/update|pages/api/roulette|lib/roulette|lib/missions|server/daily-challenge|db/schema)' \
	| sort -u \
	> /tmp/hpa-542-tsc-after-task6.filtered

comm -13 \
	/tmp/hpa-542-tsc-before.filtered \
	/tmp/hpa-542-tsc-after-task6.filtered
```

Expected: no output. Existing baseline errors may remain; this task must add none in the filtered touched paths.

- [ ] **Step 7: Verify zero active schema matches**

```bash
! git grep -E 'heldChips|mp_membership|mpMembership' -- \
	src e2e scripts drizzle wrangler.toml
```

- [ ] **Step 8: Commit**

```bash
git add -A src e2e scripts drizzle
git commit -m 'refactor(wallet): remove multiplayer escrow schema'
```

---

## Task 7: Rename the Durable Object class, file, and binding last

**Files:**

- Rename: `src/server/mp/arcturus.ts` → `src/server/mp/multiplayer-poker-room.ts`
- Rename: `src/server/mp/arcturus.test.ts` → `src/server/mp/multiplayer-poker-room.test.ts`
- Modify: `src/worker.ts`
- Modify: `src/env.d.ts`
- Modify: `wrangler.toml`
- Modify binding references in room routes and route tests.

- [ ] **Step 1: Rename files and symbols atomically**

```bash
git mv src/server/mp/arcturus.ts src/server/mp/multiplayer-poker-room.ts
git mv src/server/mp/arcturus.test.ts src/server/mp/multiplayer-poker-room.test.ts
```

Rename class/import/export references to `MultiplayerPokerRoom`.

- [ ] **Step 2: Rename the binding everywhere**

Use:

```ts
MULTIPLAYER_POKER_ROOMS: DurableObjectNamespace;
```

Delete `arcturus` from `Env` and update room routes/tests in the same commit.

- [ ] **Step 3: Add the breaking SQLite-backed migration**

Append:

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

Do not use `new_classes` and do not add SQL tables merely because the namespace is SQLite-backed.

- [ ] **Step 4: Export the new class**

```ts
import { MultiplayerPokerRoom } from './server/mp/multiplayer-poker-room';

return { default: { fetch, scheduled }, MultiplayerPokerRoom };
```

- [ ] **Step 5: Run focused suites, build, and E2E**

```bash
bun test src/server/mp/multiplayer-poker-room.test.ts \
	src/server/mp/rooms-api.test.ts src/server/mp/ws-route-logic.test.ts
bun run build
bun run test:e2e:mp
```

Verify:

```bash
! git grep -E 'class Arcturus|env\.arcturus|runtime\.env\.arcturus|server/mp/arcturus' -- \
	src wrangler.toml
```

- [ ] **Step 6: Re-run the normalized type guard**

```bash
bunx tsc --noEmit --pretty false > /tmp/hpa-542-tsc-after-task7.raw 2>&1 || true

sed -E -e 's#src/server/mp/(arcturus|multiplayer-poker-room)#src/server/mp/ROOM#g' \
	-e 's/\([0-9]+,[0-9]+\)/(:LINE)/g' /tmp/hpa-542-tsc-after-task7.raw \
	| grep -E 'src/(lib/mp-poker|server/mp|pages/api/mp|pages/games/poker-mp|server/ranked|lib/ranked|pages/api/chips/update|pages/api/roulette|lib/roulette|lib/missions|server/daily-challenge|db/schema)' \
	| sort -u \
	> /tmp/hpa-542-tsc-after-task7.filtered

comm -13 \
	/tmp/hpa-542-tsc-before.filtered \
	/tmp/hpa-542-tsc-after-task7.filtered
```

Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add -A src/server/mp src/pages/api/mp/rooms src/worker.ts src/env.d.ts wrangler.toml
git commit -m 'refactor(mp): rename multiplayer room durable object'
```

---

## Task 8: Update product/docs and perform final branch verification

**Files:**

- Modify: `src/pages/profile.astro`
- Delete: `docs/leaderboard-future-improvements.md`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`
- Modify only if required by the final binding command: `playwright.config.mp.ts`
- Update the implementation PR description after fresh verification.

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
src/lib/mp-poker/*
src/server/mp/multiplayer-poker-room.ts
MultiplayerPokerRoom
MULTIPLAYER_POKER_ROOMS
room-local chips; no D1 settlement
```

Remove old `Arcturus`, membership, snapshot, settlement, and internal-secret guidance.

- [ ] **Step 3: Run local reset and full verification**

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

- [ ] **Step 4: Run final residue and diff checks**

```bash
git diff --check main...HEAD

! git grep -E \
	'heldChips|mp_membership|mpMembership|MP_AUTH_SECRET|pendingLockReleases|pendingEscrowReleases|SETTLEMENT_FAILED|MULTIPLAYER_CONFLICT|MULTIPLAYER_ESCROW_ORPHANED' \
	-- src e2e scripts drizzle wrangler.toml README.md CLAUDE.md AGENTS.md

! git grep -E 'tournaments page|Invite friends for exclusive' -- src/pages/profile.astro
```

Confirm:

- no `src/modules` directory was introduced;
- projection and timer math live in `src/lib/mp-poker`;
- the Durable Object file exports only the room class;
- routes have no D1 imports;
- own-seat, active-seat, and showdown fields have visible page consumers;
- every hand-completing path uses the same transition finalizer;
- no old binding/class alias exists.

- [ ] **Step 5: Document the remote destructive reset**

Include in the implementation PR, but do not run during implementation review:

```bash
bunx wrangler d1 delete arcturus --skip-confirmation
bunx wrangler d1 create arcturus
# Copy returned database ID into wrangler.toml
bun run db:migrate:remote
bun run deploy
```

State that all hobby-stage account/game data and old rooms are discarded.

- [ ] **Step 6: Commit docs and final configuration adjustments**

```bash
git add -A src/pages/profile.astro docs README.md CLAUDE.md AGENTS.md \
	playwright.config.mp.ts
git commit -m 'docs(mp): finalize isolated room rollout'
```

- [ ] **Step 7: Update the implementation PR description**

Use:

```markdown
## Summary
- Replace multiplayer wallet escrow with 100-BB room-local stacks.
- Keep pure multiplayer code in `src/lib/mp-poker` and Worker runtime in `src/server/mp`.
- Add personalized own-seat and active-seat state plus contested-showdown rendering.
- Delete membership, settlement callbacks, Ranked exclusion, progression, and recovery machinery.
- Replace the old Durable Object namespace with SQLite-backed `MultiplayerPokerRoom`.
- Recreate D1 rather than migrate held chips or memberships.

## Verification
- `bun run test`
- `bun run lint`
- `bun run format:check`
- `bun run build`
- `bun run test:e2e:mp`
- normalized `tsc --noEmit` touched-path delta: no new errors

## Breaking reset
This hobby-stage release deletes and recreates the D1 database and invalidates all existing multiplayer rooms. No compatibility or data migration is provided.
```

---

## Plan self-review checklist

Before execution begins, confirm:

- [ ] Existing legality, side-pot, tie, runout, and odd-chip expectations are not silently changed.
- [ ] Every task ends with focused tests and build green.
- [ ] The representative E2E is restored in Task 2 and rerun after every high-risk task.
- [ ] Actions, disconnect folds, and turn-timeout folds share one transition finalizer.
- [ ] A timeout-ended hand clears a retained expired all-in winner after payout.
- [ ] `yourSeat` and `currentSeat` have visible page consumers.
- [ ] Contested showdown cards remain in the protocol and are rendered.
- [ ] Projection and timer helpers live in `src/lib/mp-poker`, not the Worker file.
- [ ] `MP_AUTH_SECRET` is deleted explicitly in Task 4.
- [ ] Schema deletion is followed immediately by the full test suite and normalized type-error comparison.
- [ ] The class/binding rename happens only in Task 7.
- [ ] `new_sqlite_classes` remains in the final migration.
- [ ] Exact local and remote reset commands are documented.
- [ ] No `src/modules`, barrel package, compatibility layer, or generic framework is introduced.
