# Arcturus i18n Localization Implementation Plan

> **For implementation:** Execute one rollout ticket at a time using the normal TDD workflow. Each numbered rollout task below is exactly one implementation ticket and one PR; do not split a task into multiple PRs without explicit approval.

**Goal:** Add complete English, Traditional Chinese, Simplified Chinese, and Japanese localization to the current Arcturus player experience without changing URLs, persisting translated domain data, or introducing a runtime i18n framework.

**Architecture:** Resolve one enabled locale per request in Astro middleware, expose it through `Astro.locals`, and render server copy with a small typed TypeScript translator. Feature-local message dictionaries contain all four supported locales, while `ENABLED_LOCALES` controls what production requests may expose. Browser game controllers read the SSR-resolved locale from their page root and use the same dictionaries for dynamic copy. Domain IDs/enums remain language-neutral.

**Tech stack:** Astro 5, TypeScript, Bun test, Vitest, Playwright, Cloudflare Workers/D1. No new runtime i18n dependency.

**Design reference:** `docs/superpowers/specs/2026-08-30-i18n-localization-design.md`

## Delivery Rules

- Seven rollout tickets, seven implementation PRs, merged sequentially.
- Every feature PR adds all four translations for the surface it migrates, even though production exposes only English until Task 7.
- `SUPPORTED_LOCALES = ['en', 'zh-Hant', 'zh-Hans', 'ja']` from Task 1 onward.
- `ENABLED_LOCALES = ['en']` through Tasks 1–6. Disabled locales must not be selected by picker, cookie, or `Accept-Language`.
- English remains the authoring locale, but newly migrated feature dictionaries must have matching keys for all four locales before that PR merges.
- Do not create locale routes, locale DB columns, a CMS, ICU parsing, or a CJK font dependency as part of these tickets.
- Use complete translated sentences with interpolation instead of assembling English-shaped fragments.
- Preserve stable game/mission/achievement IDs and enums in APIs, DB rows, and local game state.
- Prefer existing presentation seams. Do not refactor game engines merely to make translation code look generic.

---

## Task 1 / PR 1: i18n Foundation and Global Shell

**Purpose:** Establish the only shared i18n primitives the rest of the rollout may depend on, while keeping production English-only.

**Create:**
- `src/i18n/locale.ts`
- `src/i18n/locale.test.ts`
- `src/i18n/translate.ts`
- `src/i18n/translate.test.ts`
- `src/i18n/messages/common.ts`
- `src/components/LanguagePicker.astro`
- `e2e/i18n-foundation.spec.ts`

**Modify:**
- `src/env.d.ts`
- `src/middleware.ts`
- `src/layouts/AppLayout.astro`
- `src/components/UserNav.astro`
- `src/lib/formatting.ts`
- `src/lib/formatting.test.ts`

### Step 1: Write locale-resolution tests first

Cover these cases in `src/i18n/locale.test.ts`:

```ts
expect(normalizeLocaleTag('zh-TW')).toBe('zh-Hant');
expect(normalizeLocaleTag('zh-CN')).toBe('zh-Hans');
expect(normalizeLocaleTag('ja-JP')).toBe('ja');
expect(normalizeLocaleTag('fr-CA')).toBeNull();

expect(resolveRequestLocale({
  cookieLocale: 'ja',
  acceptLanguage: 'zh-TW,zh;q=0.9,en;q=0.8',
  enabledLocales: ['en'],
})).toBe('en');

expect(resolveRequestLocale({
  cookieLocale: 'ja',
  acceptLanguage: 'en-US,en;q=0.9',
  enabledLocales: ['en', 'ja'],
})).toBe('ja');
```

Also test cookie precedence over `Accept-Language`, malformed cookie fallback, bare `zh -> zh-Hans`, and q-value ordering for normal browser headers.

Run:

```bash
bun test src/i18n/locale.test.ts
```

Expected: FAIL because the locale module does not exist yet.

### Step 2: Implement the minimal locale module

`src/i18n/locale.ts` should own only:

```ts
export const SUPPORTED_LOCALES = ['en', 'zh-Hant', 'zh-Hans', 'ja'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const ENABLED_LOCALES: readonly Locale[] = ['en'];
export const LOCALE_COOKIE = 'arcturus_locale';

export function normalizeLocaleTag(tag: string | null | undefined): Locale | null;
export function resolveRequestLocale(input: {
  cookieLocale: string | null | undefined;
  acceptLanguage: string | null | undefined;
  enabledLocales?: readonly Locale[];
}): Locale;
```

Keep `Accept-Language` parsing small: parse comma-separated language ranges plus optional `q`, sort by preference, normalize each tag, and return the first normalized locale present in `enabledLocales`. Do not bring in a parser package.

Run the locale test again. Expected: PASS.

### Step 3: Write translator tests before implementation

`src/i18n/translate.test.ts` must prove:

- all four locale branches use the English key shape;
- interpolation replaces named `{value}` tokens;
- repeated placeholders work;
- missing interpolation values do not crash the app;
- runtime missing locale/key fallback resolves English during development.

Use a feature-local shape such as:

```ts
const messages = defineMessages({
  en: { greeting: 'Hello {name}' },
  'zh-Hant': { greeting: '你好，{name}' },
  'zh-Hans': { greeting: '你好，{name}' },
  ja: { greeting: 'こんにちは、{name}' },
});

const t = createTranslator('ja', messages);
expect(t('greeting', { name: 'Aki' })).toBe('こんにちは、Aki');
```

Run and confirm RED:

```bash
bun test src/i18n/translate.test.ts
```

Then implement only `defineMessages()` and `createTranslator()` in `src/i18n/translate.ts`; no plural DSL, nested-path resolver, namespace registry, or global singleton.

### Step 4: Make formatting locale-aware without forcing the whole app to migrate at once

Extend existing numeric helpers in `src/lib/formatting.ts` rather than creating a second formatting module.

During Tasks 1–6, accept `locale: Locale = 'en'` on locale-sensitive helpers so unmigrated English surfaces keep compiling. Preserve current input semantics, including `formatPercentage(50.8) -> 50.8%`; use `Intl.NumberFormat(locale, ...)` internally.

Do not localize the noun in `formatSignedChipResult()` here. That presentation-specific helper is removed/replaced when profile/statistics is migrated in Task 2.

Add Traditional Chinese/Japanese formatting assertions to `src/lib/formatting.test.ts` while preserving current English tests.

Run:

```bash
bun test src/lib/formatting.test.ts
```

### Step 5: Wire request locale before the middleware auth early-return

In `src/middleware.ts`, resolve locale at the top of `onRequest` from:

```ts
context.cookies.get(LOCALE_COOKIE)?.value
context.request.headers.get('accept-language')
```

and set `context.locals.locale` before any DB/auth branch can call `next()`.

Add `locale: Locale` to `App.Locals` in `src/env.d.ts`.

This must work when D1/auth configuration is absent; localization must not depend on login state.

### Step 6: Migrate the shared shell

Put global navigation/footer/chip-label/game-name copy needed by the shell in `src/i18n/messages/common.ts` for all four locales.

Update `src/layouts/AppLayout.astro` to:

- use `Astro.locals.locale`;
- set `<html lang={locale}>`;
- replace its hard-coded `Intl.NumberFormat('en-US')` with `formatChipBalance(..., locale)`;
- translate nav/footer/legal/chip copy;
- render `LanguagePicker` only when `ENABLED_LOCALES.length > 1`.

Update `src/components/UserNav.astro` to translate `Profile`, `Sign In`, and `Join Free` from the same request locale.

`LanguagePicker.astro` should use native labels and, once multiple locales are enabled, set a one-year `arcturus_locale` cookie with `Path=/; SameSite=Lax`, then reload the current URL. Do not create a locale API endpoint.

### Step 7: Add one rollout-guard E2E test

`e2e/i18n-foundation.spec.ts` should set a `ja` cookie and/or Japanese `Accept-Language` while `ENABLED_LOCALES` is still `['en']`, then verify:

- `<html lang="en">`;
- shared shell copy remains English;
- no Japanese option is exposed by the picker;
- normal navigation still works.

Run:

```bash
bunx playwright test e2e/i18n-foundation.spec.ts
```

Expected: PASS.

### Step 8: Verify and commit the PR

Run:

```bash
bun run test
bun run lint
bun run format:check
bun run build
bunx playwright test e2e/i18n-foundation.spec.ts
```

Suggested commits inside this single PR:

```text
test: define locale and translation contracts
feat: add typed i18n foundation
feat: localize global shell infrastructure
```

---

## Task 2 / PR 2: Home, Auth, Profile, and Achievements

**Purpose:** Migrate the non-game account/discovery surfaces and remove English achievement metadata from domain definitions.

**Create:**
- `src/i18n/messages/home.ts`
- `src/i18n/messages/auth.ts`
- `src/i18n/messages/profile.ts`
- `src/i18n/messages/achievements.ts`

**Primary files to modify:**
- `src/pages/index.astro`
- `src/pages/signin.astro`
- `src/pages/profile.astro`
- `src/pages/profile/statistics.astro`
- `src/components/profile/PlayerStatisticsSummary.astro`
- `src/lib/achievements/types.ts`
- `src/lib/achievements/achievement-rules.ts`
- `src/lib/achievements/achievements.ts`
- `src/lib/achievement-toast.ts`
- existing achievement/profile tests and `e2e/auth-ui.spec.ts`

### Step 1: Add failing translation/presentation tests

Before changing domain types, add tests that prove:

- each achievement ID resolves a localized name and description in all four locales;
- threshold values are interpolated through locale-aware number formatting;
- profile statistics can render a signed numeric result without embedding the English noun `chips` in a generic formatter.

Keep achievement unlock-rule tests language-neutral.

### Step 2: Make achievement definitions language-neutral

Change `AchievementDefinition` so rules own only stable metadata needed by the domain:

```ts
interface AchievementDefinition {
  id: AchievementId;
  category: AchievementCategory;
  icon: string;
}
```

Remove `name` and `description` from `ACHIEVEMENTS` in `achievement-rules.ts`. Keep thresholds and checks exactly where they are.

Update `AchievementWithStatus` and service tests accordingly. Logging may use the achievement ID; logs do not need player-facing translations.

For toast/API consumers, key display lookup by `AchievementId`. Do not store or trust an English `name` as the presentation source.

### Step 3: Migrate home/auth/profile copy

Use request-local translators in each Astro page. Translate:

- page titles and headings;
- game names/descriptions on home;
- sign-in calls to action and errors that are actually shown to the player;
- profile/account labels, verification states, tips, AI settings labels/status;
- accessibility labels/alt fallback text;
- statistics labels and empty/error states.

Keep provider/model identifiers such as OpenAI, Gemini, GPT-4o unchanged.

Move the `chips` noun out of `formatSignedChipResult()`: either format the signed number neutrally and interpolate it into `profile` messages, or replace the helper at its only presentation call sites. Delete the English-specific helper once unused.

### Step 4: Localize achievement toast presentation

`src/lib/achievement-toast.ts` should receive/derive a stable achievement ID and resolve the visible name from `achievements.ts` using the page locale. Preserve icon and queue behavior.

Do not make achievement granting depend on locale.

### Step 5: Stabilize tests that currently select English text

Where an existing auth/profile E2E test uses English text only as a locator, add a `data-testid` and switch the locator. Keep English assertions when the text itself is the behavior under test.

Add focused unit/component assertions that directly render/resolve one Traditional Chinese, Simplified Chinese, and Japanese message; production-route E2E remains English-only until Task 7.

Run targeted tests, then:

```bash
bun run test
bun run lint
bun run build
bunx playwright test e2e/auth-ui.spec.ts
```

Suggested commits:

```text
refactor: make achievement definitions locale-neutral
feat: localize home auth and profile surfaces
```

---

## Task 3 / PR 3: Missions, Leaderboard, and Daily Challenge

**Purpose:** Move mission display strings out of domain/API state and localize the progression/ranking surfaces.

**Create:**
- `src/i18n/messages/missions.ts`
- `src/i18n/messages/leaderboard.ts`
- `src/i18n/messages/daily-challenge.ts`

**Primary files to modify:**
- `src/lib/missions/types.ts`
- `src/lib/missions/registry.ts`
- `src/lib/missions/board.ts`
- `src/pages/missions/index.astro`
- `src/pages/games/leaderboard.astro`
- `src/pages/games/daily-challenge.astro`
- `src/lib/blackjack-run/daily-ui.ts`
- related mission/leaderboard/blackjack-run tests
- `e2e/daily-challenge.spec.ts`
- existing leaderboard/mission E2E specs

### Step 1: Pin the locale-neutral mission contract with failing tests

Change the expected contract so `MissionDefinition` contains ID, period, metric, target, reward and icon, but not English `title`/`description`.

Likewise remove `title`/`description` from `MissionView`; the board/API should return `missionDefId` plus progress/domain values. Add tests first around `buildMissionView()` and board state.

### Step 2: Remove English text from mission registry and board projection

`src/lib/missions/registry.ts` retains the existing IDs, metrics, targets, rewards and icons exactly. `src/lib/missions/board.ts` no longer copies title/description into `MissionView`.

Do not alter mission progress, reroll, period, claim, or persistence logic.

### Step 3: Translate mission presentation from IDs

`src/i18n/messages/missions.ts` owns `title` and complete `description` templates for every current mission ID. Interpolate targets/game names from domain values only where that makes the sentence clearer; do not reconstruct sentences from translated fragments.

Update `src/pages/missions/index.astro` and any mission client rendering to resolve copy from `missionDefId`.

### Step 4: Localize leaderboard and daily challenge

Translate headings, tabs/period labels, rank/status/empty states, challenge rules, result summaries, countdown labels, buttons and errors shown by:

- `src/pages/games/leaderboard.astro`
- `src/pages/games/daily-challenge.astro`
- `src/lib/blackjack-run/daily-ui.ts`

Put `data-locale={Astro.locals.locale}` on the daily-challenge root and let `daily-ui.ts` read it through the shared locale parser; do not read cookies independently in the game client.

Leave server ranking/challenge result payloads language-neutral.

### Step 5: Tests and verification

Update English-text selectors to stable IDs where necessary. Add direct translator/presentation tests for at least one non-English mission, leaderboard label, and dynamic daily status.

Run:

```bash
bun run test
bun run lint
bun run build
bunx playwright test e2e/daily-challenge.spec.ts
```

Also run the existing mission and leaderboard E2E specs by their current filenames.

Suggested commits:

```text
refactor: make mission board presentation-neutral
feat: localize missions leaderboard and daily challenge
```

---

## Task 4 / PR 4: Game Batch A — Blackjack and Small Client-Module Games

**Purpose:** Establish the repeatable game-page/client pattern on Blackjack, then apply it to smaller self-contained game clients.

**Create message modules:**
- `src/i18n/messages/blackjack.ts`
- `src/i18n/messages/slots.ts`
- `src/i18n/messages/sic-bo.ts`
- `src/i18n/messages/pai-gow-poker.ts`
- `src/i18n/messages/three-card-showdown.ts`
- `src/i18n/messages/video-poker.ts`

**Primary pages:**
- `src/pages/games/blackjack.astro`
- `src/pages/games/blackjack/ranked.astro`
- `src/pages/games/slots.astro`
- `src/pages/games/sic-bo.astro`
- `src/pages/games/pai-gow-poker.astro`
- `src/pages/games/three-card-showdown.astro`
- `src/pages/games/video-poker.astro`

**Primary client/presentation files:**
- `src/lib/blackjack/blackjackClient.ts`
- `src/lib/blackjack/BlackjackUIRenderer.ts`
- `src/lib/blackjack/llmBlackjackStrategy.ts`
- `src/lib/blackjack-run/ranked-ui.ts`
- `src/lib/slots/slotsClient.ts`
- `src/lib/slots/SlotsUIRenderer.ts`
- `src/lib/sic-bo/client.ts`
- `src/lib/pai-gow-poker/client.ts`
- `src/lib/three-card-showdown/client.ts`
- `src/lib/video-poker/client.ts`

### Step 1: Implement one shared browser handoff pattern, not a new framework

For each page root:

```astro
<div id="blackjack-root" data-locale={Astro.locals.locale} ...>
```

At client initialization:

```ts
const locale = normalizeLocaleTag(root.dataset.locale) ?? 'en';
const t = createTranslator(locale, blackjackMessages);
```

Repeat this tiny pattern per game. Do not add a global browser locale store, custom event bus, or client i18n singleton.

### Step 2: Localize Blackjack static and dynamic copy

Translate all player-facing strings in `blackjack.astro` and `blackjackClient.ts`, including outcome summaries, split-hand labels, settlement recovery, settings feedback, action buttons, rules/payouts, accessibility text and achievement toast heading.

Refactor `formatOutcomeMessage()` to use full message templates such as `outcome.single.blackjack`, `outcome.hand`, and `outcome.overall.win` rather than concatenating English fragments.

For `llmBlackjackStrategy.ts`:

- keep the recommended action enum authoritative and locale-neutral;
- localize deterministic reasoning templates;
- pass the selected locale into the optional provider explanation request;
- instruct the provider to explain the already-selected move in that locale, without choosing a new move.

Apply the same locale to ranked Blackjack presentation in `ranked.astro`/`ranked-ui.ts`; do not change ranked run records or settlement data.

### Step 3: Apply the same pattern to the smaller games

For Slots, Sic Bo, Pai Gow Poker, Three Card Showdown and Video Poker, migrate page markup first, then dynamic client/renderer strings. Keep card ranks, payout ratios, numeric values and internal action IDs unchanged.

Only touch game engine files if they currently return player-facing English text. In that case prefer returning an existing enum/result value and translate at the nearest UI renderer; do not create a cross-game result abstraction.

### Step 4: Tests

For each message module, key-completeness is enforced by `defineMessages()`. Add focused tests around dynamic translators where behavior is non-trivial, especially Blackjack outcome formatting and AI reasoning.

Preserve existing gameplay E2E tests. Replace text-as-locator selectors only where translation would otherwise make the test fragile.

Run at minimum:

```bash
bun run test
bun run lint
bun run build
bunx playwright test e2e/blackjack-settings.spec.ts e2e/blackjack-split.spec.ts
```

Also run the existing E2E specs for Slots, Sic Bo, Pai Gow Poker, Three Card Showdown and Video Poker.

Suggested commits:

```text
feat: localize blackjack presentation
feat: localize small card and table game clients
```

---

## Task 5 / PR 5: Game Batch B — Baccarat, Roulette, and Keno

**Purpose:** Migrate the three renderer-heavy games together because each already has a page + client/renderer presentation seam.

**Create:**
- `src/i18n/messages/baccarat.ts`
- `src/i18n/messages/roulette.ts`
- `src/i18n/messages/keno.ts`

**Primary files to modify:**
- `src/pages/games/baccarat.astro`
- `src/lib/baccarat/BaccaratUIRenderer.ts`
- `src/lib/baccarat/llmBaccaratStrategy.ts`
- `src/pages/games/roulette.astro`
- `src/lib/roulette/rouletteClient.ts`
- `src/lib/roulette/RouletteUIRenderer.ts`
- `src/pages/games/keno.astro`
- `src/lib/keno/kenoClient.ts`
- `src/lib/keno/KenoUIRenderer.ts`
- related unit tests
- `e2e/baccarat.spec.ts`
- existing Roulette/Keno E2E specs

### Step 1: Add locale root + translator per game

Use the Task 4 `data-locale` handoff exactly. Do not introduce a second pattern.

### Step 2: Migrate static page copy

Translate game name, rules, bet labels, actions, status placeholders, payouts, settings, AI advisor copy and accessibility labels in each `.astro` file.

### Step 3: Migrate dynamic renderer/client copy

Replace hard-coded status/result/error strings in each client/renderer with feature-local `t()` calls. Prefer full sentence templates with interpolation for amounts, numbers and outcomes.

For Baccarat AI advice, apply the same rule as Blackjack: deterministic action/result stays language-neutral; provider explanations request the active locale only.

### Step 4: Tests and verification

Add focused renderer tests where dynamic text changes. Keep existing gameplay E2E behavior and replace fragile English locators with `data-testid` as needed.

Run:

```bash
bun run test
bun run lint
bun run build
bunx playwright test e2e/baccarat.spec.ts
```

Then run the existing Roulette and Keno E2E specs.

Suggested commit:

```text
feat: localize baccarat roulette and keno
```

---

## Task 6 / PR 6: Remaining Games — Craps, Poker, and Multiplayer Poker

**Purpose:** Finish the largest/most coupled remaining player-facing game surfaces without translating server protocol/domain state.

**Create:**
- `src/i18n/messages/craps.ts`
- `src/i18n/messages/poker.ts`
- `src/i18n/messages/multiplayer-poker.ts`

**Primary files to modify:**
- `src/pages/games/craps.astro`
- `src/lib/craps/llmCrapsStrategy.ts`
- `src/pages/games/poker.astro`
- `src/lib/poker/PokerUIRenderer.ts`
- `src/lib/poker/AIRivalAssistant.ts`
- `src/lib/poker/llmAIStrategy.ts`
- `src/pages/games/poker-mp/index.astro`
- `src/pages/games/poker-mp/[code].astro`
- `src/lib/mp-poker/client.ts`
- related tests
- `e2e/craps.spec.ts`
- existing single-player Poker E2E specs
- `e2e/multiplayer-poker.spec.ts`

### Step 1: Localize Craps without decomposing its game implementation

`craps.astro` is large, but i18n is not a reason to split it into a new component architecture. Add the feature translator, translate static and inline dynamic presentation strings in place, and keep wager IDs/rules/settlement logic unchanged.

Update `llmCrapsStrategy.ts` only for explanation-language presentation; the recommended action remains stable.

### Step 2: Localize single-player Poker at existing renderer seams

Translate page chrome and pass locale to the existing `PokerUIRenderer`/AI presentation code. Keep hand/action/game-state types unchanged.

AI provider prompts should request the selected locale for explanation/dialogue while preserving the locally selected/validated action contract.

### Step 3: Localize multiplayer Poker client-only presentation

Translate lobby/room/table copy in the two multiplayer pages and `src/lib/mp-poker/client.ts`.

Do not add locale to room identity, Durable Object storage, game protocol messages, or player state. If the server sends a user-visible English status today, prefer mapping its existing stable state/error code in the client. Only add a stable code where an English string is genuinely the sole protocol contract needed by the UI; do not redesign the multiplayer protocol wholesale.

### Step 4: Tests and verification

Preserve single-player and multiplayer gameplay tests. Convert text-only locators to stable IDs where necessary.

Run:

```bash
bun run test
bun run lint
bun run build
bunx playwright test e2e/craps.spec.ts
bun run test:e2e:mp
```

Also run the existing single-player Poker E2E specs.

Suggested commits:

```text
feat: localize craps and poker
feat: localize multiplayer poker presentation
```

---

## Task 7 / PR 7: Completeness Audit, Visual QA, and Locale Activation

**Purpose:** Prove the current player-facing app is complete, then make all four locales selectable and automatically detectable in production.

**Create/modify:**
- `src/i18n/messages/messages.test.ts` (aggregate completeness audit if not already present)
- `src/i18n/locale.ts`
- `src/lib/formatting.ts`
- `src/lib/formatting.test.ts`
- `e2e/i18n-foundation.spec.ts`
- `e2e/i18n.spec.ts`
- any migrated surface found incomplete during the audit

### Step 1: Run a source audit before enabling anything

Review all player-facing `.astro` pages plus browser UI/client/renderer files for hard-coded English presentation strings. Exclude tests, developer logs, provider/model identifiers, protocol constants, card ranks and other intentional invariants.

Pay special attention to:

- `aria-label`, `title`, placeholder and alt fallback text;
- empty/loading/error states;
- toast/dialog/status text created in TypeScript;
- achievement/mission names;
- AI deterministic reasoning and provider prompt language;
- number/date formatting still pinned to `en-US`.

Fix omissions in this PR rather than activating an incomplete locale.

### Step 2: Aggregate message completeness

`src/i18n/messages/messages.test.ts` imports every feature message module and verifies that the runtime key sets for `zh-Hant`, `zh-Hans`, and `ja` exactly match `en`. This complements TypeScript typing and catches accidental dynamic/object construction.

Run:

```bash
bun test src/i18n
```

Expected: PASS for every message module.

### Step 3: Remove transitional English formatting defaults

After all player-facing callers have migrated, make locale-sensitive formatting helpers require an explicit `Locale` rather than defaulting to `en`. Let TypeScript/test failures reveal missed callers, then fix them.

This is deliberately delayed until the final PR so Tasks 1–6 remain incremental without maintaining a parallel compatibility layer afterward.

### Step 4: Perform visual QA before activation

Exercise at least desktop and narrow/mobile widths in all four locales on representative surfaces:

- home/global shell;
- profile/achievements;
- missions/leaderboard;
- one compact game UI;
- one text-heavy game UI;
- multiplayer lobby/room.

Check clipping, wrapping, button sizing, vertical rhythm and CJK font fallback. Prefer normal responsive/CSS fixes. Do not add a bundled CJK font unless the actual target-platform fallback is materially unreadable; if a font package becomes necessary, stop activation and get that scope approved rather than silently expanding the PR.

### Step 5: Enable all four locales

Only after Steps 1–4 pass, change:

```ts
export const ENABLED_LOCALES: readonly Locale[] = [
  'en',
  'zh-Hant',
  'zh-Hans',
  'ja',
];
```

The existing middleware and picker should require no other activation mechanism.

### Step 6: Add activation E2E coverage

`e2e/i18n.spec.ts` should verify one complete user path:

1. Open the site with English.
2. Use the visible picker to choose Japanese (or one Chinese locale).
3. Assert the `arcturus_locale` cookie.
4. Assert `<html lang>` and a representative localized shell label after reload.
5. Navigate to another migrated page and assert locale persistence.
6. Start a fresh context without the cookie but with `Accept-Language: zh-TW` and verify automatic `zh-Hant` selection.
7. Verify an unsupported browser language falls back to English.

Update `e2e/i18n-foundation.spec.ts` so its former disabled-locale guard expectations now reflect all four enabled locales, or fold non-overlapping checks into `i18n.spec.ts` and delete the redundant file.

Do not duplicate every gameplay E2E suite per locale.

### Step 7: Final verification

Run:

```bash
bun run test
bun run lint
bun run format:check
bun run build
bunx playwright test e2e/i18n.spec.ts
bun run test:e2e:ci
```

Expected: all checks pass before locale activation merges.

Suggested commits:

```text
test: audit i18n completeness
feat: enable four production locales
```

---

## Resulting Architecture After Task 7

The final system should still be small:

```text
Request
  -> middleware resolves enabled locale
  -> Astro.locals.locale
       -> Astro page/layout translator
       -> data-locale on interactive game root
            -> existing game client/renderer translator

Stable domain IDs/enums/data
  -> presentation lookup
  -> localized text
```

There is no locale route tree, global client state store, database preference, translation service, translated domain model, or game-specific i18n framework. Adding a fifth language later is primarily translation work plus one supported/enabled locale entry, not an architectural project.
