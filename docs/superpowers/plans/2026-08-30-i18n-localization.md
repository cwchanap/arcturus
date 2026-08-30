# Arcturus i18n Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add complete English, Traditional Chinese, Simplified Chinese, and Japanese localization to the current Arcturus player experience without changing URLs, persisting translated domain data, or introducing a runtime i18n framework.

**Architecture:** Resolve one enabled locale per request in Astro middleware and expose it once on the root `<html>` element. Use a small typed TypeScript translation layer under `src/lib/i18n/`, one shared game-name catalog, and feature-local dictionaries for static and dynamic presentation. Browser renderers read the document locale; domain/game/protocol values remain language-neutral and player-facing strings are produced only at presentation boundaries.

**Tech Stack:** Astro 5, TypeScript, Bun test, Vitest, Playwright, Cloudflare Workers/D1. No new runtime i18n dependency.

**Spec:** `docs/superpowers/specs/2026-08-30-i18n-localization-design.md`

## Global Constraints

- Supported locales are exactly `en`, `zh-Hant`, `zh-Hans`, and `ja`.
- `SUPPORTED_LOCALES = ['en', 'zh-Hant', 'zh-Hans', 'ja']` from Task 1 onward.
- `ENABLED_LOCALES = ['en']` through Tasks 1–7; Task 8 enables all four together.
- Disabled locales must not be selected by picker, cookie, or `Accept-Language` in production request resolution.
- Eight rollout tickets map to eight implementation PRs, merged sequentially. One ticket must not be split across multiple PRs without explicit approval.
- Every feature PR authors all four translations for the surface it migrates even while production remains English-only.
- English is the authoring locale. Every migrated dictionary must have matching keys across all four locales before merge.
- Use complete sentence templates with named interpolation; do not assemble English-shaped fragments.
- Keep game, mission, achievement, multiplayer protocol, and persistence identifiers language-neutral.
- Do not create locale routes, locale DB columns, a CMS, ICU parsing, i18next/FormatJS, an environment locale flag, or a feature-flag service.
- Do not add bundled CJK fonts unless visual verification demonstrates a material problem.
- Reuse `src/lib/formatting.ts`, the existing settlement messages seam, and existing game renderers/clients. Do not refactor game engines unrelated to presentation.
- Locale is written once on `<html>`; do not add a locale attribute independently to each game root.
- Game display names have one translation source; feature dictionaries must not duplicate them.
- For every translation PR, temporarily set local `ENABLED_LOCALES` to all four, visually inspect only the migrated surfaces in all four locales, then revert the constant before committing/merging.

---

## Task 1 / PR 1: i18n Foundation, Shared Game Names, and Global Shell

**Purpose:** Establish the shared primitives and reuse seams that every later migration depends on while production remains English-only.

**Files:**
- Create: `src/lib/i18n/locale.ts`
- Create: `src/lib/i18n/locale.test.ts`
- Create: `src/lib/i18n/translate.ts`
- Create: `src/lib/i18n/translate.test.ts`
- Create: `src/lib/i18n/messages/common.ts`
- Create: `src/lib/i18n/messages/games.ts`
- Create: `src/components/LanguagePicker.astro`
- Create: `e2e/i18n-foundation.spec.ts`
- Modify: `src/env.d.ts`
- Modify: `src/middleware.ts`
- Modify: `src/layouts/AppLayout.astro`
- Modify: `src/components/UserNav.astro`
- Modify: `src/lib/game-stats/constants.ts`
- Modify: `src/lib/formatting.ts`
- Modify: `src/lib/formatting.test.ts`
- Modify: `src/lib/wallet/public-game-settlement.ts`
- Modify: `src/lib/wallet/public-game-settlement.test.ts`
- Modify mechanically for the new settlement message field: `src/lib/sic-bo/client.ts`
- Modify mechanically for the new settlement message field: `src/lib/pai-gow-poker/client.ts`
- Modify mechanically for the new settlement message field: `src/lib/three-card-showdown/client.ts`
- Modify mechanically for the new settlement message field: `src/lib/video-poker/client.ts`

**Interfaces:**
- Produces: `Locale`, `SUPPORTED_LOCALES`, `ENABLED_LOCALES`, `LOCALE_COOKIE`.
- Produces: `normalizeLocaleTag(tag): Locale | null`.
- Produces: `resolveRequestLocale({ cookieLocale, acceptLanguage, enabledLocales? }): Locale`.
- Produces: `getDocumentLocale(doc?: Document): Locale`.
- Produces: `defineMessages()` and `createTranslator()`.
- Produces: `getGameName(locale, key)` for all `GAME_TYPES` plus `daily-challenge`, `poker-mp`, and `blackjack-ranked`.
- Extends: locale-sensitive helpers in `src/lib/formatting.ts` with `locale: Locale = 'en'`.
- Extends: `PublicGameSettlementMessages` with required `retryLabel`.

- [ ] **Step 1: Write failing locale-resolution tests**

Create `src/lib/i18n/locale.test.ts` with the contract:

```ts
expect(normalizeLocaleTag('zh-TW')).toBe('zh-Hant');
expect(normalizeLocaleTag('zh-CN')).toBe('zh-Hans');
expect(normalizeLocaleTag('zh')).toBe('zh-Hans');
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

expect(resolveRequestLocale({
  cookieLocale: null,
  acceptLanguage: 'fr-CA,zh-TW;q=0.8,ja;q=0.7',
  enabledLocales: ['en', 'zh-Hant', 'ja'],
})).toBe('zh-Hant');
```

Also assert cookie precedence, malformed/disabled cookie skipping, q-value ordering, and English fallback when no recognized enabled match exists.

Run `bun test src/lib/i18n/locale.test.ts`; expect RED because the module does not exist.

- [ ] **Step 2: Implement the minimal locale module**

Implement only:

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
export function getDocumentLocale(doc?: Document): Locale;
```

`getDocumentLocale()` reads `document.documentElement.dataset.locale ?? document.documentElement.lang`, normalizes it, and returns `en` only for an absent/malformed document value. Parse `Accept-Language` locally; add no dependency.

Run the locale test again; expect PASS.

- [ ] **Step 3: Write and implement translator tests**

`src/lib/i18n/translate.test.ts` proves four-locale key parity, English development fallback, repeated named interpolation, and non-throwing missing interpolation:

```ts
const messages = defineMessages({
  en: { greeting: 'Hello {name}', repeat: '{value} / {value}' },
  'zh-Hant': { greeting: '你好，{name}', repeat: '{value} / {value}' },
  'zh-Hans': { greeting: '你好，{name}', repeat: '{value} / {value}' },
  ja: { greeting: 'こんにちは、{name}', repeat: '{value} / {value}' },
});

expect(createTranslator('ja', messages)('greeting', { name: 'Aki' }))
  .toBe('こんにちは、Aki');
```

Run RED, implement only `defineMessages()` and `createTranslator()`, then run GREEN. Do not add nested paths, ICU syntax, namespaces, or a singleton registry.

- [ ] **Step 4: Create one canonical game-name dictionary**

Keep `GAME_TYPE_LABELS` as the canonical English map for `GAME_TYPES`; change `poker` to `Texas Hold'em Poker`.

`src/lib/i18n/messages/games.ts` reuses that English map and adds:

```ts
'daily-challenge': 'Daily Challenge'
'poker-mp': 'Multiplayer Poker'
'blackjack-ranked': 'Ranked Blackjack'
```

Export:

```ts
export type GameNameKey =
  | keyof typeof GAME_TYPE_LABELS
  | 'daily-challenge'
  | 'poker-mp'
  | 'blackjack-ranked';
export function getGameName(locale: Locale, key: GameNameKey): string;
```

Test all `GAME_TYPES` plus extras in all four locales. Later feature dictionaries must reference these keys, not retranslate game names.

- [ ] **Step 5: Extend existing formatting helpers with locale**

Add `locale: Locale = 'en'` to locale-sensitive helpers in `src/lib/formatting.ts` while preserving current validation semantics. Keep numeric formatting separate from translated nouns. Task 2 removes/replaces `formatSignedChipResult()` rather than making it an i18n helper.

Run `bun test src/lib/formatting.test.ts` with new `en`, `zh-Hant`, and `ja` assertions.

- [ ] **Step 6: Wire locale before middleware early returns**

At the top of `onRequest`:

```ts
context.locals.locale = resolveRequestLocale({
  cookieLocale: context.cookies.get(LOCALE_COOKIE)?.value,
  acceptLanguage: context.request.headers.get('accept-language'),
});
```

Add `locale: Locale` to `App.Locals`. The no-DB/auth path must receive locale before `next()`.

- [ ] **Step 7: Put locale on `<html>` once and migrate the shell**

Use:

```astro
<html lang={locale} data-locale={locale}>
```

Translate current header/footer/nav/legal/chip phrases through `messages/common.ts`, use locale-aware number formatting, and update `UserNav.astro`. Do not add locale attributes to game roots.

- [ ] **Step 8: Add the language picker**

Render only `ENABLED_LOCALES`. When multiple locales are enabled, selecting one writes a one-year `arcturus_locale` cookie with `Path=/; SameSite=Lax` and reloads the current URL. Hide the control while English is the only enabled locale.

- [ ] **Step 9: Extend the shared settlement message seam and pin all current call sites**

Change:

```ts
export type PublicGameSettlementMessages = {
  failed: string;
  retrying: string;
  retryFailed: string;
  retryLabel: string;
};
```

Use `options.messages.retryLabel` in `public-game-settlement.ts`. Update the four current `createPublicGameSettlementController` clients listed in this task to pass the existing English `Retry settlement` only; their full localization remains in Task 5.

Change shared balance synchronization to `getDocumentLocale(root.ownerDocument)` + shared formatting/common chip-count copy instead of `toLocaleString('en-US')` / `${formatted} chips`.

Run `bun test src/lib/wallet/public-game-settlement.test.ts` plus the four affected client unit tests.

- [ ] **Step 10: Add the production rollout-guard E2E**

Set a Japanese cookie and Japanese `Accept-Language` while only English is enabled and assert `<html lang="en" data-locale="en">`, English shell copy, and no disabled picker options.

Run `bunx playwright test e2e/i18n-foundation.spec.ts`.

- [ ] **Step 11: Local four-locale visual check, then revert activation**

Temporarily enable all four locally; inspect `/` plus one authenticated shell page at desktop/narrow widths for wrapping and CJK fallback. Restore `ENABLED_LOCALES = ['en']` before staging.

- [ ] **Step 12: Verify PR 1**

```bash
bun run test
bun run lint
bun run format:check
bun run build
bunx playwright test e2e/i18n-foundation.spec.ts
```

Suggested commits: `test: define locale and translation contracts`, `feat: add typed i18n foundation and game names`, `feat: localize shared shell seams`.

---

## Task 2 / PR 2: Home, Auth, Profile, Statistics, and Achievements

**Purpose:** Migrate account/discovery presentation and remove English achievement names from settlement/domain data.

**Files:**
- Create: `src/lib/i18n/messages/home.ts`
- Create: `src/lib/i18n/messages/auth.ts`
- Create: `src/lib/i18n/messages/profile.ts`
- Create: `src/lib/i18n/messages/achievements.ts`
- Modify: `src/pages/index.astro`
- Modify: `src/components/GameCard.astro`
- Modify: `src/pages/signin.astro`
- Modify: `src/pages/profile.astro`
- Modify: `src/pages/profile/statistics.astro`
- Modify: `src/components/profile/PlayerStatisticsSummary.astro`
- Modify: `src/lib/profile-statistics-renderer.ts`
- Modify: `src/lib/profile-statistics-renderer.test.ts`
- Modify: `src/lib/profile-statistics-client.ts`
- Modify: `src/lib/profile-statistics-client.test.ts`
- Modify: `src/lib/achievements/types.ts`
- Modify: `src/lib/achievements/achievement-rules.ts`
- Modify: `src/lib/achievements/achievement-rules.test.ts`
- Modify: `src/lib/achievements/achievements.ts`
- Modify: `src/lib/achievements/achievements.test.ts`
- Modify: `src/lib/wallet/types.ts`
- Modify: `src/lib/wallet/settle.ts`
- Modify: `src/lib/wallet/settle.test.ts`
- Modify: `src/lib/achievement-toast.ts`
- Modify: `src/lib/achievement-toast.test.ts`
- Modify: `src/lib/formatting.ts`
- Modify: `src/lib/formatting.test.ts`
- Test: `integration/profile-page.test.ts`
- Test: `e2e/auth-ui.spec.ts`
- Test: `e2e/profile.spec.ts`
- Test: `e2e/profile-statistics.spec.ts`

**Interfaces:**
- Consumes: Task 1 document locale, translator, formatting, and `getGameName()`.
- Produces: achievement presentation lookup keyed by `AchievementId`.
- Changes: settlement/toast achievement payload from `{ id, name, icon }` to `{ id, icon }`.

- [ ] **Step 1: Add failing achievement presentation tests**

For every `ACHIEVEMENT_IDS` member, assert all four locales resolve name/description. Include localized threshold formatting for the comeback achievement. Keep unlock-rule tests locale-neutral.

- [ ] **Step 2: Make achievement definitions language-neutral**

Change:

```ts
export interface AchievementDefinition {
  id: AchievementId;
  category: AchievementCategory;
  icon: string;
}
```

Remove `name`/`description` from `ACHIEVEMENTS`; preserve IDs, categories, icons, thresholds, checks, and persistence. Logs use the ID.

- [ ] **Step 3: Remove achievement English from wallet results**

Change `SettleRoundResult.newAchievements` to `Array<{ id: string; icon: string }>` and update `buildFreshResult()` plus wallet tests. No translated achievement name crosses the wallet API.

- [ ] **Step 4: Resolve toast names by ID and document locale**

Change `AchievementToastEntry` to `{ id, icon }`. On display, read `getDocumentLocale()` and resolve the localized achievement name. Preserve timing/queue behavior. Test a Japanese document locale while the queued entry carries only ID/icon.

- [ ] **Step 5: Migrate home and `GameCard` without duplicating game names**

Replace home game-name strings with stable `GameNameKey`s. `GameCard.astro` localizes `Featured`, `{count} playing`, `Min {value}`, and `Play`, and formats player count with active locale. Game titles come only from `getGameName()`.

- [ ] **Step 6: Migrate sign-in/profile Astro copy**

Translate page titles/headings, auth calls to action, verification states, account labels, tips, AI settings labels/status, accessibility fallback labels, loading/error shells, and statistics headings. Provider/model identifiers remain unchanged.

- [ ] **Step 7: Localize `profile-statistics-renderer.ts` and its client shell**

Renderer reads `getDocumentLocale(root.ownerDocument)` and localizes summary labels, empty state, game names, played state, metrics, ranks, `Unranked`, and action links. Pass locale into numeric formatters.

Replace `formatSignedChipResult()` with neutral signed numeric formatting plus complete translated chip-result templates; delete the English helper when its callers are gone. Preserve `profile-statistics-client.ts` fetch flow; update only player-facing state and tests.

- [ ] **Step 8: Stabilize and run tests**

Use test IDs where English text was only a locator. Run:

```bash
bun test src/lib/achievements src/lib/achievement-toast.test.ts src/lib/profile-statistics-renderer.test.ts src/lib/profile-statistics-client.test.ts
bunx vitest run integration/profile-page.test.ts
bunx playwright test e2e/auth-ui.spec.ts e2e/profile.spec.ts e2e/profile-statistics.spec.ts
```

- [ ] **Step 9: Local four-locale visual check**

Temporarily enable all locales; inspect `/`, `/signin`, `/profile`, `/profile/statistics`, game cards, statistics cards, forms, and an achievement toast. Revert activation.

- [ ] **Step 10: Verify PR 2**

Run `bun run test`, `bun run lint`, `bun run format:check`, and `bun run build`.

---

## Task 3 / PR 3: Missions, Leaderboard, and Daily Challenge

**Purpose:** Keep progression/ranking APIs language-neutral while localizing their SSR and browser presentation.

**Files:**
- Create: `src/lib/i18n/messages/missions.ts`
- Create: `src/lib/i18n/messages/leaderboard.ts`
- Create: `src/lib/i18n/messages/daily-challenge.ts`
- Modify: `src/lib/missions/types.ts`
- Modify: `src/lib/missions/registry.ts`
- Modify: `src/lib/missions/registry.test.ts`
- Modify: `src/lib/missions/board.ts`
- Modify: `src/lib/missions/board.test.ts`
- Modify: `src/pages/missions/index.astro`
- Modify: `src/pages/games/leaderboard.astro`
- Modify: `src/pages/games/daily-challenge.astro`
- Modify: `src/lib/blackjack-run/daily-ui.ts`
- Modify: `src/lib/blackjack-run/daily-ui.test.ts`
- Test: `e2e/missions.spec.ts`
- Test: `e2e/leaderboard.spec.ts`
- Test: `e2e/daily-challenge.spec.ts`

**Interfaces:**
- Changes: `MissionDefinition`/`MissionView` no longer carry `title`/`description`.
- Produces: mission presentation lookup by `missionDefId`.

- [ ] **Step 1: Pin language-neutral mission types with failing tests**

Expected `MissionDefinition` contains only ID, period, metric, target, reward, icon. Expected `MissionView` contains `missionDefId` plus progress/domain values but no copy. Run board/registry tests RED.

- [ ] **Step 2: Remove English from registry and board/API projection**

Delete title/description fields without changing mission IDs, metrics, target values, rewards, rerolls, claims, streaks, or DB queries.

- [ ] **Step 3: Add mission copy keyed by every current mission ID**

Cover exactly `daily-blackjack-5`, `daily-win-3`, `daily-slots-20`, `daily-craps-3`, `daily-baccarat-3`, `daily-keno-5`, `weekly-games-3`. Use shared game names inside complete sentence templates.

- [ ] **Step 4: Update initial and refreshed mission rendering**

`src/pages/missions/index.astro` resolves title/description from `missionDefId` in both SSR and the JS path that re-renders `/api/missions/board`. Translate streak, claim/reroll, reset, completion, and error copy.

- [ ] **Step 5: Localize leaderboard using shared game names**

Translate controls, headings, metrics, rank/empty/error states, rows, and accessibility labels. Game names come from `getGameName()`; number/percentage/chip formatting uses locale.

- [ ] **Step 6: Localize Daily Challenge and `daily-ui.ts`**

Translate rules, status/countdown, result summary, rank, actions, loading/error/retry, and header balance. `daily-ui.ts` reads `getDocumentLocale(root.ownerDocument)`; no game-root locale attribute. Replace hard-coded `en-US` formatting.

- [ ] **Step 7: Run tests**

```bash
bun test src/lib/missions src/lib/blackjack-run/daily-ui.test.ts
bunx playwright test e2e/missions.spec.ts e2e/leaderboard.spec.ts e2e/daily-challenge.spec.ts
```

- [ ] **Step 8: Local four-locale visual check**

Temporarily enable all; inspect missions, leaderboard, and Daily Challenge on desktop/mobile, then revert.

- [ ] **Step 9: Verify PR 3**

Run `bun run test`, `bun run lint`, `bun run format:check`, `bun run build`.

---

## Task 4 / PR 4: Blackjack and Ranked Blackjack

**Purpose:** Localize casual/ranked Blackjack as one coherent game family without bundling unrelated games.

**Files:**
- Create: `src/lib/i18n/messages/blackjack.ts`
- Modify: `src/pages/games/blackjack.astro`
- Modify: `src/pages/games/blackjack/ranked.astro`
- Modify: `src/lib/blackjack/blackjackClient.ts`
- Modify: `src/lib/blackjack/blackjackClient.init.test.ts`
- Modify: `src/lib/blackjack/blackjackClient.test.ts`
- Modify: `src/lib/blackjack/llmBlackjackStrategy.ts`
- Modify: `src/lib/blackjack/llmBlackjackStrategy.test.ts`
- Modify: `src/lib/blackjack/presentation.ts`
- Modify: `src/lib/blackjack/presentation.test.ts`
- Modify: `src/lib/blackjack-run/client.ts` for ranked/common player copy it owns
- Modify: `src/lib/blackjack-run/ranked-ui.ts`
- Modify: `src/lib/blackjack-run/ranked-ui.test.ts`
- Test: `e2e/blackjack-settings.spec.ts`
- Test: `e2e/blackjack-split.spec.ts`
- Test: `e2e/blackjack-llm.spec.ts`
- Test: `e2e/ranked-blackjack.spec.ts`

- [ ] **Step 1: Add failing Blackjack message tests**

Cover page headings, wager controls, dealer/player labels, actions, outcomes, split summaries, recovery, settings, AI advisor, ranked countdown/status/results, and accessibility. Assert Japanese single-hand and Traditional Chinese split-hand dynamic messages.

- [ ] **Step 2: Localize casual Blackjack SSR**

Translate all static page copy/ARIA/title/rules/settings/payouts; use shared game-name keys for Blackjack/Daily Challenge/ranked link.

- [ ] **Step 3: Localize `blackjackClient.ts` dynamic copy**

Read document locale once and translate outcome/split summaries, recovery/reset, balance/current bet, settings feedback, AI button/status/failure, and recovery labels. Do not change game/settlement state.

- [ ] **Step 4: Localize deterministic and provider advice**

Add locale to advice presentation calls while keeping `recommendedAction` unchanged. Local deterministic reasoning uses messages; optional AI prompt requests the locale but may not change the selected move. Test identical decisions across locales.

- [ ] **Step 5: Localize ranked renderer and formatting**

Replace ranked `Intl.NumberFormat('en-US')`, `toLocaleString('en-US')`, `${formatted} chips`, status/countdown/result/action/error copy with document locale + shared helpers/messages.

- [ ] **Step 6: Run Blackjack-family tests**

```bash
bun test src/lib/blackjack src/lib/blackjack-run/ranked-ui.test.ts src/lib/blackjack-run/client.test.ts
bunx playwright test e2e/blackjack-settings.spec.ts e2e/blackjack-split.spec.ts e2e/blackjack-llm.spec.ts e2e/ranked-blackjack.spec.ts
```

- [ ] **Step 7: Local four-locale visual check**

Inspect casual/ranked Blackjack including split layout, settings, advice, countdown/result, and narrow controls; revert activation.

- [ ] **Step 8: Verify PR 4**

Run `bun run test`, `bun run lint`, `bun run format:check`, `bun run build`.

---

## Task 5 / PR 5: Small Client-Module Games

**Purpose:** Localize Slots, Sic Bo, Pai Gow Poker, Three-Card Showdown, and Video Poker while converting their player-facing validation strings to stable codes.

**Files:**
- Create: `src/lib/i18n/messages/slots.ts`
- Create: `src/lib/i18n/messages/sic-bo.ts`
- Create: `src/lib/i18n/messages/pai-gow-poker.ts`
- Create: `src/lib/i18n/messages/three-card-showdown.ts`
- Create: `src/lib/i18n/messages/video-poker.ts`
- Modify: `src/lib/bet-validation.ts`
- Modify: `src/lib/bet-validation.test.ts`
- Modify: `src/pages/games/slots.astro`, `src/lib/slots/slotsClient.ts`, `src/lib/slots/slotsClient.test.ts`
- Modify: `src/pages/games/sic-bo.astro`, `src/lib/sic-bo/game.ts`, `src/lib/sic-bo/game.test.ts`, `src/lib/sic-bo/client.ts`, `src/lib/sic-bo/client.init.test.ts`
- Modify: `src/pages/games/pai-gow-poker.astro`, `src/lib/pai-gow-poker/game.ts`, `src/lib/pai-gow-poker/game.test.ts`, `src/lib/pai-gow-poker/rules.ts`, `src/lib/pai-gow-poker/rules.test.ts`, `src/lib/pai-gow-poker/client.ts`, `src/lib/pai-gow-poker/client.init.test.ts`
- Modify: `src/pages/games/three-card-showdown.astro`, `src/lib/three-card-showdown/game.ts`, `src/lib/three-card-showdown/game.test.ts`, `src/lib/three-card-showdown/client.ts`, `src/lib/three-card-showdown/client.init.test.ts`
- Modify: `src/pages/games/video-poker.astro`, `src/lib/video-poker/game.ts`, `src/lib/video-poker/game.test.ts`, `src/lib/video-poker/client.ts`, `src/lib/video-poker/client.init.test.ts`
- Test: `e2e/slots.spec.ts`, `e2e/sic-bo.spec.ts`, `e2e/pai-gow-poker.spec.ts`, `e2e/three-card-showdown.spec.ts`, `e2e/video-poker.spec.ts`

**Interfaces:**
- Produces: `validateBetCode()` while preserving existing English `validateBet()` only for unmigrated callers.
- Produces: local closed wager/arrangement code unions in migrated games.

- [ ] **Step 1: Add a language-neutral shared bet-validation result**

Add:

```ts
export type BetValidationCode = 'invalid-limits' | 'invalid-range' | 'out-of-range';
export function validateBetCode(amount: number, minBet: number, maxBet: number): BetValidationCode | null;
```

Refactor current `validateBet()` to wrap it and preserve current English strings temporarily. Test codes directly.

- [ ] **Step 2: Convert Sic Bo, Three-Card, and Video Poker wager display errors to codes**

Each `getWagerError()` returns a local union of `BetValidationCode` plus game-specific `whole-number-required` / `insufficient-balance` codes. Clients translate codes; internal invariant throws may contain codes but do not source UI copy.

- [ ] **Step 3: Convert Pai Gow wager and arrangement errors to codes**

Apply the wager rule. Replace arrangement error strings in `rules.ts` with `PaiGowArrangementErrorCode`; client maps them to complete localized messages.

Move `CATEGORY_LABELS` into the Pai Gow dictionary. Keep visible rank glyphs; localize `Jack/Queen/King/Ace`, suit names, `Joker`, and complete accessible card names.

- [ ] **Step 4: Localize all five SSR/client surfaces**

Translate title/back link, balance/wager labels, actions, status/outcomes, rules/paytables, settlement failure/retry/reset, settings, ARIA/title/alt text. Use `getGameName()`, `getDocumentLocale()`, locale formatting, and localized `retryLabel`. Do not alter payouts/probabilities/evaluators.

- [ ] **Step 5: Keep evaluator identities neutral**

Translate hand/category names only where rendered. Evaluator/domain category values remain unchanged.

- [ ] **Step 6: Run tests**

```bash
bun test src/lib/bet-validation.test.ts src/lib/slots src/lib/sic-bo src/lib/pai-gow-poker src/lib/three-card-showdown src/lib/video-poker
bunx playwright test e2e/slots.spec.ts e2e/sic-bo.spec.ts e2e/pai-gow-poker.spec.ts e2e/three-card-showdown.spec.ts e2e/video-poker.spec.ts
```

- [ ] **Step 7: Local four-locale visual check**

Inspect all five pages, especially paytables, action grids, Pai Gow arrangement/accessibility, and narrow labels; revert activation.

- [ ] **Step 8: Verify PR 5**

Run `bun run test`, `bun run lint`, `bun run format:check`, `bun run build`.

---

## Task 6 / PR 6: Baccarat, Roulette, and Keno

**Purpose:** Localize the three renderer-heavy public games through their existing renderer/client seams.

**Files:**
- Create: `src/lib/i18n/messages/baccarat.ts`
- Create: `src/lib/baccarat/BaccaratUIRenderer.test.ts`
- Modify: `src/pages/games/baccarat.astro`
- Modify: `src/lib/baccarat/BaccaratUIRenderer.ts`
- Modify: `src/lib/baccarat/llmBaccaratStrategy.ts`
- Modify: `src/lib/baccarat/llmBaccaratStrategy.test.ts`
- Create: `src/lib/i18n/messages/roulette.ts`
- Modify: `src/pages/games/roulette.astro`
- Modify: `src/lib/roulette/RouletteUIRenderer.ts`
- Modify: `src/lib/roulette/RouletteUIRenderer.test.ts`
- Modify: `src/lib/roulette/rouletteClient.ts`
- Modify: `src/lib/roulette/rouletteClient.integration.test.ts`
- Modify: `src/lib/roulette/spin-error-classification.ts`
- Modify: `src/lib/roulette/spin-error-classification.test.ts`
- Create: `src/lib/i18n/messages/keno.ts`
- Modify: `src/pages/games/keno.astro`
- Modify: `src/lib/keno/KenoUIRenderer.ts`
- Modify: `src/lib/keno/KenoUIRenderer.test.ts`
- Modify: `src/lib/keno/kenoClient.ts`
- Modify: `src/lib/keno/kenoClient.test.ts`
- Test: `e2e/baccarat.spec.ts`, `e2e/roulette.spec.ts`, `e2e/keno.spec.ts`

- [ ] **Step 1: Add representative non-English renderer tests**

Set document locale in the renderer/client tests and assert one dynamic Japanese/Traditional Chinese state for each game before implementation.

- [ ] **Step 2: Localize Baccarat through renderer/advice seams**

Translate SSR rules/actions and renderer state/outcomes. Deterministic/LLM advice keeps authoritative recommendation neutral and localizes only explanation. Convert any displayed shared bet validation to `validateBetCode()` + Baccarat messages.

- [ ] **Step 3: Localize Roulette code-to-copy mapping**

Keep `SpinHttpError` status/code unchanged. Change to:

```ts
messageForSpinRejection(err: SpinHttpError, locale: Locale): string
```

Resolve `401`, `INSUFFICIENT_BALANCE`, `SETTLEMENT_CONFLICT`, and default rejection in Roulette messages. Translate page/renderer/client state, recovery, and accessibility.

- [ ] **Step 4: Localize Keno renderer/client**

Translate page, selection guidance, quick-pick/clear/draw, result/status, payouts, recovery, errors, and accessibility using existing renderer/client seams and locale formatting.

- [ ] **Step 5: Run tests**

```bash
bun test src/lib/baccarat src/lib/roulette src/lib/keno
bunx playwright test e2e/baccarat.spec.ts e2e/roulette.spec.ts e2e/keno.spec.ts
```

- [ ] **Step 6: Local four-locale visual check**

Inspect all three game layouts and dynamic result panels at desktop/mobile; revert activation.

- [ ] **Step 7: Verify PR 6**

Run `bun run test`, `bun run lint`, `bun run format:check`, `bun run build`.

---

## Task 7 / PR 7: Craps, Poker, and Multiplayer Poker

**Purpose:** Finish the largest remaining player surfaces while leaving multiplayer/server protocol state untouched.

**Files:**
- Create: `src/lib/i18n/messages/craps.ts`
- Modify: `src/pages/games/craps.astro`
- Modify: `src/lib/craps/constants.ts`
- Modify: `src/lib/craps/CrapsGame.ts`
- Modify: `src/lib/craps/CrapsGame.test.ts`
- Modify: `src/lib/craps/llmCrapsStrategy.ts`
- Modify: `src/lib/craps/craps-advice.test.ts`
- Create: `src/lib/i18n/messages/poker.ts`
- Modify: `src/pages/games/poker.astro`
- Modify: `src/lib/poker/constants.ts`
- Modify: `src/lib/poker/PokerUIRenderer.ts`
- Modify: `src/lib/poker/PokerUIRenderer.test.ts`
- Modify: `src/lib/poker/AIRivalAssistant.ts`
- Modify: `src/lib/poker/AIRivalAssistant.test.ts`
- Modify: `src/lib/poker/llmAIStrategy.ts`
- Modify: `src/lib/poker/llmAIStrategy.test.ts`
- Create: `src/lib/i18n/messages/multiplayer-poker.ts`
- Modify: `src/pages/games/poker-mp/index.astro`
- Modify: `src/pages/games/poker-mp/[code].astro`
- Modify: `src/lib/mp-poker/client.ts`
- Modify: `src/lib/mp-poker/client.test.ts`
- Test: `e2e/craps.spec.ts`, `e2e/poker-turn-flow.spec.ts`, `e2e/multiplayer-poker.spec.ts`

**Interfaces:**
- Keeps: `src/lib/mp-poker/protocol.ts` and server room protocol values language-neutral.
- Produces: `CrapsBetErrorCode` from `CrapsGame.canPlaceBet()` instead of player-facing English.
- Changes: Craps bet display labels and Poker hand names become presentation lookups.

- [ ] **Step 1: Add failing Craps/Poker/MP presentation tests**

Add a non-English dynamic assertion for each surface. For MP, prove a localized room/lobby status while mocked protocol values remain unchanged.

- [ ] **Step 2: Convert Craps validation and bet labels to presentation-neutral values**

Change `CrapsGame.canPlaceBet()` from `{ ok: boolean; error?: string }` to a closed code result:

```ts
export type CrapsBetErrorCode =
  | 'invalid-amount'
  | 'come-out-only'
  | 'point-only'
  | 'missing-pass-line'
  | 'missing-dont-pass'
  | 'duplicate-pass-line'
  | 'duplicate-dont-pass'
  | 'below-minimum'
  | 'above-maximum'
  | 'above-max-odds'
  | 'insufficient-balance';
```

Include structured numeric/context values separately where the translated message needs them (for example min/max/remaining/multiplier), rather than embedding them in an English string.

Stop using `BET_LABELS` as the player-facing source. `messages/craps.ts` maps `BetType` directly to localized display labels. If `BET_LABELS` is still needed internally only to validate restored bet keys, replace it with a language-neutral key/set structure or rename/retype it so no English display value remains in domain constants.

Update `CrapsGame.test.ts` to assert codes/context, not English sentences.

- [ ] **Step 3: Localize Craps page and advice**

Translate table/bet labels/descriptions, status/results, settings, recovery, rules, and accessibility in `craps.astro` from stable bet/domain values. Translate deterministic/LLM explanation text while keeping recommendation identities neutral.

- [ ] **Step 4: Move Poker hand names to the Poker dictionary and localize UI/advice**

Keep `HAND_RANKINGS` numeric; stop using English `HAND_NAMES` as UI data. Renderer/advisor resolves hand/category keys through `messages/poker.ts`.

Translate page actions, table labels, status, settings, AI rival/advice, errors, rules, and accessible card/hand copy. Provider prompts request active language but cannot change authoritative decisions.

- [ ] **Step 5: Localize multiplayer Poker without translating protocol**

Translate lobby/create/join copy and room/table/action/status/error/accessibility in the two Astro pages and `mp-poker/client.ts`. Use existing protocol codes/state as lookup inputs; do not alter protocol message types, room codes, timers, websocket/server state.

- [ ] **Step 6: Run tests**

```bash
bun test src/lib/craps src/lib/poker src/lib/mp-poker
bunx playwright test e2e/craps.spec.ts e2e/poker-turn-flow.spec.ts
bun run test:e2e:mp
```

Use the dedicated MP configuration/script; do not invent another harness.

- [ ] **Step 7: Local four-locale visual check**

Inspect Craps, Poker, MP lobby, and an MP room, with special attention to Craps table cell sizing and Poker/MP action/status wrapping. Revert activation.

- [ ] **Step 8: Verify PR 7**

Run `bun run test`, `bun run lint`, `bun run format:check`, `bun run build`.

If this one PR proves unreviewable during implementation, stop and ask before changing the approved ticket/PR boundary.

---

## Task 8 / PR 8: Completeness Audit, Visual QA, and Locale Activation

**Purpose:** Prove no known player-facing English leaks remain, then expose Traditional Chinese, Simplified Chinese, and Japanese together.

**Files:**
- Modify: `src/lib/i18n/locale.ts`
- Modify: `src/lib/i18n/locale.test.ts`
- Modify/add: `e2e/i18n-activation.spec.ts`
- Modify: any already-migrated presentation file only when the explicit audits below find a player-facing gap
- Modify: `src/lib/bet-validation.ts` if the English compatibility wrapper has no production caller

- [ ] **Step 1: Audit hard-coded locale formatting**

```bash
rg -n "Intl\.NumberFormat\(['\"]en-US|toLocaleString\(['\"]en-US|toLocaleDateString\(['\"]en-US" src/pages src/components src/lib
```

Replace every player-facing match with shared formatting/active locale. Leave only non-player logs/tests/protocol fixtures, with the PR description noting intentional production matches if any remain.

- [ ] **Step 2: Audit known English-bearing seams**

```bash
rg -n "Retry settlement|Reset round|Wager must|Bet must be|Wager exceeds|Player wins|Dealer wins|High Card|Royal Flush|Jack|Queen|King|Ace|Joker| chips" src/pages src/components src/lib
```

Every player-facing match must move to a message dictionary or translated complete template. Invariant exceptions/logs/tests may remain English if never displayed. Confirm migrated wager/arrangement APIs return codes, not English display strings.

- [ ] **Step 3: Prove dictionary completeness**

Unit tests import every message module and assert all four branches have English's key set. Separately assert the games dictionary covers every `GAME_TYPES` member plus three extras.

Run `bun test src/lib/i18n`.

- [ ] **Step 4: Remove the temporary English `validateBet()` wrapper if unused**

```bash
rg -n "\bvalidateBet\(" src --glob '!src/lib/bet-validation.ts' --glob '!*.test.ts'
```

If zero production callers remain, delete the English-string wrapper and retain `validateBetCode()`. If a production caller remains, convert that caller to codes in this PR before deletion.

- [ ] **Step 5: Enable all four locales**

Set `ENABLED_LOCALES` to all `SUPPORTED_LOCALES`. Update default request-resolution tests for enabled Japanese/Chinese cookies and browser languages.

- [ ] **Step 6: Add the one activation E2E path**

Start without locale cookie, verify browser-language detection, change language through the visible picker, verify `arcturus_locale`, navigate, then assert persisted `<html lang>`/`data-locale` and representative shell plus game/progression labels. Do not duplicate every E2E suite four times.

- [ ] **Step 7: Final four-locale visual QA**

Inspect in all four locales at desktop/narrow widths:

```text
/
/signin
/profile
/profile/statistics
/missions
/games/leaderboard
/games/daily-challenge
/games/blackjack
/games/blackjack/ranked
/games/slots
/games/sic-bo
/games/pai-gow-poker
/games/three-card-showdown
/games/video-poker
/games/baccarat
/games/roulette
/games/keno
/games/craps
/games/poker
/games/poker-mp
```

Check clipping, wrapping, controls/tables, font fallback, accessibility labels, and dynamic status/results. Add a CJK font only if this exposes a real defect not solved by system fallback/layout.

- [ ] **Step 8: Final verification**

```bash
bun run test
bun run lint
bun run format:check
bun run build
bun run test:e2e:ci
bun run test:e2e:mp
```

- [ ] **Step 9: Commit PR 8**

Suggested commits: `fix: close i18n completeness gaps`, `feat: enable four-language localization`.

---

## Rollout Summary

| Ticket / PR | Surface | Production locales after merge |
| --- | --- | --- |
| 1 | Foundation, shared game names, global shell | English only |
| 2 | Home, auth, profile, statistics, achievements | English only |
| 3 | Missions, leaderboard, daily challenge | English only |
| 4 | Blackjack + ranked Blackjack | English only |
| 5 | Slots, Sic Bo, Pai Gow, Three-Card, Video Poker | English only |
| 6 | Baccarat, Roulette, Keno | English only |
| 7 | Craps, Poker, multiplayer Poker | English only |
| 8 | Completeness + activation | English + Traditional Chinese + Simplified Chinese + Japanese |

The sequence deliberately establishes shared reuse points before large-scale copy migration. Do not add another i18n abstraction during later tasks unless an actual translation requirement cannot be expressed by the locale helper, feature dictionaries, interpolation, and existing presentation seams.