# Multiplayer Poker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real-time multiplayer Texas Hold'em (private rooms, 2–6 seats) on top of the existing single-player poker, using Cloudflare Durable Objects + WebSockets.

**Architecture:** A new `Arcturus` Durable Object class is the authoritative session per room (one DO per room code). Clients connect via WebSocket, send actions, and receive state diffs. The DO holds in-memory game state, validates every action via a pure `MultiplayerPokerEngine`, and reaches D1 only at hand-start (snapshot main balances) and hand-end (settle deltas). Pure logic lives in `src/lib/mp-poker/` (Bun-testable); DO glue lives in `src/server/mp/` (Miniflare-testable). The full design lives in `docs/superpowers/specs/2026-05-08-multiplayer-poker-design.md`.

**Tech Stack:** Cloudflare Durable Objects (hibernatable WS), Astro SSR, Drizzle + D1, Better Auth (existing middleware), Zod (new — message schemas), Bun test runner, Wrangler `unstable_dev` for DO integration tests, Playwright (two browser contexts).

---

## File structure

| Status | Path                                    | Responsibility                                     |
| ------ | --------------------------------------- | -------------------------------------------------- |
| Create | `src/lib/mp-poker/roomCode.ts`          | Generate + validate `MP-XXXXXX` room codes         |
| Create | `src/lib/mp-poker/protocol.ts`          | Zod schemas + TS types for all WS messages         |
| Create | `src/lib/mp-poker/engine.ts`            | Pure poker state machine driven by network actions |
| Create | `src/lib/mp-poker/client.ts`            | Browser-side WS wrapper (no DOM)                   |
| Create | `src/server/mp/settlement.ts`           | Pure: build settle payload from hand result        |
| Create | `src/server/mp/arcturus.ts`             | DO class: WS, alarms, engine integration           |
| Create | `src/pages/api/mp/rooms/index.ts`       | `POST` create room                                 |
| Create | `src/pages/api/mp/rooms/[code].ts`      | `GET` metadata + WS upgrade proxy                  |
| Create | `src/pages/api/mp/lock.ts`              | `POST` acquire/release single-room lock            |
| Create | `src/pages/api/mp/snapshot.ts`          | `POST` DO callback: read balances                  |
| Create | `src/pages/api/mp/settle.ts`            | `POST` DO callback: apply deltas                   |
| Create | `src/pages/games/poker-mp/index.astro`  | Lobby (create/join)                                |
| Create | `src/pages/games/poker-mp/[code].astro` | Table UI                                           |
| Create | `e2e/multiplayer-poker.spec.ts`         | E2E happy path + reconnect                         |
| Modify | `src/db/schema.ts`                      | Add `mpMembership` table                           |
| Modify | `src/env.d.ts`                          | Add `arcturus` DO binding to `Env`                 |
| Modify | `wrangler.toml`                         | DO binding + migration                             |
| Modify | `src/pages/games/index.astro`           | Expose multiplayer poker card                      |
| Modify | `e2e/global-setup.ts`                   | Provision second test user                         |
| Modify | `package.json`                          | Add migration script for new SQL file              |

Plus a generated `drizzle/00XX_mp_membership.sql` migration.

---

## Phase A — Foundation

Pure logic and schema. Bun-testable, no DO dependencies.

### Task 1: Add `mpMembership` schema and migration

**Files:**

- Modify: `src/db/schema.ts`
- Create: `drizzle/00XX_mp_membership.sql` (number assigned by `db:generate`)
- Modify: `package.json` (add migration script reference)

- [ ] **Step 1: Add table definition**

Append to `src/db/schema.ts` (after existing tables):

```typescript
export const mpMembership = sqliteTable('mp_membership', {
	userId: text('userId')
		.primaryKey()
		.references(() => user.id, { onDelete: 'cascade' }),
	roomCode: text('roomCode').notNull(),
	joinedAt: integer('joinedAt', { mode: 'timestamp' }).notNull(),
});
```

- [ ] **Step 2: Generate migration**

Run: `bun run db:generate`
Expected: a new file in `drizzle/` named like `0009_mp_membership.sql` (number depends on existing migrations).

- [ ] **Step 3: Add migration script to package.json**

Modify `package.json`. Find the `"db:migrate:local"` and `"db:migrate:remote"` scripts and add a line invoking the new migration file (mirror the existing pattern for the most recent migration).

- [ ] **Step 4: Apply locally**

Run: `bun run db:migrate:local`
Expected: success message with the new SQL applied.

- [ ] **Step 5: Verify**

Run: `wrangler d1 execute arcturus-db --local --command="SELECT name FROM sqlite_master WHERE type='table' AND name='mp_membership'"`
Expected: returns one row with `name=mp_membership`.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts drizzle/ package.json
git commit -m "feat(mp): add mp_membership table for single-room lock"
```

---

### Task 2: Room code generator

**Files:**

- Create: `src/lib/mp-poker/roomCode.ts`
- Create: `src/lib/mp-poker/roomCode.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/lib/mp-poker/roomCode.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { generateRoomCode, isValidRoomCode } from './roomCode';

describe('roomCode', () => {
	test('generateRoomCode produces MP- prefix + 6 alphanumeric chars', () => {
		const code = generateRoomCode();
		expect(code).toMatch(/^MP-[A-Z0-9]{6}$/);
	});

	test('generateRoomCode produces different codes on consecutive calls', () => {
		const codes = new Set<string>();
		for (let i = 0; i < 100; i++) codes.add(generateRoomCode());
		expect(codes.size).toBe(100);
	});

	test('isValidRoomCode accepts well-formed codes', () => {
		expect(isValidRoomCode('MP-7HXK4Q')).toBe(true);
		expect(isValidRoomCode('MP-ABCDEF')).toBe(true);
	});

	test('isValidRoomCode rejects malformed codes', () => {
		expect(isValidRoomCode('mp-7hxk4q')).toBe(false); // lowercase
		expect(isValidRoomCode('MP-7HXK4')).toBe(false); // too short
		expect(isValidRoomCode('MP-7HXK4QZ')).toBe(false); // too long
		expect(isValidRoomCode('XX-7HXK4Q')).toBe(false); // wrong prefix
		expect(isValidRoomCode('MP_7HXK4Q')).toBe(false); // wrong separator
		expect(isValidRoomCode('')).toBe(false);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/lib/mp-poker/roomCode.test.ts`
Expected: FAIL with "Cannot find module './roomCode'".

- [ ] **Step 3: Implement**

Create `src/lib/mp-poker/roomCode.ts`:

```typescript
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const ROOM_CODE_REGEX = /^MP-[A-Z0-9]{6}$/;

export function generateRoomCode(): string {
	const bytes = new Uint8Array(6);
	crypto.getRandomValues(bytes);
	let suffix = '';
	for (let i = 0; i < 6; i++) {
		suffix += ALPHABET[bytes[i] % ALPHABET.length];
	}
	return `MP-${suffix}`;
}

export function isValidRoomCode(code: string): boolean {
	return ROOM_CODE_REGEX.test(code);
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/lib/mp-poker/roomCode.test.ts`
Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mp-poker/roomCode.ts src/lib/mp-poker/roomCode.test.ts
git commit -m "feat(mp): add room code generator and validator"
```

---

### Task 3: Wire protocol schemas (Zod)

**Files:**

- Create: `src/lib/mp-poker/protocol.ts`
- Create: `src/lib/mp-poker/protocol.test.ts`
- Modify: `package.json` (add `zod` dependency if not present)

- [ ] **Step 1: Ensure zod is a dependency**

Run: `grep '"zod"' package.json || bun add zod`

- [ ] **Step 2: Write failing tests**

Create `src/lib/mp-poker/protocol.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { ClientMessage, ServerMessage, PROTOCOL_VERSION, EMOTES } from './protocol';

describe('protocol', () => {
	test('PROTOCOL_VERSION is exported', () => {
		expect(typeof PROTOCOL_VERSION).toBe('number');
		expect(PROTOCOL_VERSION).toBeGreaterThan(0);
	});

	test('ClientMessage.parse accepts take_seat', () => {
		const msg = ClientMessage.parse({ type: 'take_seat', seatIndex: 2 });
		expect(msg.type).toBe('take_seat');
	});

	test('ClientMessage.parse accepts action raise with amount', () => {
		const msg = ClientMessage.parse({ type: 'action', action: 'raise', amount: 200 });
		expect(msg.type).toBe('action');
	});

	test('ClientMessage.parse rejects raise without amount', () => {
		expect(() => ClientMessage.parse({ type: 'action', action: 'raise' })).toThrow();
	});

	test('ClientMessage.parse rejects unknown emote ids', () => {
		expect(() => ClientMessage.parse({ type: 'emote', emoteId: 'not_a_real_emote' })).toThrow();
	});

	test('ServerMessage.parse accepts room_state', () => {
		const msg = ServerMessage.parse({
			type: 'room_state',
			phase: 'seating',
			seats: [],
			pot: 0,
			board: [],
			currentSeat: null,
			betToCall: 0,
			timeRemainingMs: 0,
		});
		expect(msg.type).toBe('room_state');
	});

	test('EMOTES is a non-empty fixed list', () => {
		expect(Array.isArray(EMOTES)).toBe(true);
		expect(EMOTES.length).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test src/lib/mp-poker/protocol.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 4: Implement protocol**

Create `src/lib/mp-poker/protocol.ts`:

```typescript
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const EMOTES = ['nice_hand', 'fold', 'call', 'good_game', 'thinking'] as const;
export type EmoteId = (typeof EMOTES)[number];

const CardSchema = z.object({
	value: z.string(),
	suit: z.enum(['hearts', 'diamonds', 'clubs', 'spades']),
	rank: z.number().int().min(2).max(14),
});

const SeatSchema = z.object({
	seatIndex: z.number().int().min(0).max(5),
	userId: z.string().nullable(),
	displayName: z.string().nullable(),
	chips: z.number().int().min(0),
	committed: z.number().int().min(0),
	folded: z.boolean(),
	allIn: z.boolean(),
	connected: z.boolean(),
	disconnectedAt: z.number().nullable(),
});

const PhaseSchema = z.enum(['idle', 'seating', 'in-hand', 'settling', 'frozen']);

// --- Client → server ---

const TakeSeat = z.object({
	type: z.literal('take_seat'),
	seatIndex: z.number().int().min(0).max(5),
});
const LeaveSeat = z.object({ type: z.literal('leave_seat') });
const StartHand = z.object({ type: z.literal('start_hand') });
const Action = z.discriminatedUnion('action', [
	z.object({ type: z.literal('action'), action: z.literal('fold') }),
	z.object({ type: z.literal('action'), action: z.literal('check') }),
	z.object({ type: z.literal('action'), action: z.literal('call') }),
	z.object({
		type: z.literal('action'),
		action: z.literal('bet'),
		amount: z.number().int().positive(),
	}),
	z.object({
		type: z.literal('action'),
		action: z.literal('raise'),
		amount: z.number().int().positive(),
	}),
	z.object({ type: z.literal('action'), action: z.literal('all_in') }),
]);
const Emote = z.object({ type: z.literal('emote'), emoteId: z.enum(EMOTES) });
const Pong = z.object({ type: z.literal('pong') });

export const ClientMessage = z.discriminatedUnion('type', [
	TakeSeat,
	LeaveSeat,
	StartHand,
	Action,
	Emote,
	Pong,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// --- Server → client ---

const RoomState = z.object({
	type: z.literal('room_state'),
	phase: PhaseSchema,
	seats: z.array(SeatSchema),
	pot: z.number().int().min(0),
	board: z.array(CardSchema),
	currentSeat: z.number().int().nullable(),
	betToCall: z.number().int().min(0),
	timeRemainingMs: z.number().int().min(0),
});
const StateDelta = z.object({ type: z.literal('state_delta'), patch: z.record(z.unknown()) });
const HandStarted = z.object({
	type: z.literal('hand_started'),
	dealerSeat: z.number().int(),
	holeCards: z.tuple([CardSchema, CardSchema]),
});
const HandEnded = z.object({
	type: z.literal('hand_ended'),
	winners: z.array(z.object({ seatIndex: z.number().int(), amount: z.number().int() })),
	pots: z.array(z.object({ amount: z.number().int(), eligibleSeats: z.array(z.number().int()) })),
	showdownCards: z.array(
		z.object({ seatIndex: z.number().int(), cards: z.tuple([CardSchema, CardSchema]) }),
	),
});
const HandAborted = z.object({ type: z.literal('hand_aborted'), reason: z.string() });
const EmoteReceived = z.object({
	type: z.literal('emote_received'),
	fromSeat: z.number().int(),
	emoteId: z.enum(EMOTES),
});
const ErrorMsg = z.object({
	type: z.literal('error'),
	code: z.enum([
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
	]),
	message: z.string(),
});
const Ping = z.object({ type: z.literal('ping') });
const Kicked = z.object({ type: z.literal('kicked'), reason: z.string() });

export const ServerMessage = z.discriminatedUnion('type', [
	RoomState,
	StateDelta,
	HandStarted,
	HandEnded,
	HandAborted,
	EmoteReceived,
	ErrorMsg,
	Ping,
	Kicked,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export type Seat = z.infer<typeof SeatSchema>;
export type Phase = z.infer<typeof PhaseSchema>;
```

- [ ] **Step 5: Run tests**

Run: `bun test src/lib/mp-poker/protocol.test.ts`
Expected: 7 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mp-poker/protocol.ts src/lib/mp-poker/protocol.test.ts package.json bun.lockb
git commit -m "feat(mp): add wire protocol schemas with Zod validation"
```

---

### Task 4: Pure poker engine — core state and dealing

This task scaffolds the engine. Subsequent tasks add betting, showdown, and settle integration.

**Files:**

- Create: `src/lib/mp-poker/engine.ts`
- Create: `src/lib/mp-poker/engine.test.ts`

- [ ] **Step 1: Write failing tests for room creation and seating**

Create `src/lib/mp-poker/engine.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { createRoom, takeSeat, leaveSeat, startHand } from './engine';

describe('engine — seating', () => {
	test('createRoom returns room in idle phase with correct config', () => {
		const room = createRoom({ maxSeats: 4, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		expect(room.phase).toBe('idle');
		expect(room.config.maxSeats).toBe(4);
		expect(room.config.smallBlind).toBe(5);
		expect(room.config.bigBlind).toBe(10);
		expect(room.seats.length).toBe(4);
		expect(room.seats.every((s) => s.userId === null)).toBe(true);
	});

	test('takeSeat seats a user and moves to seating phase', () => {
		let room = createRoom({ maxSeats: 4, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		expect(room.phase).toBe('seating');
		expect(room.seats[0].userId).toBe('u1');
		expect(room.seats[0].displayName).toBe('Alice');
	});

	test('takeSeat rejects already-occupied seat', () => {
		let room = createRoom({ maxSeats: 4, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		expect(() =>
			takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 0, mainBalance: 1000 }),
		).toThrow(/INVALID_SEAT/);
	});

	test('leaveSeat empties seat and returns to idle if last to leave', () => {
		let room = createRoom({ maxSeats: 4, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = leaveSeat(room, 'u1');
		expect(room.phase).toBe('idle');
		expect(room.seats[0].userId).toBeNull();
	});

	test('startHand requires at least 2 seated players', () => {
		let room = createRoom({ maxSeats: 4, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		expect(() => startHand(room, { snapshots: { u1: 1000 }, deckSeed: 'seed-x' })).toThrow();
	});

	test('startHand with 2 players posts blinds and deals 2 hole cards each', () => {
		let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		room = startHand(room, { snapshots: { u1: 1000, u2: 1000 }, deckSeed: 'seed-x' });
		expect(room.phase).toBe('in-hand');
		expect(room.hand).not.toBeNull();
		expect(room.hand!.bettingRound).toBe('preflop');
		// Both players got 2 cards
		expect(room.hand!.holeCards.u1.length).toBe(2);
		expect(room.hand!.holeCards.u2.length).toBe(2);
		// Blinds posted
		expect(room.hand!.committed.u1 + room.hand!.committed.u2).toBe(15);
	});
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test src/lib/mp-poker/engine.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement engine core**

Create `src/lib/mp-poker/engine.ts`:

```typescript
import type { Card } from '../poker/types';

export interface RoomConfig {
	maxSeats: number;
	smallBlind: number;
	bigBlind: number;
	hostUserId: string;
}

export interface SeatState {
	seatIndex: number;
	userId: string | null;
	displayName: string | null;
	mainBalance: number; // last known, only used at hand start
	connected: boolean;
	disconnectedAt: number | null;
}

export interface HandState {
	bettingRound: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
	dealerSeat: number;
	currentSeat: number;
	deck: Card[];
	board: Card[];
	holeCards: Record<string, Card[]>; // userId → 2 cards
	committed: Record<string, number>; // userId → chips into pot this hand
	currentBet: number; // amount needed to call this round
	lastRaiseAmount: number;
	folded: Set<string>;
	allIn: Set<string>;
	hasActed: Set<string>;
	handStacks: Record<string, number>; // userId → snapshot at hand start
}

export interface Room {
	config: RoomConfig;
	phase: 'idle' | 'seating' | 'in-hand' | 'settling' | 'frozen';
	seats: SeatState[];
	hand: HandState | null;
	handLog: HandLogEntry[]; // capped at 20
}

export interface HandLogEntry {
	endedAt: number;
	winners: { seatIndex: number; amount: number }[];
}

export class EngineError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export function createRoom(config: RoomConfig): Room {
	if (config.maxSeats < 2 || config.maxSeats > 6) {
		throw new EngineError('INVALID_CONFIG', 'maxSeats must be 2-6');
	}
	const seats: SeatState[] = [];
	for (let i = 0; i < config.maxSeats; i++) {
		seats.push({
			seatIndex: i,
			userId: null,
			displayName: null,
			mainBalance: 0,
			connected: false,
			disconnectedAt: null,
		});
	}
	return { config, phase: 'idle', seats, hand: null, handLog: [] };
}

export function takeSeat(
	room: Room,
	args: { userId: string; displayName: string; seatIndex: number; mainBalance: number },
): Room {
	const { userId, displayName, seatIndex, mainBalance } = args;
	if (seatIndex < 0 || seatIndex >= room.seats.length) {
		throw new EngineError('INVALID_SEAT', 'seat out of range');
	}
	if (room.seats[seatIndex].userId !== null) {
		throw new EngineError('INVALID_SEAT', 'seat occupied');
	}
	if (room.seats.some((s) => s.userId === userId)) {
		throw new EngineError('INVALID_SEAT', 'user already seated');
	}
	const seats = room.seats.map((s, i) =>
		i === seatIndex
			? { ...s, userId, displayName, mainBalance, connected: true, disconnectedAt: null }
			: s,
	);
	return { ...room, phase: 'seating', seats };
}

export function leaveSeat(room: Room, userId: string): Room {
	const seats = room.seats.map((s) =>
		s.userId === userId
			? { ...s, userId: null, displayName: null, connected: false, disconnectedAt: null }
			: s,
	);
	const anyOccupied = seats.some((s) => s.userId !== null);
	return {
		...room,
		phase: anyOccupied ? room.phase : 'idle',
		seats,
	};
}

function shuffleDeck(seed: string): Card[] {
	const SUITS: Card['suit'][] = ['hearts', 'diamonds', 'clubs', 'spades'];
	const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
	const deck: Card[] = [];
	for (const suit of SUITS) {
		for (let i = 0; i < VALUES.length; i++) {
			deck.push({ value: VALUES[i], suit, rank: i + 2 });
		}
	}
	// Deterministic Fisher-Yates from seed (xmur3 + sfc32)
	let h = 1779033703 ^ seed.length;
	for (let i = 0; i < seed.length; i++) {
		h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
		h = (h << 13) | (h >>> 19);
	}
	let a = h ^ 0x9e3779b9,
		b = h ^ 0x243f6a88,
		c = h ^ 0xb7e15162,
		d = h ^ 0xdeadbeef;
	const rng = () => {
		const t = (a + b) | 0;
		a = b ^ (b >>> 9);
		b = (c + (c << 3)) | 0;
		c = (c << 21) | (c >>> 11);
		d = (d + 1) | 0;
		const r = (t + d) | 0;
		return (r >>> 0) / 4294967296;
	};
	for (let i = deck.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[deck[i], deck[j]] = [deck[j], deck[i]];
	}
	return deck;
}

export function startHand(
	room: Room,
	args: { snapshots: Record<string, number>; deckSeed: string },
): Room {
	const seated = room.seats.filter((s) => s.userId !== null);
	if (seated.length < 2) {
		throw new EngineError('NOT_ENOUGH_PLAYERS', 'need at least 2 seated players');
	}
	// Players with balance below big blind sit out this hand
	const eligible = seated.filter((s) => (args.snapshots[s.userId!] ?? 0) >= room.config.bigBlind);
	if (eligible.length < 2) {
		throw new EngineError('NOT_ENOUGH_PLAYERS', 'fewer than 2 players can post big blind');
	}

	const deck = shuffleDeck(args.deckSeed);
	const holeCards: Record<string, Card[]> = {};
	const handStacks: Record<string, number> = {};
	const committed: Record<string, number> = {};

	// Deal 2 cards each in seat order
	let cursor = 0;
	for (const seat of eligible) {
		holeCards[seat.userId!] = [deck[cursor], deck[cursor + 1]];
		cursor += 2;
		handStacks[seat.userId!] = args.snapshots[seat.userId!];
		committed[seat.userId!] = 0;
	}

	// Determine dealer (rotate through eligible if a hand was played; else first eligible)
	const lastDealerIndex = room.hand?.dealerSeat ?? -1;
	const eligibleIndices = eligible.map((s) => s.seatIndex);
	const nextDealerIdx = eligibleIndices.find((i) => i > lastDealerIndex) ?? eligibleIndices[0];
	const dealerSeat = nextDealerIdx;

	// Heads-up: dealer is small blind, other is big blind
	// 3+: small blind is next after dealer
	let sbSeat: number, bbSeat: number;
	const eligibleSorted = [...eligibleIndices].sort((a, b) => a - b);
	if (eligibleSorted.length === 2) {
		sbSeat = dealerSeat;
		bbSeat = eligibleSorted.find((i) => i !== dealerSeat)!;
	} else {
		const dealerPos = eligibleSorted.indexOf(dealerSeat);
		sbSeat = eligibleSorted[(dealerPos + 1) % eligibleSorted.length];
		bbSeat = eligibleSorted[(dealerPos + 2) % eligibleSorted.length];
	}
	const sbUser = room.seats[sbSeat].userId!;
	const bbUser = room.seats[bbSeat].userId!;
	committed[sbUser] = Math.min(room.config.smallBlind, handStacks[sbUser]);
	committed[bbUser] = Math.min(room.config.bigBlind, handStacks[bbUser]);

	// First to act preflop: heads-up = SB (dealer), 3+ = seat after BB
	let currentSeat: number;
	if (eligibleSorted.length === 2) {
		currentSeat = sbSeat;
	} else {
		const bbPos = eligibleSorted.indexOf(bbSeat);
		currentSeat = eligibleSorted[(bbPos + 1) % eligibleSorted.length];
	}

	const hand: HandState = {
		bettingRound: 'preflop',
		dealerSeat,
		currentSeat,
		deck: deck.slice(cursor),
		board: [],
		holeCards,
		committed,
		currentBet: room.config.bigBlind,
		lastRaiseAmount: room.config.bigBlind,
		folded: new Set(),
		allIn: new Set(
			Object.entries(committed)
				.filter(([uid, c]) => c >= handStacks[uid])
				.map(([uid]) => uid),
		),
		hasActed: new Set(),
		handStacks,
	};

	return { ...room, phase: 'in-hand', hand };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/lib/mp-poker/engine.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mp-poker/engine.ts src/lib/mp-poker/engine.test.ts
git commit -m "feat(mp): pure engine — room lifecycle, seating, hand start"
```

---

### Task 5: Engine — betting actions and round progression

**Files:**

- Modify: `src/lib/mp-poker/engine.ts`
- Modify: `src/lib/mp-poker/engine.test.ts`

- [ ] **Step 1: Append failing tests**

Add to `src/lib/mp-poker/engine.test.ts`:

```typescript
import { applyAction } from './engine';

describe('engine — betting', () => {
	function setupHand() {
		let room = createRoom({ maxSeats: 2, smallBlind: 5, bigBlind: 10, hostUserId: 'u1' });
		room = takeSeat(room, { userId: 'u1', displayName: 'Alice', seatIndex: 0, mainBalance: 1000 });
		room = takeSeat(room, { userId: 'u2', displayName: 'Bob', seatIndex: 1, mainBalance: 1000 });
		return startHand(room, { snapshots: { u1: 1000, u2: 1000 }, deckSeed: 'seed-x' });
	}

	test('fold ends hand if only one player remains', () => {
		const room = setupHand();
		const after = applyAction(room, 'u1', { action: 'fold' });
		expect(after.phase).toBe('settling');
		// u2 wins the pot (15 chips: SB 5 + BB 10)
		expect(after.handLog[after.handLog.length - 1].winners[0].seatIndex).toBe(1);
	});

	test('call advances betting round when action closes', () => {
		const room = setupHand();
		// Heads-up: SB acts first preflop, calls, BB checks, advances to flop
		const r1 = applyAction(room, 'u1', { action: 'call' });
		expect(r1.hand!.bettingRound).toBe('preflop'); // BB still to act
		const r2 = applyAction(r1, 'u2', { action: 'check' });
		expect(r2.hand!.bettingRound).toBe('flop');
		expect(r2.hand!.board.length).toBe(3);
	});

	test('raise must be at least min-raise', () => {
		const room = setupHand();
		expect(() => applyAction(room, 'u1', { action: 'raise', amount: 11 })).toThrow();
	});

	test('rejects action when not your turn', () => {
		const room = setupHand();
		expect(() => applyAction(room, 'u2', { action: 'call' })).toThrow(/NOT_YOUR_TURN/);
	});

	test('full hand to showdown produces hand_log entry', () => {
		const room = setupHand();
		let r = applyAction(room, 'u1', { action: 'call' });
		r = applyAction(r, 'u2', { action: 'check' });
		// flop
		r = applyAction(r, 'u2', { action: 'check' });
		r = applyAction(r, 'u1', { action: 'check' });
		// turn
		r = applyAction(r, 'u2', { action: 'check' });
		r = applyAction(r, 'u1', { action: 'check' });
		// river
		r = applyAction(r, 'u2', { action: 'check' });
		r = applyAction(r, 'u1', { action: 'check' });
		expect(r.phase).toBe('settling');
		expect(r.handLog.length).toBe(1);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/lib/mp-poker/engine.test.ts`
Expected: FAIL with `applyAction is not exported`.

- [ ] **Step 3: Implement applyAction**

Append to `src/lib/mp-poker/engine.ts`:

```typescript
import { evaluateBest5OutOf7 } from '../poker/handEvaluator';
// NOTE: if handEvaluator does not export this exact name, adjust the import to whatever
// pure 7-card evaluator exists; otherwise create a thin wrapper.

export type ActionInput =
	| { action: 'fold' }
	| { action: 'check' }
	| { action: 'call' }
	| { action: 'bet'; amount: number }
	| { action: 'raise'; amount: number }
	| { action: 'all_in' };

export function applyAction(room: Room, userId: string, input: ActionInput): Room {
	if (room.phase !== 'in-hand' || !room.hand) {
		throw new EngineError('INVALID_ACTION', 'not in hand');
	}
	const hand = room.hand;
	const seat = room.seats[hand.currentSeat];
	if (seat.userId !== userId) {
		throw new EngineError('NOT_YOUR_TURN', 'not your turn');
	}

	const stack = hand.handStacks[userId];
	const committed = hand.committed[userId];
	const remaining = stack - committed;
	const toCall = hand.currentBet - committed;

	const newCommitted = { ...hand.committed };
	const newFolded = new Set(hand.folded);
	const newAllIn = new Set(hand.allIn);
	const newHasActed = new Set(hand.hasActed);
	let newBet = hand.currentBet;
	let newLastRaise = hand.lastRaiseAmount;

	switch (input.action) {
		case 'fold':
			newFolded.add(userId);
			break;
		case 'check':
			if (toCall > 0) throw new EngineError('INVALID_ACTION', 'cannot check facing a bet');
			break;
		case 'call': {
			const pay = Math.min(toCall, remaining);
			newCommitted[userId] = committed + pay;
			if (pay === remaining) newAllIn.add(userId);
			break;
		}
		case 'bet':
		case 'raise': {
			const target = input.amount;
			if (target <= hand.currentBet)
				throw new EngineError('INVALID_ACTION', 'raise must exceed current bet');
			const minRaise = hand.currentBet + hand.lastRaiseAmount;
			if (target < minRaise && target - committed < remaining)
				throw new EngineError('INVALID_ACTION', 'raise below min-raise');
			const pay = Math.min(target - committed, remaining);
			newCommitted[userId] = committed + pay;
			if (pay === remaining) newAllIn.add(userId);
			newLastRaise = target - hand.currentBet;
			newBet = newCommitted[userId];
			// Reopen action for everyone else
			for (const s of room.seats) {
				if (
					s.userId &&
					s.userId !== userId &&
					!newFolded.has(s.userId) &&
					!newAllIn.has(s.userId)
				) {
					newHasActed.delete(s.userId);
				}
			}
			break;
		}
		case 'all_in': {
			const pay = remaining;
			newCommitted[userId] = committed + pay;
			newAllIn.add(userId);
			if (newCommitted[userId] > hand.currentBet) {
				newLastRaise = newCommitted[userId] - hand.currentBet;
				newBet = newCommitted[userId];
				for (const s of room.seats) {
					if (
						s.userId &&
						s.userId !== userId &&
						!newFolded.has(s.userId) &&
						!newAllIn.has(s.userId)
					) {
						newHasActed.delete(s.userId);
					}
				}
			}
			break;
		}
	}
	newHasActed.add(userId);

	const updatedHand: HandState = {
		...hand,
		committed: newCommitted,
		folded: newFolded,
		allIn: newAllIn,
		hasActed: newHasActed,
		currentBet: newBet,
		lastRaiseAmount: newLastRaise,
	};

	// Hand-end check: only one not folded
	const remainingSeats = room.seats.filter((s) => s.userId && !newFolded.has(s.userId));
	if (remainingSeats.length === 1) {
		return finishHand({ ...room, hand: updatedHand }, 'fold-out');
	}

	// Round-end check: all non-folded, non-allIn have acted AND matched currentBet
	const stillToAct = room.seats.filter(
		(s) =>
			s.userId &&
			!newFolded.has(s.userId) &&
			!newAllIn.has(s.userId) &&
			(!newHasActed.has(s.userId) || newCommitted[s.userId] < newBet),
	);
	if (stillToAct.length === 0) {
		return advanceRound({ ...room, hand: updatedHand });
	}

	// Otherwise: advance to next active seat
	const nextSeat = nextActiveSeat(room, updatedHand);
	return { ...room, hand: { ...updatedHand, currentSeat: nextSeat } };
}

function nextActiveSeat(room: Room, hand: HandState): number {
	const n = room.seats.length;
	let i = hand.currentSeat;
	for (let step = 0; step < n; step++) {
		i = (i + 1) % n;
		const seat = room.seats[i];
		if (seat.userId && !hand.folded.has(seat.userId) && !hand.allIn.has(seat.userId)) {
			return i;
		}
	}
	return hand.currentSeat;
}

function advanceRound(room: Room): Room {
	const hand = room.hand!;
	let board = hand.board;
	let nextRound: HandState['bettingRound'];
	let deck = hand.deck;
	switch (hand.bettingRound) {
		case 'preflop':
			board = [...board, deck[0], deck[1], deck[2]];
			deck = deck.slice(3);
			nextRound = 'flop';
			break;
		case 'flop':
			board = [...board, deck[0]];
			deck = deck.slice(1);
			nextRound = 'turn';
			break;
		case 'turn':
			board = [...board, deck[0]];
			deck = deck.slice(1);
			nextRound = 'river';
			break;
		case 'river':
			return finishHand(room, 'showdown');
		default:
			return room;
	}
	// First to act post-flop: first active seat after dealer
	const eligibleIndices = room.seats
		.filter((s) => s.userId && !hand.folded.has(s.userId) && !hand.allIn.has(s.userId))
		.map((s) => s.seatIndex)
		.sort((a, b) => a - b);
	const dealerPos = eligibleIndices.findIndex((i) => i > hand.dealerSeat);
	const firstSeat = dealerPos === -1 ? eligibleIndices[0] : eligibleIndices[dealerPos];
	return {
		...room,
		hand: {
			...hand,
			board,
			deck,
			bettingRound: nextRound,
			currentBet: 0,
			lastRaiseAmount: room.config.bigBlind,
			hasActed: new Set(),
			currentSeat: firstSeat ?? hand.currentSeat,
		},
	};
}

function finishHand(room: Room, _reason: 'fold-out' | 'showdown'): Room {
	const hand = room.hand!;
	// Compute winners. For fold-out, sole non-folded wins entire pot.
	// For showdown, evaluate hands and split pot accordingly.
	const totalPot = Object.values(hand.committed).reduce((a, b) => a + b, 0);
	const remaining = room.seats.filter((s) => s.userId && !hand.folded.has(s.userId));
	let winners: { seatIndex: number; amount: number }[];
	if (remaining.length === 1) {
		winners = [{ seatIndex: remaining[0].seatIndex, amount: totalPot }];
	} else {
		// Showdown via existing evaluator. Each player gets their best 5 of 7 (hole + board).
		// NOTE: for v1 we ignore side pots in finishHand and simply award the whole pot to the
		// best hand. Side-pot integration with potCalculator is a follow-up task.
		let bestRank = -1;
		let bestSeats: number[] = [];
		for (const s of remaining) {
			const hole = hand.holeCards[s.userId!];
			const evalResult = evaluateBest5OutOf7([...hole, ...hand.board]);
			if (evalResult.rank > bestRank) {
				bestRank = evalResult.rank;
				bestSeats = [s.seatIndex];
			} else if (evalResult.rank === bestRank) {
				bestSeats.push(s.seatIndex);
			}
		}
		const split = Math.floor(totalPot / bestSeats.length);
		winners = bestSeats.map((seatIndex) => ({ seatIndex, amount: split }));
	}

	const newLog = [...room.handLog, { endedAt: Date.now(), winners }].slice(-20);

	return {
		...room,
		phase: 'settling',
		hand: { ...hand, bettingRound: 'showdown' },
		handLog: newLog,
	};
}
```

> **Note for engineer:** `evaluateBest5OutOf7` may not exist by that exact name in `src/lib/poker/handEvaluator.ts`. Inspect the file first. If only `evaluatePreflopHand` and similar exist, write a thin pure helper inside `engine.ts` that takes 7 cards and returns a comparable rank by reusing whatever ranking primitives are available. The test suite drives this — make the failing test pass, don't fabricate API.

- [ ] **Step 4: Run tests**

Run: `bun test src/lib/mp-poker/engine.test.ts`
Expected: 11 tests pass total (6 from Task 4 + 5 here). If `evaluateBest5OutOf7` import is wrong, fix per the note above.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mp-poker/engine.ts src/lib/mp-poker/engine.test.ts
git commit -m "feat(mp): engine betting actions, round progression, fold-out resolution"
```

---

### Task 6: Settlement payload builder

**Files:**

- Create: `src/server/mp/settlement.ts`
- Create: `src/server/mp/settlement.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/server/mp/settlement.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { buildSettlePayload } from './settlement';

describe('buildSettlePayload', () => {
	test('builds deltas: winnings minus committed for each player', () => {
		const payload = buildSettlePayload({
			roomCode: 'MP-AAA111',
			handId: 'h-1',
			committed: { u1: 100, u2: 100 },
			winners: [{ userId: 'u2', amount: 200 }],
		});
		expect(payload.entries).toEqual([
			expect.objectContaining({ userId: 'u1', delta: -100 }),
			expect.objectContaining({ userId: 'u2', delta: 100 }),
		]);
		// syncIds are deterministic per room+hand+user
		expect(payload.entries[0].syncId).toBe('mp-poker:MP-AAA111:h-1:u1');
		expect(payload.entries[1].syncId).toBe('mp-poker:MP-AAA111:h-1:u2');
	});

	test('zero deltas omitted', () => {
		const payload = buildSettlePayload({
			roomCode: 'MP-BBB222',
			handId: 'h-2',
			committed: { u1: 0, u2: 100 },
			winners: [{ userId: 'u2', amount: 100 }],
		});
		expect(payload.entries.length).toBe(1);
		expect(payload.entries[0].userId).toBe('u2');
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/server/mp/settlement.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement**

Create `src/server/mp/settlement.ts`:

```typescript
export interface SettleEntry {
	userId: string;
	delta: number;
	syncId: string;
	gameType: 'poker_mp';
}

export interface SettlePayload {
	entries: SettleEntry[];
}

export function buildSettlePayload(args: {
	roomCode: string;
	handId: string;
	committed: Record<string, number>;
	winners: { userId: string; amount: number }[];
}): SettlePayload {
	const winById = new Map(args.winners.map((w) => [w.userId, w.amount]));
	const entries: SettleEntry[] = [];
	for (const [userId, paid] of Object.entries(args.committed)) {
		const won = winById.get(userId) ?? 0;
		const delta = won - paid;
		if (delta === 0) continue;
		entries.push({
			userId,
			delta,
			syncId: `mp-poker:${args.roomCode}:${args.handId}:${userId}`,
			gameType: 'poker_mp',
		});
	}
	return { entries };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/server/mp/settlement.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/mp/settlement.ts src/server/mp/settlement.test.ts
git commit -m "feat(mp): settlement payload builder with deterministic syncIds"
```

---

## Phase B — Cloudflare bindings + Durable Object

### Task 7: Wire up `arcturus` DO binding

**Files:**

- Modify: `wrangler.toml`
- Modify: `src/env.d.ts`

- [ ] **Step 1: Add DO binding to wrangler.toml**

Append to `wrangler.toml`:

```toml
[[durable_objects.bindings]]
name = "arcturus"
class_name = "Arcturus"

[[migrations]]
tag = "v1"
new_classes = ["Arcturus"]
```

- [ ] **Step 2: Update Env interface**

In `src/env.d.ts`, replace the `Env` block:

```typescript
interface Env {
	DB: D1Database;
	BETTER_AUTH_SECRET?: string;
	arcturus: DurableObjectNamespace;
}
```

- [ ] **Step 3: Verify type-check passes**

Run: `bunx tsc --noEmit`
Expected: no new type errors related to `arcturus` binding (errors elsewhere are out of scope).

- [ ] **Step 4: Commit**

```bash
git add wrangler.toml src/env.d.ts
git commit -m "feat(mp): wire arcturus DO binding in wrangler and env types"
```

---

### Task 8: `Arcturus` DO — connection scaffolding

This task ships a minimal DO that accepts WebSockets, validates the room exists, and broadcasts a `room_state` snapshot. No game logic yet.

**Files:**

- Create: `src/server/mp/arcturus.ts`

- [ ] **Step 1: Implement DO scaffold**

Create `src/server/mp/arcturus.ts`:

```typescript
import { ClientMessage, ServerMessage, type Seat, type Phase } from '../../lib/mp-poker/protocol';
import {
	createRoom,
	takeSeat,
	leaveSeat,
	startHand,
	applyAction,
	EngineError,
	type Room,
	type RoomConfig,
} from '../../lib/mp-poker/engine';
import { buildSettlePayload } from './settlement';

interface InitRequest {
	maxSeats: number;
	smallBlind: number;
	bigBlind: number;
	hostUserId: string;
	roomCode: string;
}

interface PersistedState {
	room: Room;
	roomCode: string;
	doSecret: string; // for X-Arcturus-Auth callbacks
}

export class Arcturus implements DurableObject {
	private state: DurableObjectState;
	private env: Env;
	private room: Room | null = null;
	private roomCode: string | null = null;
	private doSecret: string | null = null;
	private sockets = new Map<WebSocket, { userId: string; displayName: string }>();
	private currentHandId = 0;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
		this.state.blockConcurrencyWhile(async () => {
			const persisted = await this.state.storage.get<PersistedState>('persisted');
			if (persisted) {
				this.room = persisted.room;
				this.roomCode = persisted.roomCode;
				this.doSecret = persisted.doSecret;
			}
		});
	}

	async fetch(request: Request): Promise<Response> {
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
		this.room = createRoom(config);
		this.roomCode = body.roomCode;
		this.doSecret = crypto.randomUUID();
		await this.persist();
		return Response.json({ ok: true, doSecret: this.doSecret });
	}

	private async handleMetadata(): Promise<Response> {
		if (!this.room) return Response.json({ error: 'ROOM_NOT_FOUND' }, { status: 404 });
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
		const displayName = request.headers.get('x-arcturus-display-name');
		if (!userId || !displayName) return new Response('Missing identity headers', { status: 401 });

		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Expected websocket', { status: 426 });
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.state.acceptWebSocket(server);
		this.sockets.set(server, { userId, displayName });

		// Mark seat connected if user is seated
		if (this.room) {
			const seats = this.room.seats.map((s) =>
				s.userId === userId ? { ...s, connected: true, disconnectedAt: null } : s,
			);
			this.room = { ...this.room, seats };
			await this.persist();
		}

		this.send(server, this.makeRoomStateMessage());
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const identity = this.sockets.get(ws);
		if (!identity || !this.room) {
			this.send(ws, { type: 'error', code: 'NOT_A_MEMBER', message: 'unknown socket' });
			ws.close(1008, 'unknown socket');
			return;
		}
		let parsed;
		try {
			parsed = ClientMessage.parse(
				JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)),
			);
		} catch {
			this.send(ws, { type: 'error', code: 'BAD_MESSAGE', message: 'invalid message' });
			return;
		}

		try {
			switch (parsed.type) {
				case 'take_seat':
					this.room = takeSeat(this.room, {
						userId: identity.userId,
						displayName: identity.displayName,
						seatIndex: parsed.seatIndex,
						mainBalance: 0, // updated at hand start via snapshot
					});
					await this.persist();
					this.broadcastRoomState();
					break;
				case 'leave_seat':
					this.room = leaveSeat(this.room, identity.userId);
					await this.persist();
					this.broadcastRoomState();
					break;
				case 'start_hand': {
					if (this.room.config.hostUserId !== identity.userId) {
						this.send(ws, { type: 'error', code: 'INVALID_ACTION', message: 'host only' });
						return;
					}
					const seated = this.room.seats.filter((s) => s.userId !== null).map((s) => s.userId!);
					const snapshots = await this.fetchSnapshot(seated);
					const handId = `${this.roomCode}-${++this.currentHandId}`;
					this.room = startHand(this.room, { snapshots, deckSeed: handId });
					await this.persist();
					this.broadcastHandStarted();
					break;
				}
				case 'action':
					this.room = applyAction(this.room, identity.userId, parsed);
					await this.persist();
					if (this.room.phase === 'settling') {
						await this.runSettlement();
					}
					this.broadcastRoomState();
					break;
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
					code: err.code as ServerMessage['code'] extends never ? never : 'INVALID_ACTION',
					message: err.message,
				} as ServerMessage);
			} else {
				this.send(ws, { type: 'error', code: 'BAD_MESSAGE', message: 'internal error' });
			}
		}
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		const identity = this.sockets.get(ws);
		this.sockets.delete(ws);
		if (!identity || !this.room) return;
		// Mark disconnected, start 30s alarm
		const seats = this.room.seats.map((s) =>
			s.userId === identity.userId ? { ...s, connected: false, disconnectedAt: Date.now() } : s,
		);
		this.room = { ...this.room, seats };
		await this.persist();
		await this.scheduleNextAlarm();
		this.broadcastRoomState();
	}

	async alarm(): Promise<void> {
		if (!this.room) return;
		const now = Date.now();
		// Fire any seat whose disconnectedAt + 30s has elapsed
		let mutated = false;
		const seats = this.room.seats.map((s) => {
			if (s.userId && s.disconnectedAt !== null && now - s.disconnectedAt >= 30_000) {
				mutated = true;
				return { ...s, userId: null, displayName: null, disconnectedAt: null, connected: false };
			}
			return s;
		});
		if (mutated) {
			this.room = { ...this.room, seats };
			await this.persist();
			this.broadcastRoomState();
		}
		await this.scheduleNextAlarm();
	}

	private async scheduleNextAlarm(): Promise<void> {
		if (!this.room) return;
		let earliest: number | null = null;
		for (const s of this.room.seats) {
			if (s.disconnectedAt !== null) {
				const fireAt = s.disconnectedAt + 30_000;
				if (earliest === null || fireAt < earliest) earliest = fireAt;
			}
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

	private broadcastEmote(fromUserId: string, emoteId: (typeof EMOTES_LIST)[number]): void {
		if (!this.room) return;
		const seat = this.room.seats.find((s) => s.userId === fromUserId);
		if (!seat) return;
		this.broadcast({ type: 'emote_received', fromSeat: seat.seatIndex, emoteId });
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
					? Math.max(0, r.hand.handStacks[s.userId] - r.hand.committed[s.userId])
					: 0,
			committed: s.userId && r.hand ? (r.hand.committed[s.userId] ?? 0) : 0,
			folded: s.userId && r.hand ? r.hand.folded.has(s.userId) : false,
			allIn: s.userId && r.hand ? r.hand.allIn.has(s.userId) : false,
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
		const url = new URL(this.env.WORKER_ORIGIN ?? 'http://localhost');
		url.pathname = '/api/mp/snapshot';
		const res = await fetch(url.toString(), {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-arcturus-auth': this.doSecret ?? '',
			},
			body: JSON.stringify({ userIds, roomCode: this.roomCode }),
		});
		if (!res.ok) throw new Error(`snapshot failed: ${res.status}`);
		const json = (await res.json()) as { balances: Record<string, number> };
		return json.balances;
	}

	private async runSettlement(): Promise<void> {
		if (!this.room?.hand) return;
		const handId = `${this.roomCode}-${this.currentHandId}`;
		const lastWinners = this.room.handLog[this.room.handLog.length - 1]?.winners ?? [];
		const winnersByUserId = lastWinners.map((w) => ({
			userId: this.room!.seats[w.seatIndex].userId!,
			amount: w.amount,
		}));
		const payload = buildSettlePayload({
			roomCode: this.roomCode!,
			handId,
			committed: this.room.hand.committed,
			winners: winnersByUserId,
		});

		let attempts = 0;
		while (attempts < 3) {
			attempts++;
			try {
				const url = new URL(this.env.WORKER_ORIGIN ?? 'http://localhost');
				url.pathname = '/api/mp/settle';
				const res = await fetch(url.toString(), {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-arcturus-auth': this.doSecret ?? '',
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
		// Final failure
		this.room = { ...this.room, phase: 'frozen' };
		await this.persist();
		this.broadcast({
			type: 'error',
			code: 'SETTLEMENT_FAILED',
			message: 'D1 settlement failed after retries',
		});
	}

	private async persist(): Promise<void> {
		await this.state.storage.put<PersistedState>('persisted', {
			room: this.room!,
			roomCode: this.roomCode!,
			doSecret: this.doSecret!,
		});
	}
}

const EMOTES_LIST = ['nice_hand', 'fold', 'call', 'good_game', 'thinking'] as const;
```

> **Engineer notes:**
>
> - The DO references `this.env.WORKER_ORIGIN`. Add `WORKER_ORIGIN: string` to `Env` in `src/env.d.ts` and to `wrangler.toml` `[vars]` (set to `"http://localhost:2000"` locally; production set via `wrangler secret put` or `[env.production].vars`).
> - The error code cast in `webSocketMessage` is sloppy; tighten it by mapping `EngineError.code` to known codes explicitly (`NOT_YOUR_TURN`, `INVALID_SEAT`, `INVALID_ACTION`, etc.).
> - `Sets` are not JSON-serializable. The `persist()` call will lose `folded`/`allIn`/`hasActed`. **Convert to arrays before persisting and rebuild on load.** Add this fix as you implement, or split into a follow-up commit.

- [ ] **Step 2: Add `WORKER_ORIGIN` to env**

Modify `src/env.d.ts`:

```typescript
interface Env {
	DB: D1Database;
	BETTER_AUTH_SECRET?: string;
	arcturus: DurableObjectNamespace;
	WORKER_ORIGIN?: string;
}
```

Modify `wrangler.toml`, add at top-level:

```toml
[vars]
WORKER_ORIGIN = "http://localhost:2000"
```

- [ ] **Step 3: Fix Set serialization**

`Set` is not JSON-serializable, so the persisted DO state would lose `folded`, `allIn`, `hasActed`. Replace `persist()` and the constructor's load block in `src/server/mp/arcturus.ts` with array-based serialization:

```typescript
type PersistedHand = Omit<HandState, 'folded' | 'allIn' | 'hasActed'> & {
	folded: string[];
	allIn: string[];
	hasActed: string[];
};
type PersistedRoom = Omit<Room, 'hand'> & { hand: PersistedHand | null };

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
```

Then update `persist()`:

```typescript
private async persist(): Promise<void> {
	await this.state.storage.put('persisted', {
		room: roomToPersisted(this.room!),
		roomCode: this.roomCode!,
		doSecret: this.doSecret!,
	});
}
```

And the constructor's load block:

```typescript
const persisted = await this.state.storage.get<{
	room: PersistedRoom;
	roomCode: string;
	doSecret: string;
}>('persisted');
if (persisted) {
	this.room = persistedToRoom(persisted.room);
	this.roomCode = persisted.roomCode;
	this.doSecret = persisted.doSecret;
}
```

Adjust the `PersistedState` interface accordingly (or remove it in favor of an inline type).

- [ ] **Step 4: Build to catch type errors**

Run: `bun run build`
Expected: build succeeds. Fix any TS errors revealed.

- [ ] **Step 5: Commit**

```bash
git add src/server/mp/arcturus.ts src/env.d.ts wrangler.toml
git commit -m "feat(mp): scaffold Arcturus DO with WS handlers, alarms, settle retry"
```

---

### Task 9: DO integration test (Miniflare)

**Files:**

- Create: `src/server/mp/arcturus.integration.test.ts`

- [ ] **Step 1: Write integration test**

Create `src/server/mp/arcturus.integration.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { unstable_dev, type UnstableDevWorker } from 'wrangler';

let worker: UnstableDevWorker;

beforeAll(async () => {
	worker = await unstable_dev('src/server/mp/arcturus.ts', {
		experimental: { disableExperimentalWarning: true },
	});
});
afterAll(async () => {
	await worker?.stop();
});

describe('Arcturus DO', () => {
	test('init returns ok and roomCode is reachable via /metadata', async () => {
		const id = worker.env.arcturus.idFromName('MP-TEST01');
		const stub = worker.env.arcturus.get(id);
		const initRes = await stub.fetch('http://do/init', {
			method: 'POST',
			body: JSON.stringify({
				maxSeats: 2,
				smallBlind: 5,
				bigBlind: 10,
				hostUserId: 'u1',
				roomCode: 'MP-TEST01',
			}),
		});
		expect(initRes.status).toBe(200);
		const meta = await (await stub.fetch('http://do/metadata')).json();
		expect((meta as { occupancy: number }).occupancy).toBe(0);
	});

	test('second init returns 409 ROOM_CODE_TAKEN', async () => {
		const id = worker.env.arcturus.idFromName('MP-TEST02');
		const stub = worker.env.arcturus.get(id);
		await stub.fetch('http://do/init', {
			method: 'POST',
			body: JSON.stringify({
				maxSeats: 2,
				smallBlind: 5,
				bigBlind: 10,
				hostUserId: 'u1',
				roomCode: 'MP-TEST02',
			}),
		});
		const second = await stub.fetch('http://do/init', {
			method: 'POST',
			body: JSON.stringify({
				maxSeats: 4,
				smallBlind: 5,
				bigBlind: 10,
				hostUserId: 'u2',
				roomCode: 'MP-TEST02',
			}),
		});
		expect(second.status).toBe(409);
	});
});
```

- [ ] **Step 2: Run**

Run: `bun test src/server/mp/arcturus.integration.test.ts --timeout 30000`
Expected: 2 tests pass. If `unstable_dev` cannot find the entry, adjust path or use a thin worker entry script that re-exports the DO class.

> **Engineer note:** If `unstable_dev` requires a worker entry rather than a DO module, create a minimal `src/server/mp/_test-worker.ts` that exports `default { fetch() }` and re-exports `Arcturus`. Use that as the entry.

- [ ] **Step 3: Commit**

```bash
git add src/server/mp/arcturus.integration.test.ts
git commit -m "test(mp): DO integration tests via unstable_dev"
```

---

### Task 9b: 5-minute idle teardown alarm

The DO should self-evict after 5 minutes with no humans seated, per the spec.

**Files:**

- Modify: `src/server/mp/arcturus.ts`

- [ ] **Step 1: Track last-occupied timestamp**

Add a `lastOccupiedAt: number | null` field to `Room` (or as a private field on the DO). Update it whenever a seat transitions from empty → occupied or occupied → empty (i.e. inside `takeSeat` and `leaveSeat` post-mutation; if any seat remains occupied, set to null; otherwise set to `Date.now()`).

In `arcturus.ts`, after every mutation that may change occupancy, run:

```typescript
private updateOccupancyTimer(): void {
	if (!this.room) return;
	const anyHuman = this.room.seats.some((s) => s.userId !== null);
	if (!anyHuman) {
		// Schedule eviction in 5 min if not already
		this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
	}
}
```

Call `this.updateOccupancyTimer()` at the end of `take_seat`, `leave_seat`, and after `webSocketClose`.

- [ ] **Step 2: Handle eviction in `alarm()`**

Extend `alarm()`:

```typescript
async alarm(): Promise<void> {
	if (!this.room) return;
	const now = Date.now();

	// Disconnect-fold pass (existing logic)
	let mutated = false;
	const seats = this.room.seats.map((s) => {
		if (s.userId && s.disconnectedAt !== null && now - s.disconnectedAt >= 30_000) {
			mutated = true;
			return { ...s, userId: null, displayName: null, disconnectedAt: null, connected: false };
		}
		return s;
	});
	if (mutated) {
		this.room = { ...this.room, seats };
		await this.persist();
		this.broadcastRoomState();
	}

	// Idle teardown: if no human seated, delete persisted state
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
```

Note: DO has a single alarm; multiplexing the disconnect alarm and idle teardown means picking the earliest. Update `scheduleNextAlarm()` to include the idle-teardown candidate when no humans seated.

- [ ] **Step 3: Commit**

```bash
git add src/server/mp/arcturus.ts
git commit -m "feat(mp): 5-minute idle DO teardown via alarm"
```

---

## Phase C — API routes

Each route is a small Astro endpoint. They auth via existing `Astro.locals.user`, except the DO callbacks which use `X-Arcturus-Auth`.

### Task 10: `POST /api/mp/rooms` — create room

**Files:**

- Create: `src/pages/api/mp/rooms/index.ts`

- [ ] **Step 1: Implement**

Create `src/pages/api/mp/rooms/index.ts`:

```typescript
import type { APIRoute } from 'astro';
import { generateRoomCode } from '../../../../lib/mp-poker/roomCode';

export const POST: APIRoute = async ({ locals, request }) => {
	const user = locals.user;
	if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });
	const body = (await request.json()) as { maxSeats: number; smallBlind: number; bigBlind: number };
	if (
		body.maxSeats < 2 ||
		body.maxSeats > 6 ||
		body.smallBlind < 1 ||
		body.bigBlind < body.smallBlind * 2
	) {
		return new Response(JSON.stringify({ error: 'INVALID_CONFIG' }), { status: 400 });
	}
	const env = locals.runtime.env;
	if (!env.arcturus)
		return new Response(JSON.stringify({ error: 'DO_UNAVAILABLE' }), { status: 503 });

	for (let attempt = 0; attempt < 5; attempt++) {
		const code = generateRoomCode();
		const id = env.arcturus.idFromName(code);
		const stub = env.arcturus.get(id);
		const res = await stub.fetch('http://do/init', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				maxSeats: body.maxSeats,
				smallBlind: body.smallBlind,
				bigBlind: body.bigBlind,
				hostUserId: user.id,
				roomCode: code,
			}),
		});
		if (res.ok) return new Response(JSON.stringify({ code }), { status: 201 });
		if (res.status !== 409) {
			const err = await res.json();
			return new Response(JSON.stringify(err), { status: 502 });
		}
		// 409 → collision, regenerate and retry
	}
	return new Response(JSON.stringify({ error: 'CODE_GENERATION_FAILED' }), { status: 500 });
};
```

- [ ] **Step 2: Smoke-test manually with `curl`**

Run: `bun run dev` in one terminal. In another:

```bash
curl -X POST http://localhost:2000/api/mp/rooms \
  -H "content-type: application/json" \
  -d '{"maxSeats":2,"smallBlind":5,"bigBlind":10}' \
  -b "session-cookie-here"
```

Expected: `{"code":"MP-XXXXXX"}` with 201. If 401, supply a valid session cookie.

- [ ] **Step 3: Commit**

```bash
git add src/pages/api/mp/rooms/index.ts
git commit -m "feat(mp): POST /api/mp/rooms — create room with retry on collision"
```

---

### Task 11: `GET /api/mp/rooms/:code` — metadata + WS upgrade

**Files:**

- Create: `src/pages/api/mp/rooms/[code].ts`

- [ ] **Step 1: Implement**

Create `src/pages/api/mp/rooms/[code].ts`:

```typescript
import type { APIRoute } from 'astro';
import { isValidRoomCode } from '../../../../lib/mp-poker/roomCode';

export const GET: APIRoute = async ({ params, request, locals, url }) => {
	const code = params.code;
	if (!code || !isValidRoomCode(code))
		return new Response(JSON.stringify({ error: 'INVALID_CODE' }), { status: 400 });
	const env = locals.runtime.env;
	const id = env.arcturus.idFromName(code);
	const stub = env.arcturus.get(id);

	if (url.pathname.endsWith('/ws') || request.headers.get('Upgrade') === 'websocket') {
		const user = locals.user;
		if (!user) return new Response('Unauthorized', { status: 401 });
		const headers = new Headers(request.headers);
		headers.set('x-arcturus-user-id', user.id);
		headers.set('x-arcturus-display-name', user.name);
		return stub.fetch('http://do/ws', { headers });
	}

	return stub.fetch('http://do/metadata');
};
```

- [ ] **Step 2: Add a separate `/ws` route to disambiguate**

Astro routes don't dispatch by path suffix easily. Create `src/pages/api/mp/rooms/[code]/ws.ts`:

```typescript
import type { APIRoute } from 'astro';
import { isValidRoomCode } from '../../../../../lib/mp-poker/roomCode';

export const GET: APIRoute = async ({ params, request, locals }) => {
	const code = params.code;
	if (!code || !isValidRoomCode(code)) return new Response('Bad code', { status: 400 });
	const env = locals.runtime.env;
	const user = locals.user;
	if (!user) return new Response('Unauthorized', { status: 401 });
	if (request.headers.get('Upgrade') !== 'websocket')
		return new Response('Expected websocket', { status: 426 });
	const id = env.arcturus.idFromName(code);
	const stub = env.arcturus.get(id);
	const headers = new Headers(request.headers);
	headers.set('x-arcturus-user-id', user.id);
	headers.set('x-arcturus-display-name', user.name);
	return stub.fetch('http://do/ws', { headers });
};
```

Then simplify `[code].ts` to only return metadata.

- [ ] **Step 3: Commit**

```bash
git add src/pages/api/mp/rooms/
git commit -m "feat(mp): GET room metadata + WS upgrade routes"
```

---

### Task 12: `POST /api/mp/lock` — single-room lock

**Files:**

- Create: `src/pages/api/mp/lock.ts`

- [ ] **Step 1: Implement**

```typescript
import type { APIRoute } from 'astro';
import { createDb } from '../../../lib/db';
import { mpMembership } from '../../../db/schema';
import { eq } from 'drizzle-orm';

export const POST: APIRoute = async ({ locals, request }) => {
	const user = locals.user;
	if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });
	const body = (await request.json()) as { action: 'acquire' | 'release'; roomCode?: string };
	const db = createDb(locals.runtime.env.DB);

	if (body.action === 'release') {
		await db.delete(mpMembership).where(eq(mpMembership.userId, user.id)).run();
		return new Response(JSON.stringify({ ok: true }));
	}

	if (body.action === 'acquire') {
		if (!body.roomCode)
			return new Response(JSON.stringify({ error: 'MISSING_ROOM' }), { status: 400 });
		const existing = await db
			.select()
			.from(mpMembership)
			.where(eq(mpMembership.userId, user.id))
			.get();
		if (existing && existing.roomCode !== body.roomCode) {
			return new Response(JSON.stringify({ error: 'ALREADY_IN_ROOM' }), { status: 409 });
		}
		if (!existing) {
			await db
				.insert(mpMembership)
				.values({ userId: user.id, roomCode: body.roomCode, joinedAt: new Date() })
				.run();
		}
		return new Response(JSON.stringify({ ok: true }));
	}
	return new Response(JSON.stringify({ error: 'BAD_ACTION' }), { status: 400 });
};
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/api/mp/lock.ts
git commit -m "feat(mp): POST /api/mp/lock — single-MP-room enforcement"
```

---

### Task 13: `POST /api/mp/snapshot` — DO callback

**Files:**

- Create: `src/pages/api/mp/snapshot.ts`

- [ ] **Step 1: Implement**

```typescript
import type { APIRoute } from 'astro';
import { createDb } from '../../../lib/db';
import { user } from '../../../db/schema';
import { inArray } from 'drizzle-orm';

export const POST: APIRoute = async ({ request, locals }) => {
	const auth = request.headers.get('x-arcturus-auth');
	// NOTE v1: any non-empty header passes; v2 should verify against per-DO secret
	// stored in a KV namespace keyed by roomCode.
	if (!auth) return new Response('Forbidden', { status: 403 });
	const body = (await request.json()) as { userIds: string[]; roomCode: string };
	const db = createDb(locals.runtime.env.DB);
	const rows = await db
		.select({ id: user.id, chipBalance: user.chipBalance })
		.from(user)
		.where(inArray(user.id, body.userIds))
		.all();
	const balances: Record<string, number> = {};
	for (const r of rows) balances[r.id] = r.chipBalance;
	return new Response(JSON.stringify({ balances }), {
		headers: { 'content-type': 'application/json' },
	});
};
```

> **Engineer note:** the auth model here is intentionally loose for v1 — see the comment. Tightening it is on the v2 list. Do not paper over it with a TODO; it's documented.

- [ ] **Step 2: Commit**

```bash
git add src/pages/api/mp/snapshot.ts
git commit -m "feat(mp): POST /api/mp/snapshot — read main balances for DO"
```

---

### Task 14: `POST /api/mp/settle` — DO callback

**Files:**

- Create: `src/pages/api/mp/settle.ts`

- [ ] **Step 1: Implement**

```typescript
import type { APIRoute } from 'astro';
import { createDb } from '../../../lib/db';
import { user, chipSyncReceipt } from '../../../db/schema';
import { eq, sql } from 'drizzle-orm';

interface SettleEntry {
	userId: string;
	delta: number;
	syncId: string;
	gameType: 'poker_mp';
}

export const POST: APIRoute = async ({ request, locals }) => {
	const auth = request.headers.get('x-arcturus-auth');
	if (!auth) return new Response('Forbidden', { status: 403 });
	const body = (await request.json()) as { entries: SettleEntry[] };
	if (!Array.isArray(body.entries)) return new Response('Bad payload', { status: 400 });
	const db = createDb(locals.runtime.env.DB);

	for (const entry of body.entries) {
		// Idempotent: if receipt with this syncId exists, skip.
		const existing = await db
			.select({ syncId: chipSyncReceipt.syncId })
			.from(chipSyncReceipt)
			.where(eq(chipSyncReceipt.syncId, entry.syncId))
			.get();
		if (existing) continue;

		const row = await db.select().from(user).where(eq(user.id, entry.userId)).get();
		if (!row) continue;
		const previous = row.chipBalance;
		const next = Math.max(0, previous + entry.delta);

		await db
			.update(user)
			.set({ chipBalance: next, updatedAt: new Date() })
			.where(eq(user.id, entry.userId))
			.run();

		await db
			.insert(chipSyncReceipt)
			.values({
				userId: entry.userId,
				syncId: entry.syncId,
				gameType: entry.gameType,
				previousBalance: previous,
				balance: next,
				delta: entry.delta,
				statsDelta: null,
				outcome: entry.delta > 0 ? 'win' : entry.delta < 0 ? 'loss' : 'push',
				handCount: 1,
				winsIncrement: entry.delta > 0 ? 1 : 0,
				lossesIncrement: entry.delta < 0 ? 1 : 0,
				biggestWinCandidate: entry.delta > 0 ? entry.delta : 0,
				overallRank: null,
				achievementPayload: null,
				createdAt: new Date(),
			})
			.run();
	}

	return new Response(JSON.stringify({ ok: true }), {
		headers: { 'content-type': 'application/json' },
	});
};
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/api/mp/settle.ts
git commit -m "feat(mp): POST /api/mp/settle — atomic chip delta application"
```

---

## Phase D — Client and pages

### Task 15: WebSocket client wrapper

**Files:**

- Create: `src/lib/mp-poker/client.ts`
- Create: `src/lib/mp-poker/client.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/lib/mp-poker/client.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { encodeAction, MultiplayerPokerClient } from './client';

describe('client', () => {
	test('encodeAction produces protocol-valid JSON', () => {
		const json = encodeAction({ action: 'raise', amount: 200 });
		const parsed = JSON.parse(json);
		expect(parsed.type).toBe('action');
		expect(parsed.action).toBe('raise');
		expect(parsed.amount).toBe(200);
	});

	test('MultiplayerPokerClient construct does not throw', () => {
		expect(() => new MultiplayerPokerClient('ws://localhost')).not.toThrow();
	});
});
```

- [ ] **Step 2: Implement**

Create `src/lib/mp-poker/client.ts`:

```typescript
import { ServerMessage, type ClientMessage } from './protocol';

export type MessageHandler = (msg: ServerMessage) => void;

export function encodeAction(action: ClientMessage extends infer T ? T : never): string {
	return JSON.stringify({ type: 'action', ...(action as object) });
}

export class MultiplayerPokerClient {
	private ws: WebSocket | null = null;
	private handlers = new Set<MessageHandler>();

	constructor(private url: string) {}

	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.ws = new WebSocket(this.url);
			this.ws.onopen = () => resolve();
			this.ws.onerror = (e) => reject(e);
			this.ws.onmessage = (ev) => {
				try {
					const parsed = ServerMessage.parse(JSON.parse(ev.data));
					for (const h of this.handlers) h(parsed);
				} catch {
					// drop malformed
				}
			};
		});
	}

	send(msg: ClientMessage): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		this.ws.send(JSON.stringify(msg));
	}

	on(handler: MessageHandler): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	close(): void {
		this.ws?.close();
	}
}
```

- [ ] **Step 3: Run tests**

Run: `bun test src/lib/mp-poker/client.test.ts`
Expected: 2 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/mp-poker/client.ts src/lib/mp-poker/client.test.ts
git commit -m "feat(mp): browser WS client wrapper"
```

---

### Task 16: Lobby page (create / join)

**Files:**

- Create: `src/pages/games/poker-mp/index.astro`

- [ ] **Step 1: Implement**

Create `src/pages/games/poker-mp/index.astro`:

```astro
---
import CasinoLayout from '../../../layouts/casino.astro';
const user = Astro.locals.user;
if (!user) return Astro.redirect('/signin');
---

<CasinoLayout title="Multiplayer Poker — Arcturus Casino">
	<div class="max-w-xl mx-auto p-8 space-y-6">
		<h1 class="text-3xl font-bold text-white">Multiplayer Poker</h1>

		<section class="bg-slate-900/60 p-6 rounded-lg space-y-4">
			<h2 class="text-xl font-semibold text-white">Create a private room</h2>
			<form id="create-form" class="space-y-3">
				<label class="block text-slate-200">
					Max seats:
					<select name="maxSeats" class="ml-2 bg-slate-800 text-white p-1 rounded">
						<option value="2">2 (heads-up)</option>
						<option value="4" selected>4</option>
						<option value="6">6</option>
					</select>
				</label>
				<label class="block text-slate-200">
					Small blind: <input
						type="number"
						name="smallBlind"
						value="5"
						min="1"
						class="bg-slate-800 text-white p-1 rounded w-24"
					/>
				</label>
				<label class="block text-slate-200">
					Big blind: <input
						type="number"
						name="bigBlind"
						value="10"
						min="2"
						class="bg-slate-800 text-white p-1 rounded w-24"
					/>
				</label>
				<button
					type="submit"
					data-testid="create-room"
					class="bg-emerald-600 px-4 py-2 rounded text-white">Create room</button
				>
			</form>
		</section>

		<section class="bg-slate-900/60 p-6 rounded-lg space-y-4">
			<h2 class="text-xl font-semibold text-white">Join with code</h2>
			<form id="join-form" class="space-y-3">
				<input
					type="text"
					name="code"
					placeholder="MP-XXXXXX"
					pattern="MP-[A-Z0-9]{6}"
					required
					class="bg-slate-800 text-white p-2 rounded w-full uppercase"
					data-testid="join-code-input"
				/>
				<button
					type="submit"
					data-testid="join-room"
					class="bg-blue-600 px-4 py-2 rounded text-white">Join</button
				>
			</form>
		</section>

		<p id="status" class="text-rose-300 min-h-6" data-testid="status"></p>
	</div>
</CasinoLayout>

<script>
	const status = document.getElementById('status') as HTMLElement;

	document.getElementById('create-form')!.addEventListener('submit', async (e) => {
		e.preventDefault();
		const fd = new FormData(e.target as HTMLFormElement);
		const res = await fetch('/api/mp/rooms', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				maxSeats: Number(fd.get('maxSeats')),
				smallBlind: Number(fd.get('smallBlind')),
				bigBlind: Number(fd.get('bigBlind')),
			}),
		});
		const json = await res.json();
		if (res.ok) location.href = `/games/poker-mp/${json.code}`;
		else status.textContent = json.error ?? 'Failed';
	});

	document.getElementById('join-form')!.addEventListener('submit', async (e) => {
		e.preventDefault();
		const fd = new FormData(e.target as HTMLFormElement);
		const code = String(fd.get('code')).toUpperCase();
		location.href = `/games/poker-mp/${code}`;
	});
</script>
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/games/poker-mp/index.astro
git commit -m "feat(mp): multiplayer poker lobby page"
```

---

### Task 17: Table page (UI + WS wiring)

**Files:**

- Create: `src/pages/games/poker-mp/[code].astro`

- [ ] **Step 1: Implement minimal table UI**

Create `src/pages/games/poker-mp/[code].astro`:

```astro
---
import CasinoLayout from '../../../layouts/casino.astro';
const user = Astro.locals.user;
if (!user) return Astro.redirect('/signin');
const code = Astro.params.code;
---

<CasinoLayout title={`Poker ${code} — Arcturus`}>
	<div class="max-w-4xl mx-auto p-4 space-y-4" data-room-code={code}>
		<header class="flex justify-between items-center">
			<h1 class="text-2xl font-bold text-white">Room {code}</h1>
			<span data-testid="connection-status" class="text-emerald-300">Connecting…</span>
		</header>

		<div data-testid="table" class="bg-emerald-950/80 rounded-lg p-6">
			<div data-testid="board" class="flex gap-2 justify-center min-h-24"></div>
			<div data-testid="pot" class="text-center text-yellow-300 mt-3"></div>
		</div>

		<div data-testid="seats" class="grid grid-cols-3 gap-3"></div>

		<div data-testid="hole-cards" class="flex gap-2 justify-center min-h-24"></div>

		<div class="flex gap-2 justify-center" data-testid="actions">
			<button data-action="fold" class="bg-rose-600 px-4 py-2 rounded text-white">Fold</button>
			<button data-action="check" class="bg-slate-600 px-4 py-2 rounded text-white">Check</button>
			<button data-action="call" class="bg-blue-600 px-4 py-2 rounded text-white">Call</button>
			<input
				type="number"
				data-testid="raise-amount"
				class="bg-slate-800 text-white p-2 rounded w-32"
				placeholder="Amount"
			/>
			<button data-action="raise" class="bg-emerald-600 px-4 py-2 rounded text-white">Raise</button>
		</div>

		<div class="flex gap-3 justify-center">
			<button data-testid="take-seat-0" class="bg-slate-700 px-3 py-1 rounded text-white"
				>Sit at 0</button
			>
			<button data-testid="take-seat-1" class="bg-slate-700 px-3 py-1 rounded text-white"
				>Sit at 1</button
			>
			<button data-testid="start-hand" class="bg-amber-600 px-3 py-1 rounded text-white"
				>Start hand</button
			>
		</div>

		<div data-testid="log" class="text-slate-300 text-sm space-y-1 max-h-40 overflow-auto"></div>
	</div>
</CasinoLayout>

<script>
	import { MultiplayerPokerClient } from '../../../lib/mp-poker/client';

	const root = document.querySelector('[data-room-code]') as HTMLElement;
	const code = root.dataset.roomCode!;
	const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
	const client = new MultiplayerPokerClient(`${proto}//${location.host}/api/mp/rooms/${code}/ws`);

	const statusEl = document.querySelector('[data-testid="connection-status"]') as HTMLElement;
	const seatsEl = document.querySelector('[data-testid="seats"]') as HTMLElement;
	const boardEl = document.querySelector('[data-testid="board"]') as HTMLElement;
	const potEl = document.querySelector('[data-testid="pot"]') as HTMLElement;
	const holeEl = document.querySelector('[data-testid="hole-cards"]') as HTMLElement;
	const logEl = document.querySelector('[data-testid="log"]') as HTMLElement;
	const raiseAmt = document.querySelector('[data-testid="raise-amount"]') as HTMLInputElement;

	function renderCard(c: { value: string; suit: string }): string {
		const sym = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' }[c.suit] ?? '?';
		const color = c.suit === 'hearts' || c.suit === 'diamonds' ? 'text-rose-400' : 'text-white';
		return `<span class="inline-block bg-slate-800 px-2 py-1 rounded ${color}">${c.value}${sym}</span>`;
	}

	client.on((msg) => {
		if (msg.type === 'room_state') {
			boardEl.innerHTML = msg.board.map(renderCard).join('');
			potEl.textContent = `Pot: ${msg.pot}`;
			seatsEl.innerHTML = msg.seats
				.map(
					(s) =>
						`<div class="bg-slate-800 p-3 rounded text-white" data-testid="seat-${s.seatIndex}">
							Seat ${s.seatIndex}: ${s.displayName ?? '(empty)'} — ${s.committed} in pot
						</div>`,
				)
				.join('');
		} else if (msg.type === 'hand_started') {
			holeEl.innerHTML = msg.holeCards.map(renderCard).join('');
		} else if (msg.type === 'hand_ended') {
			const w = msg.winners.map((w) => `seat ${w.seatIndex} +${w.amount}`).join(', ');
			logEl.insertAdjacentHTML('afterbegin', `<div data-testid="log-entry">Hand ended: ${w}</div>`);
		} else if (msg.type === 'error') {
			logEl.insertAdjacentHTML(
				'afterbegin',
				`<div class="text-rose-400">Error: ${msg.message}</div>`,
			);
		}
	});

	client.connect().then(() => (statusEl.textContent = 'Connected'));

	document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const action = btn.dataset.action!;
			if (action === 'raise') {
				const amount = Number(raiseAmt.value);
				if (!amount) return;
				client.send({ type: 'action', action: 'raise', amount });
			} else {
				client.send({ type: 'action', action: action as 'fold' | 'check' | 'call' });
			}
		});
	});

	document.querySelectorAll<HTMLButtonElement>('[data-testid^="take-seat-"]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const idx = Number(btn.dataset.testid!.split('-').pop());
			client.send({ type: 'take_seat', seatIndex: idx });
		});
	});

	document.querySelector('[data-testid="start-hand"]')!.addEventListener('click', () => {
		client.send({ type: 'start_hand' });
	});
</script>
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/games/poker-mp/\[code\].astro
git commit -m "feat(mp): multiplayer poker table UI page"
```

---

### Task 18: Expose multiplayer poker on the games lobby

**Files:**

- Modify: `src/pages/games/index.astro`

- [ ] **Step 1: Add a new GameCard pointing to `/games/poker-mp`**

Read the current file. Find the existing GameCard for solo poker. Add a new card directly after it, copying the same prop shape but with title "Poker (Multiplayer)" and href `/games/poker-mp`. Reuse the existing image/asset prop pattern. Do not duplicate other cards.

- [ ] **Step 2: Verify dev server renders both cards**

Run: `bun run dev`. Visit `http://localhost:2000/games`. Confirm two poker cards now show.

- [ ] **Step 3: Commit**

```bash
git add src/pages/games/index.astro
git commit -m "feat(mp): expose multiplayer poker on games lobby"
```

---

## Phase E — End-to-end testing

### Task 19: Provision second test user for E2E

**Files:**

- Modify: `e2e/global-setup.ts`

- [ ] **Step 1: Read current setup**

Inspect `e2e/global-setup.ts` to understand the existing single-user pattern.

- [ ] **Step 2: Add a second user**

Extend the file so it provisions a second test user (`e2e-test-2@arcturus.local` / `PlaywrightTest123!` / `E2E Test User 2`) and saves their `storageState` to `e2e/.auth/user-2.json`. Mirror the existing first-user code path; do not refactor the existing flow.

- [ ] **Step 3: Run existing E2E to confirm no regression**

Run: `bun run test:e2e -- --grep "@smoke" --project=chromium` (or any small subset).
Expected: existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add e2e/global-setup.ts
git commit -m "test(e2e): provision second test user for multiplayer specs"
```

---

### Task 20: E2E happy-path multiplayer hand

**Files:**

- Create: `e2e/multiplayer-poker.spec.ts`

- [ ] **Step 1: Write spec**

Create `e2e/multiplayer-poker.spec.ts`:

```typescript
import { test, expect, type Page } from '@playwright/test';

test('two-player heads-up hand: create, join, play, settle', async ({ browser }) => {
	const ctxA = await browser.newContext({ storageState: 'e2e/.auth/user.json' });
	const ctxB = await browser.newContext({ storageState: 'e2e/.auth/user-2.json' });
	const pageA = await ctxA.newPage();
	const pageB = await ctxB.newPage();

	// User A creates a room
	await pageA.goto('/games/poker-mp');
	await pageA.locator('[data-testid="create-room"]').click();
	await pageA.waitForURL(/\/games\/poker-mp\/MP-/);
	const code = new URL(pageA.url()).pathname.split('/').pop()!;

	// User A takes seat 0
	await pageA.waitForSelector('[data-testid="connection-status"]:has-text("Connected")');
	await pageA.locator('[data-testid="take-seat-0"]').click();
	await expect(pageA.locator('[data-testid="seat-0"]')).toContainText(/E2E Test User/);

	// User B joins by URL
	await pageB.goto(`/games/poker-mp/${code}`);
	await pageB.waitForSelector('[data-testid="connection-status"]:has-text("Connected")');
	await pageB.locator('[data-testid="take-seat-1"]').click();
	await expect(pageB.locator('[data-testid="seat-1"]')).toContainText(/E2E Test User 2/);

	// Host (A) starts hand
	await pageA.locator('[data-testid="start-hand"]').click();
	await expect(pageA.locator('[data-testid="hole-cards"] span').first()).toBeVisible({
		timeout: 5000,
	});
	await expect(pageB.locator('[data-testid="hole-cards"] span').first()).toBeVisible({
		timeout: 5000,
	});

	// A folds, B should win the pot
	const actA = async (action: string) => pageA.locator(`[data-action="${action}"]`).click();
	await actA('fold');

	await expect(pageA.locator('[data-testid="log"]')).toContainText('Hand ended', { timeout: 5000 });
	await expect(pageB.locator('[data-testid="log"]')).toContainText('Hand ended', { timeout: 5000 });

	await ctxA.close();
	await ctxB.close();
});
```

- [ ] **Step 2: Run**

Run: `bunx playwright test e2e/multiplayer-poker.spec.ts --project=chromium`
Expected: PASS. If failures arise, the most likely root causes are: (1) `storageState` paths wrong, (2) middleware not granting WS upgrade with cookie auth, (3) DO not yet bound in dev server. Diagnose by inspecting `bun run dev` console.

- [ ] **Step 3: Commit**

```bash
git add e2e/multiplayer-poker.spec.ts
git commit -m "test(e2e): two-context multiplayer happy-path spec"
```

---

### Task 21: E2E reconnect spec

**Files:**

- Modify: `e2e/multiplayer-poker.spec.ts` (add a second test in the same file)

- [ ] **Step 1: Append spec**

```typescript
test('disconnect mid-hand triggers 30s auto-fold', async ({ browser }) => {
	test.slow(); // 30s+ runtime
	const ctxA = await browser.newContext({ storageState: 'e2e/.auth/user.json' });
	const ctxB = await browser.newContext({ storageState: 'e2e/.auth/user-2.json' });
	const pageA = await ctxA.newPage();
	const pageB = await ctxB.newPage();

	await pageA.goto('/games/poker-mp');
	await pageA.locator('[data-testid="create-room"]').click();
	await pageA.waitForURL(/\/games\/poker-mp\/MP-/);
	const code = new URL(pageA.url()).pathname.split('/').pop()!;

	await pageA.waitForSelector('[data-testid="connection-status"]:has-text("Connected")');
	await pageA.locator('[data-testid="take-seat-0"]').click();
	await pageB.goto(`/games/poker-mp/${code}`);
	await pageB.waitForSelector('[data-testid="connection-status"]:has-text("Connected")');
	await pageB.locator('[data-testid="take-seat-1"]').click();
	await pageA.locator('[data-testid="start-hand"]').click();
	await expect(pageB.locator('[data-testid="hole-cards"] span').first()).toBeVisible();

	// Close B's page abruptly mid-hand. A's perspective: 30s later, B should be auto-folded.
	await ctxB.close();

	// Wait 31s (DO alarm fires at 30s).
	await pageA.waitForTimeout(31_000);
	await expect(pageA.locator('[data-testid="seat-1"]')).toContainText(/\(empty\)/, {
		timeout: 5_000,
	});

	await ctxA.close();
});
```

- [ ] **Step 2: Run**

Run: `bunx playwright test e2e/multiplayer-poker.spec.ts --project=chromium --grep "disconnect"`
Expected: PASS (will take ~35s).

- [ ] **Step 3: Commit**

```bash
git add e2e/multiplayer-poker.spec.ts
git commit -m "test(e2e): disconnect-mid-hand auto-fold spec"
```

---

## Phase F — Final pass

### Task 22: Final QA checklist

- [ ] **Step 1: Full test suite**

Run: `bun run test && bun run test:e2e`
Expected: all tests green.

- [ ] **Step 2: Lint and format**

Run: `bun run lint && bun run format:check`
Expected: 0 warnings, 0 format issues. Run `bun run lint:fix` and `bun run format` if needed.

- [ ] **Step 3: Build**

Run: `bun run build`
Expected: build succeeds with the new DO class registered.

- [ ] **Step 4: Manual smoke test**

In two browser windows (one incognito), log in as the two test users, create a room in window A, join from window B, play a hand to fold-out, confirm both `chipBalance` rows update via `wrangler d1 execute arcturus-db --local --command="SELECT id, chipBalance FROM user"`.

- [ ] **Step 5: Update CLAUDE.md**

Add a brief section under "Project Structure" describing `src/server/mp/` and `src/lib/mp-poker/`. Add `poker-mp` to the games list. Add a note about the `arcturus` DO binding under "Critical Architecture Rules". Keep additions tight (5–10 lines total).

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document multiplayer poker architecture in CLAUDE.md"
```

---

## Out of scope (do not implement in this plan)

- AI seats in MP rooms
- Public lobby / matchmaking / quick-match
- Spectator mode
- Persistent hand history with replay UI
- Free-text chat (emotes wire is implemented; render UI for emotes can stay in v2 or simple decorative div)
- Tournament structure
- Side-pot integration in `finishHand` (current implementation awards full pot to best hand at showdown — sufficient for v1 but engineer should flag for v2 issue)
- Anti-collusion detection
- Rake / house cut
