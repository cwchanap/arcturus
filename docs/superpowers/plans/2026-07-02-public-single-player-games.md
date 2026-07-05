# Public Single-Player Games Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let guests play Arcturus single-player games publicly while signed-in users keep persistent chip sync, stats, achievements, and profile-backed features.

**Architecture:** Add a small shared public-game session helper that produces guest/account page data and chip-sync decisions. Single-player Astro routes render for guests with local chip balance and `data-guest-mode`; client sync code checks that marker before calling account-only APIs. Multiplayer poker and account pages remain protected.

**Tech Stack:** Astro SSR on Cloudflare Workers, TypeScript, Bun test runner, Playwright E2E, existing single-player game clients.

> **Implementation deviations (post-spec):** The shipped code intentionally diverges from the spec below in three respects. The authoritative description of shipped behavior lives in `RELEASE_NOTES.md` (Unreleased → Guest Play); this plan is retained as the original step-by-step build record.
>
> 1. **Guest bankroll persistence.** The spec below gives guests a fresh `$1,000` bankroll on every page load (no `localStorage`). The shipped implementation persists the guest bankroll to `localStorage` under a per-game, per-user key (`{gameKey}-bankroll:{clientUserId}`) via `loadGuestBankroll` / `persistGuestBankroll` in `src/lib/public-game-session.ts`, so guests keep their progress across refreshes. This is a deliberate UX improvement; tests verify it.
> 2. **Guest rebuy.** The shipped poker client gates a rebuy button on guest mode (busted guests can top back up), which is not part of the spec below. Authenticated users do not get the rebuy button (their balance lives on the server).
> 3. **Opaque client user IDs.** The spec below renders `data-user-id={user.id}` (raw account id) and `userId: ''` for guests. The shipped implementation renders an opaque FNV-1a hash surrogate (`u_<base36>`) for authenticated users and `anonymous` for guests via `clientUserId` / `hashUserId`, so the raw account id is never exposed in the DOM. This also changed the `pendingChipSyncs` localStorage key namespace; see `RELEASE_NOTES.md` for the migration note.

---

## File Structure

| Status | Path                                     | Responsibility                                                              |
| ------ | ---------------------------------------- | --------------------------------------------------------------------------- |
| Create | `src/lib/public-game-session.ts`         | Shared guest/account session shape and sync decision helpers                |
| Create | `src/lib/public-game-session.test.ts`    | Unit tests for guest/account session and sync helper behavior               |
| Create | `e2e/public-single-player-games.spec.ts` | Unauthenticated browser coverage for public games and protected multiplayer |
| Modify | `src/pages/games/poker.astro`            | Render guest poker route with guest balance metadata                        |
| Modify | `src/pages/games/blackjack.astro`        | Render guest blackjack route with guest balance metadata                    |
| Modify | `src/pages/games/baccarat.astro`         | Render guest baccarat route with guest balance metadata                     |
| Modify | `src/pages/games/craps.astro`            | Render guest craps route with guest balance metadata                        |
| Modify | `src/lib/poker/PokerGame.ts`             | Skip chip sync and pending sync persistence in poker guest mode             |
| Modify | `src/lib/poker/PokerGame.test.ts`        | Verify poker guest mode stays playable and skips `/api/chips/update`        |
| Modify | `src/lib/blackjack/blackjackClient.ts`   | Skip blackjack account sync in guest mode                                   |
| Modify | `src/pages/games/baccarat.astro`         | Skip baccarat account sync in guest mode                                    |
| Modify | `src/pages/games/craps.astro`            | Skip craps account sync and dropped-sync persistence in guest mode          |

---

## Task 1: Shared Public Game Session Helper

**Files:**

- Create: `src/lib/public-game-session.ts`
- Create: `src/lib/public-game-session.test.ts`

- [ ] **Step 1: Write failing helper tests**

Create `src/lib/public-game-session.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_GUEST_GAME_BALANCE,
	createPublicGameSession,
	isGuestModeValue,
	shouldSyncAccountChips,
} from './public-game-session';

describe('public-game-session', () => {
	test('creates a guest session when no user is present', () => {
		const session = createPublicGameSession(null);

		expect(session).toEqual({
			isGuest: true,
			userId: '',
			initialBalance: DEFAULT_GUEST_GAME_BALANCE,
			balanceLabel: 'Guest Balance',
			guestModeValue: 'true',
			balanceAvailableValue: 'true',
		});
	});

	test('uses the supplied fallback balance for guest sessions', () => {
		const session = createPublicGameSession(undefined, 750);

		expect(session.isGuest).toBe(true);
		expect(session.initialBalance).toBe(750);
	});

	test('creates an account session from a finite user chip balance', () => {
		const session = createPublicGameSession({ id: 'user-1', chipBalance: 1250 });

		expect(session).toEqual({
			isGuest: false,
			userId: 'user-1',
			initialBalance: 1250,
			balanceLabel: 'Your Balance',
			guestModeValue: 'false',
			balanceAvailableValue: 'true',
		});
	});

	test('falls back to the game default when signed-in chip balance is missing', () => {
		const session = createPublicGameSession({ id: 'user-1', chipBalance: null }, 900);

		expect(session.isGuest).toBe(false);
		expect(session.initialBalance).toBe(900);
		expect(session.balanceAvailableValue).toBe('false');
	});

	test('detects guest mode values from DOM dataset strings', () => {
		expect(isGuestModeValue('true')).toBe(true);
		expect(isGuestModeValue('false')).toBe(false);
		expect(isGuestModeValue(undefined)).toBe(false);
	});

	test('only account-backed sessions should sync account chips', () => {
		expect(shouldSyncAccountChips({ isGuestMode: true })).toBe(false);
		expect(shouldSyncAccountChips({ isGuestMode: false })).toBe(true);
	});
});
```

- [ ] **Step 2: Run helper tests to verify RED**

Run:

```bash
rtk bun test src/lib/public-game-session.test.ts
```

Expected: FAIL because `src/lib/public-game-session.ts` does not exist.

- [ ] **Step 3: Implement helper**

Create `src/lib/public-game-session.ts`:

```typescript
export const DEFAULT_GUEST_GAME_BALANCE = 1000;

export type PublicGameUser = {
	id: string;
	chipBalance?: number | null;
};

export type PublicGameSession = {
	isGuest: boolean;
	userId: string;
	initialBalance: number;
	balanceLabel: 'Guest Balance' | 'Your Balance';
	guestModeValue: 'true' | 'false';
	balanceAvailableValue: 'true' | 'false';
};

function normalizeBalance(balance: number | null | undefined, fallbackBalance: number): number {
	if (typeof balance === 'number' && Number.isFinite(balance)) {
		return Math.max(0, Math.trunc(balance));
	}
	return Math.max(0, Math.trunc(fallbackBalance));
}

export function createPublicGameSession(
	user: PublicGameUser | null | undefined,
	fallbackBalance = DEFAULT_GUEST_GAME_BALANCE,
): PublicGameSession {
	if (!user) {
		return {
			isGuest: true,
			userId: '',
			initialBalance: normalizeBalance(undefined, fallbackBalance),
			balanceLabel: 'Guest Balance',
			guestModeValue: 'true',
			balanceAvailableValue: 'true',
		};
	}

	const hasAccountBalance =
		typeof user.chipBalance === 'number' && Number.isFinite(user.chipBalance);

	return {
		isGuest: false,
		userId: user.id,
		initialBalance: normalizeBalance(user.chipBalance, fallbackBalance),
		balanceLabel: 'Your Balance',
		guestModeValue: 'false',
		balanceAvailableValue: hasAccountBalance ? 'true' : 'false',
	};
}

export function isGuestModeValue(value: string | null | undefined): boolean {
	return value === 'true';
}

export function shouldSyncAccountChips({ isGuestMode }: { isGuestMode: boolean }): boolean {
	return !isGuestMode;
}
```

- [ ] **Step 4: Run helper tests to verify GREEN**

Run:

```bash
rtk bun test src/lib/public-game-session.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit helper**

Run:

```bash
rtk git add src/lib/public-game-session.ts src/lib/public-game-session.test.ts
rtk git commit -m "feat(games): add public game session helper"
```

Expected: commit succeeds.

---

## Task 2: Render Single-Player Routes For Guests

**Files:**

- Create: `e2e/public-single-player-games.spec.ts`
- Modify: `src/pages/games/poker.astro`
- Modify: `src/pages/games/blackjack.astro`
- Modify: `src/pages/games/baccarat.astro`
- Modify: `src/pages/games/craps.astro`

- [ ] **Step 1: Write failing unauthenticated route E2E**

Create `e2e/public-single-player-games.spec.ts`:

```typescript
import { expect, test } from '@playwright/test';

test.describe('public single-player games', () => {
	test.use({ storageState: undefined });

	const publicGames = [
		{
			path: '/games/poker',
			rootSelector: '#poker-root',
			balanceSelector: '#player-balance',
			heading: "Texas Hold'em Poker",
		},
		{
			path: '/games/blackjack',
			rootSelector: '#blackjack-root',
			balanceSelector: '#player-balance',
			heading: 'Blackjack',
		},
		{
			path: '/games/baccarat',
			rootSelector: '#baccarat-root',
			balanceSelector: '#chip-balance',
			heading: 'Baccarat',
		},
		{
			path: '/games/craps',
			rootSelector: '#craps-root',
			balanceSelector: '#chip-balance',
			heading: 'Craps',
		},
	] as const;

	for (const game of publicGames) {
		test(`${game.path} renders in guest mode without sign-in`, async ({ page }) => {
			await page.goto(game.path, { waitUntil: 'domcontentloaded' });

			await expect(page).toHaveURL(new RegExp(`${game.path}$`));
			await expect(page.getByRole('heading', { name: game.heading })).toBeVisible();
			await expect(page.locator(game.rootSelector)).toHaveAttribute('data-guest-mode', 'true');
			await expect(page.locator(game.balanceSelector)).toContainText('$1,000');
			await expect(page.getByText('Guest Balance')).toBeVisible();
		});
	}

	test('multiplayer poker lobby remains protected', async ({ page }) => {
		await page.goto('/games/poker-mp', { waitUntil: 'domcontentloaded' });

		await expect(page).toHaveURL(/\/signin$/);
	});

	test('multiplayer poker room remains protected', async ({ page }) => {
		await page.goto('/games/poker-mp/MP-ABC123', { waitUntil: 'domcontentloaded' });

		await expect(page).toHaveURL(/\/signin$/);
	});
});
```

- [ ] **Step 2: Run unauthenticated route E2E to verify RED**

Run:

```bash
rtk bun run test:e2e -- e2e/public-single-player-games.spec.ts
```

Expected: FAIL because the four single-player routes redirect to `/signin` instead of rendering guest mode.

- [ ] **Step 3: Update poker route**

In `src/pages/games/poker.astro`, replace the current `user` guard and balance setup:

```text
import { redactUserId } from '../../lib/achievements/achievement-repository';

const user = Astro.locals.user;

if (!user) {
	return Astro.redirect('/signin');
}

const hasInitialBalance = typeof user.chipBalance === 'number' && Number.isFinite(user.chipBalance);

if (!hasInitialBalance) {
	console.warn(
		`[POKER] chipBalance unavailable for user ${redactUserId(user.id)}; rendering non-playable state.`,
	);
}
const initialBalance = hasInitialBalance ? user.chipBalance : 0;
const initialBalanceLabel = hasInitialBalance
	? `$${initialBalance.toLocaleString()}`
	: 'Unavailable';
```

with:

```text
import { createPublicGameSession } from '../../lib/public-game-session';

const user = Astro.locals.user;
const gameSession = createPublicGameSession(user);
const initialBalance = gameSession.initialBalance;
const initialBalanceLabel = `$${initialBalance.toLocaleString()}`;
```

Then change the top-level wrapper:

```text
<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
```

to:

```text
<div
	id="poker-root"
	data-guest-mode={gameSession.guestModeValue}
	class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8"
>
```

Then replace the balance label and data attributes:

```text
<div class="text-xs text-[var(--deco-muted)] mb-1">Your Balance</div>
<div
	class="text-2xl font-bold text-[var(--deco-brass)]"
	id="player-balance"
	data-testid="player-balance"
	data-balance={hasInitialBalance ? String(initialBalance) : ''}
	data-balance-available={hasInitialBalance ? 'true' : 'false'}
	data-user-id={user.id}
>
```

with:

```text
<div class="text-xs text-[var(--deco-muted)] mb-1">{gameSession.balanceLabel}</div>
<div
	class="text-2xl font-bold text-[var(--deco-brass)]"
	id="player-balance"
	data-testid="player-balance"
	data-balance={String(initialBalance)}
	data-balance-available={gameSession.balanceAvailableValue}
	data-guest-mode={gameSession.guestModeValue}
	data-user-id={gameSession.userId}
>
```

- [ ] **Step 4: Update blackjack route**

In `src/pages/games/blackjack.astro`, add:

```text
import { createPublicGameSession } from '../../lib/public-game-session';
```

Remove:

```text
const user = Astro.locals.user;

if (!user) {
	return Astro.redirect('/signin');
}

// Use nullish coalescing to preserve zero balance (|| would treat 0 as falsy)
const initialBalance = user.chipBalance ?? 1000;
```

and replace it with:

```text
const user = Astro.locals.user;
const gameSession = createPublicGameSession(user);
const initialBalance = gameSession.initialBalance;
```

Change the root:

```text
<div
	id="blackjack-root"
	data-user-id={user.id}
	class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8"
>
```

to:

```text
<div
	id="blackjack-root"
	data-user-id={gameSession.userId}
	data-guest-mode={gameSession.guestModeValue}
	data-initial-balance={initialBalance}
	class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8"
>
```

Change:

```text
<div class="text-xs text-[var(--deco-muted)] mb-1">Your Balance</div>
```

to:

```text
<div class="text-xs text-[var(--deco-muted)] mb-1">{gameSession.balanceLabel}</div>
```

- [ ] **Step 5: Update baccarat route**

In `src/pages/games/baccarat.astro`, add:

```text
import { createPublicGameSession } from '../../lib/public-game-session';
```

Remove:

```text
const user = Astro.locals.user;

if (!user) {
	return Astro.redirect('/signin');
}

// Use nullish coalescing to preserve zero balance
const initialBalance = user.chipBalance ?? 1000;
```

and replace it with:

```text
const user = Astro.locals.user;
const gameSession = createPublicGameSession(user);
const initialBalance = gameSession.initialBalance;
```

Change the root:

```text
<div
	id="baccarat-root"
	data-user-id={user.id}
	data-initial-balance={initialBalance}
	class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8"
>
```

to:

```text
<div
	id="baccarat-root"
	data-user-id={gameSession.userId}
	data-guest-mode={gameSession.guestModeValue}
	data-initial-balance={initialBalance}
	class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8"
>
```

Change:

```text
<div class="text-xs text-[var(--deco-muted)] mb-1">Your Balance</div>
```

to:

```text
<div class="text-xs text-[var(--deco-muted)] mb-1">{gameSession.balanceLabel}</div>
```

- [ ] **Step 6: Update craps route**

In `src/pages/games/craps.astro`, add:

```text
import { createPublicGameSession } from '../../lib/public-game-session';
```

Remove:

```text
const user = Astro.locals.user;
if (!user) return Astro.redirect('/signin');

const initialBalance = user.chipBalance ?? 1000;
```

and replace it with:

```text
const user = Astro.locals.user;
const gameSession = createPublicGameSession(user);
const initialBalance = gameSession.initialBalance;
```

Change the root:

```text
<div
	id="craps-root"
	data-user-id={user.id}
	data-initial-balance={initialBalance}
	class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8"
>
```

to:

```text
<div
	id="craps-root"
	data-user-id={gameSession.userId}
	data-guest-mode={gameSession.guestModeValue}
	data-initial-balance={initialBalance}
	class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8"
>
```

Change:

```text
<div class="text-xs text-[var(--deco-muted)] mb-1">Your Balance</div>
```

to:

```text
<div class="text-xs text-[var(--deco-muted)] mb-1">{gameSession.balanceLabel}</div>
```

- [ ] **Step 7: Run route E2E to verify GREEN**

Run:

```bash
rtk bun run test:e2e -- e2e/public-single-player-games.spec.ts
```

Expected: PASS for public single-player routes and protected multiplayer routes.

- [ ] **Step 8: Commit route rendering**

Run:

```bash
rtk git add e2e/public-single-player-games.spec.ts src/pages/games/poker.astro src/pages/games/blackjack.astro src/pages/games/baccarat.astro src/pages/games/craps.astro
rtk git commit -m "feat(games): render single-player games for guests"
```

Expected: commit succeeds.

---

## Task 3: Poker Guest Mode Chip Sync Guard

**Files:**

- Modify: `src/lib/poker/PokerGame.ts`
- Modify: `src/lib/poker/PokerGame.test.ts`

- [ ] **Step 1: Write failing poker guest sync test**

In `src/lib/poker/PokerGame.test.ts`, add this test in `describe('PokerGame bankroll and auto-deal guards', ...)` after the existing balance initialization tests:

```typescript
test('guest mode stays playable and skips account chip sync', async () => {
	const elements = mockPokerGameDOM();
	elements['poker-root'] = {
		addEventListener: () => {},
		dataset: { guestMode: 'true' },
		innerHTML: '',
		textContent: '',
		classList: { add: () => {}, remove: () => {}, toggle: () => {} },
		value: '0',
	};
	elements['player-balance'] = {
		addEventListener: () => {},
		dataset: {
			balance: '1000',
			balanceAvailable: 'true',
			guestMode: 'true',
			userId: '',
		},
		innerHTML: '',
		textContent: '$1,000',
		classList: { add: () => {}, remove: () => {}, toggle: () => {} },
		value: '0',
	};

	const fetchCalls: string[] = [];
	const fetchMock = mock(async (input: string | URL | Request) => {
		const url =
			typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		fetchCalls.push(url);
		return {
			ok: false,
			status: 401,
			json: async () => ({ error: 'UNAUTHORIZED' }),
		};
	}) as unknown as typeof fetch;
	(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = fetchMock;

	const game = new PokerGame() as unknown as {
		players: Player[];
		humanChipsBefore: number;
		hasServerSyncedBalance: boolean;
		syncChips: (outcome: 'win' | 'loss' | 'push') => void;
	};

	expect(game.hasServerSyncedBalance).toBe(true);
	expect(game.players[0].chips).toBe(1000);

	game.humanChipsBefore = 1000;
	game.players[0] = { ...game.players[0], chips: 1050 };
	game.syncChips('win');

	await flushAsyncWork();

	expect(fetchCalls).not.toContain('/api/chips/update');
	expect(game.humanChipsBefore).toBe(0);
	expect(game.players[0].chips).toBe(1050);
});
```

- [ ] **Step 2: Run poker test to verify RED**

Run:

```bash
rtk bun test src/lib/poker/PokerGame.test.ts --test-name-pattern "guest mode stays playable"
```

Expected: FAIL because guest mode does not yet skip account chip sync.

- [ ] **Step 3: Add guest mode state to PokerGame**

In `src/lib/poker/PokerGame.ts`, add this import:

```typescript
import { isGuestModeValue, shouldSyncAccountChips } from '../public-game-session';
```

Add this class property near `private hasServerSyncedBalance = false;`:

```typescript
private isGuestMode = false;
```

In the constructor, after `const balanceEl = document.getElementById('player-balance');`, add:

```typescript
const rootEl = document.getElementById('poker-root');
this.isGuestMode =
	isGuestModeValue(balanceEl?.dataset?.guestMode) || isGuestModeValue(rootEl?.dataset?.guestMode);
```

Change:

```typescript
this.hasServerSyncedBalance = balanceAvailable === 'false' ? false : Number.isFinite(parsed);
```

to:

```typescript
this.hasServerSyncedBalance =
	this.isGuestMode || (balanceAvailable === 'false' ? false : Number.isFinite(parsed));
```

Change the persisted sync loading block:

```typescript
} else {
	this.loadPersistedPendingSyncs();
	if (this.pendingChipSyncs.length > 0) {
```

to:

```typescript
} else if (!this.isGuestMode) {
	this.loadPersistedPendingSyncs();
	if (this.pendingChipSyncs.length > 0) {
```

- [ ] **Step 4: Skip poker sync and persistence for guests**

In `syncChips()`, add this as the first guard:

```typescript
if (!shouldSyncAccountChips({ isGuestMode: this.isGuestMode })) {
	this.humanChipsBefore = 0;
	return;
}
```

In the `beforeunload` listener, replace:

```typescript
this.persistPendingSyncs();
```

with:

```typescript
if (!this.isGuestMode) {
	this.persistPendingSyncs();
}
```

- [ ] **Step 5: Run poker test to verify GREEN**

Run:

```bash
rtk bun test src/lib/poker/PokerGame.test.ts --test-name-pattern "guest mode stays playable"
```

Expected: PASS.

- [ ] **Step 6: Run full poker tests**

Run:

```bash
rtk bun test src/lib/poker/
```

Expected: PASS.

- [ ] **Step 7: Commit poker guard**

Run:

```bash
rtk git add src/lib/poker/PokerGame.ts src/lib/poker/PokerGame.test.ts
rtk git commit -m "feat(poker): skip account sync for guests"
```

Expected: commit succeeds.

---

## Task 4: Blackjack, Baccarat, And Craps Guest Sync Guards

**Files:**

- Modify: `src/lib/blackjack/blackjackClient.ts`
- Modify: `src/pages/games/baccarat.astro`
- Modify: `src/pages/games/craps.astro`
- Modify: `e2e/public-single-player-games.spec.ts`

- [ ] **Step 1: Extend E2E with a guest no-sync blackjack smoke**

Append this test to `e2e/public-single-player-games.spec.ts` inside the `describe` block:

```typescript
test('guest blackjack can complete a round without calling chip sync', async ({ page }) => {
	const chipUpdateRequests: string[] = [];
	page.on('request', (request) => {
		if (request.url().includes('/api/chips/update')) {
			chipUpdateRequests.push(request.url());
		}
	});

	await page.goto('/games/blackjack', { waitUntil: 'domcontentloaded' });
	await expect(page.locator('#blackjack-root')).toHaveAttribute('data-guest-mode', 'true');

	await page.locator('#bet-amount').fill('50');
	await page.getByRole('button', { name: 'Deal' }).click();
	await expect(page.locator('#game-controls')).toBeVisible();

	for (let i = 0; i < 6; i++) {
		if (await page.locator('#btn-new-round').isVisible()) break;
		if (await page.locator('#btn-stand').isEnabled()) {
			await page.locator('#btn-stand').click();
		} else if (await page.locator('#btn-hit').isEnabled()) {
			await page.locator('#btn-hit').click();
		} else {
			break;
		}
	}

	await expect(page.locator('#btn-new-round')).toBeVisible({ timeout: 10000 });
	await page.waitForTimeout(500);
	expect(chipUpdateRequests).toEqual([]);
});
```

- [ ] **Step 2: Run no-sync E2E to verify RED**

Run:

```bash
rtk bun run test:e2e -- e2e/public-single-player-games.spec.ts --grep "guest blackjack"
```

Expected: FAIL because guest blackjack still calls `/api/chips/update`.

- [ ] **Step 3: Add blackjack guest sync guard**

In `src/lib/blackjack/blackjackClient.ts`, add this import:

```typescript
import { isGuestModeValue, shouldSyncAccountChips } from '../public-game-session';
```

After:

```typescript
const rootEl = document.getElementById('blackjack-root');
const userId = rootEl?.getAttribute('data-user-id') ?? 'anonymous';
```

add:

```typescript
const isGuestMode = isGuestModeValue(rootEl?.dataset?.guestMode);
```

Inside `handleRoundComplete()`, immediately before the comment `// Update balance in database`, add:

```typescript
if (!shouldSyncAccountChips({ isGuestMode })) {
	return;
}
```

- [ ] **Step 4: Add baccarat guest sync guard**

In the `<script>` block of `src/pages/games/baccarat.astro`, add this import beside the existing script imports:

```typescript
import { isGuestModeValue, shouldSyncAccountChips } from '../../lib/public-game-session';
```

After the existing root lookup and initial balance setup, add:

```typescript
const isGuestMode = isGuestModeValue(root.dataset.guestMode);
```

At the start of `async function syncBalance(roundNetDelta: number)`, before clearing retry timers, add:

```typescript
if (!shouldSyncAccountChips({ isGuestMode })) {
	return;
}
```

- [ ] **Step 5: Add craps guest sync guard**

In the `<script>` block of `src/pages/games/craps.astro`, add this import beside the existing script imports:

```typescript
import { isGuestModeValue, shouldSyncAccountChips } from '../../lib/public-game-session';
```

After:

```typescript
const initialBalance = Number(root.dataset.initialBalance ?? 1000);
const userId = root.dataset.userId ?? 'anonymous';
```

add:

```typescript
const isGuestMode = isGuestModeValue(root.dataset.guestMode);
```

At the start of `async function syncBalance()`, before the `isSyncInProgress` guard, add:

```typescript
if (!shouldSyncAccountChips({ isGuestMode })) {
	pendingRollSyncs = [];
	syncPending = false;
	pendingRetryScheduled = false;
	persistSession();
	return;
}
```

In `persistDroppedRollSyncs()`, add this first guard:

```typescript
if (!shouldSyncAccountChips({ isGuestMode })) {
	return false;
}
```

- [ ] **Step 6: Run public E2E to verify GREEN**

Run:

```bash
rtk bun run test:e2e -- e2e/public-single-player-games.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Run TypeScript/build check for inline Astro scripts**

Run:

```bash
rtk bun run build
```

Expected: PASS.

- [ ] **Step 8: Commit non-poker guards**

Run:

```bash
rtk git add src/lib/blackjack/blackjackClient.ts src/pages/games/baccarat.astro src/pages/games/craps.astro e2e/public-single-player-games.spec.ts
rtk git commit -m "feat(games): skip account sync for guest play"
```

Expected: commit succeeds.

---

## Task 5: Final Verification And Cleanup

**Files:**

- Modify only if verification finds focused issues from this feature.

- [ ] **Step 1: Run helper and affected unit tests**

Run:

```bash
rtk bun test src/lib/public-game-session.test.ts src/lib/poker/PokerGame.test.ts src/lib/blackjack/
```

Expected: PASS.

- [ ] **Step 2: Run full unit suite**

Run:

```bash
rtk bun run test
```

Expected: PASS.

- [ ] **Step 3: Run lint**

Run:

```bash
rtk bun run lint
```

Expected: PASS with 0 warnings.

- [ ] **Step 4: Run build**

Run:

```bash
rtk bun run build
```

Expected: PASS.

- [ ] **Step 5: Run public and existing poker E2E checks**

Run:

```bash
rtk bun run test:e2e -- e2e/public-single-player-games.spec.ts e2e/poker-turn-flow.spec.ts
```

Expected: PASS. The public spec proves guest access; the existing poker turn-flow spec proves authenticated play still works.

- [ ] **Step 6: Inspect final diff**

Run:

```bash
rtk git diff --stat main..HEAD
rtk git diff --name-status main..HEAD
```

Expected: diff is scoped to the public single-player game feature, the earlier non-LLM poker AI work on this branch, and their plan/spec docs.

- [ ] **Step 7: Commit cleanup if needed**

If verification required focused cleanup, run:

```bash
rtk git add src/lib src/pages/games e2e/public-single-player-games.spec.ts
rtk git commit -m "fix(games): stabilize public guest play"
```

If no cleanup was needed, skip this step.

---

## Execution Notes

- Do not alter `/api/chips/update`; it remains authenticated.
- Do not make multiplayer poker public in this pass.
- Do not create anonymous server accounts or new database tables.
- Guest mode must never send guest chip deltas to `/api/chips/update`.
- Signed-in users must keep the existing account-backed chip sync and stats behavior.
- Prefer `data-guest-mode="true"` as the single UI/runtime contract for guest mode.
