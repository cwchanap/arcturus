# Arcturus i18n Localization Design

## Summary

Add full player-facing localization for English, Traditional Chinese, Simplified Chinese, and Japanese while keeping the existing route structure unchanged.

The design intentionally avoids a translation framework, locale-prefixed routes, database-backed language settings, or a translation CMS. Arcturus only needs four in-repo locales today, so a small typed TypeScript translation layer is sufficient and easier to maintain.

## Goals

- Support `en`, `zh-Hant`, `zh-Hans`, and `ja`.
- Fully localize player-facing UI, including game names, casino terminology, dynamic gameplay status, and accessibility copy.
- Support both server-rendered Astro markup and browser-side game/controller messages.
- Keep domain state, protocol values, persistence, and game-rule identifiers language-neutral.
- Persist the selected locale without changing URLs.
- Detect a supported browser language on first visit when no explicit preference exists.
- Avoid exposing partially translated locales.
- Reuse existing presentation seams instead of creating per-page copies of game names, formatting, locale handoff, settlement copy, or validation text.
- Keep the rollout incremental, with one PR per implementation ticket.

## Non-goals

- Locale-prefixed routes such as `/ja/games/blackjack`.
- SEO-oriented per-locale page trees.
- Database or account-level locale synchronization.
- Translation management SaaS/CMS integration.
- ICU MessageFormat or a pluralization framework.
- Runtime i18n dependencies such as i18next or FormatJS.
- Automatic machine translation at runtime.
- Adding CJK webfonts before visual testing shows system font fallback is insufficient.
- Reworking multiplayer protocol/domain codes solely for localization.
- Environment flags, database flags, or a feature-flag service for language activation.

## Locale Model

Canonical locales:

- `en` — English
- `zh-Hant` — Traditional Chinese
- `zh-Hans` — Simplified Chinese
- `ja` — Japanese

The language picker uses native labels:

- English
- 繁體中文
- 简体中文
- 日本語

`Arcturus` remains unchanged as a product/proper name. Normal UI text, game names, game rules, casino terminology, status text, missions, leaderboards, profile/auth copy, accessibility text, and achievement presentation are localized.

## Locale Resolution

URLs remain unchanged.

Keep two explicit locale sets:

- `SUPPORTED_LOCALES` contains all four locales that can be authored and tested.
- `ENABLED_LOCALES` contains the locales production request resolution may expose. It starts as `['en']` and expands to all four only after the final completeness pass.

Separate normalization from fallback:

- `normalizeLocaleTag(tag)` maps a recognized language tag to a canonical supported locale and returns `null` for unsupported/malformed tags.
- `resolveRequestLocale(...)` applies enabled-locale filtering and owns the final English fallback.

Recognized normalization stays deliberately small:

- `zh-TW`, `zh-HK`, `zh-MO`, and `zh-Hant*` → `zh-Hant`
- `zh-CN`, `zh-SG`, `zh-Hans*`, and bare `zh` → `zh-Hans`
- `ja*` → `ja`
- `en*` → `en`
- everything else → `null`

For enabled locales, request resolution order is:

1. `arcturus_locale` cookie when it normalizes to an enabled locale.
2. Browser `Accept-Language` when its highest-preference recognized match is enabled.
3. English fallback.

A supported-but-disabled locale is ignored by production request resolution. This prevents a browser language or stale/manual cookie from exposing a partially migrated UI before activation.

Middleware resolves the locale once per request and exposes it through `Astro.locals.locale`. This happens before middleware branches that can call `next()`, including the no-DB/auth path.

The language picker renders only enabled locales. When multiple locales are enabled, changing the selection writes the locale cookie and reloads the current URL. No redirect or route rewriting is required.

### Cache Variation

Any shared cacheable HTML whose representation can vary by automatically resolved locale must vary on every locale input used for that representation.

The current guest Daily Challenge page is publicly edge-cacheable and already varies on `Cookie`. Once its localized presentation is in place, its guest response must use:

```text
Vary: Cookie, Accept-Language
```

This prevents the first cookie-less guest's browser language from poisoning the shared cache for other guests when non-English locales are enabled. Authenticated responses remain `private, no-store`.

## Translation Architecture

Use a small shared concern under the repository's existing `src/lib/<concern>` convention:

```text
src/lib/i18n/
  locale.ts
  translate.ts
  messages/
    common.ts
    games.ts
    home.ts
    auth.ts
    profile.ts
    achievements.ts
    missions.ts
    leaderboard.ts
    daily-challenge.ts
    blackjack.ts
    ...
```

Messages are grouped by feature rather than by locale. Each feature module contains all four locale branches.

### Compile-Time Message Completeness

English is the authoring shape. `defineMessages()` is a typed identity helper whose non-English branches are constrained from the English branch at compile time.

A missing Traditional Chinese, Simplified Chinese, or Japanese key must be a TypeScript/build error while the dictionary is being authored. Do not maintain a parallel runtime key-parity checker or a final “import every dictionary and compare keys” test.

`createTranslator()` performs lookup and simple named interpolation such as `{value}`. Because authored dictionaries are statically complete and callers use `Locale`, it does not need a generic runtime missing-key fallback subsystem.

Do not add ICU parsing, a namespace registry, a general message-expression language, or a global translation singleton. Prefer complete sentence templates over assembling fragments so Chinese and Japanese word order remains natural.

English singular/plural where it is actually needed can be handled by a small presentation helper (for example `1 chip` vs `2 chips`) rather than a general pluralization framework.

## Shared Game Display Names

Game display names are a cross-feature presentation concept and have one source of truth.

`src/lib/game-stats/constants.ts` already exposes `GAME_TYPES` and `GAME_TYPE_LABELS`, while the home page currently carries another English game-name list. Keep `GAME_TYPE_LABELS` as the canonical English map for existing `GAME_TYPES`, normalizing `poker` to `Texas Hold'em Poker`.

Create `messages/games.ts`; its English branch reuses `GAME_TYPE_LABELS` and adds:

- `daily-challenge` → `Daily Challenge`
- `poker-mp` → `Multiplayer Poker`
- `blackjack-ranked` → `Ranked Blackjack`

The other locale branches cover that same key set. `getGameName(locale, key)` becomes the localized presentation lookup used by home, leaderboard, profile statistics, and game surfaces.

Feature dictionaries may refer to game-name keys, but must not retranslate game names themselves.

## Terminology Glossary

Translation consistency is editorial rather than runtime infrastructure.

Create `docs/i18n-glossary.md` in the foundation implementation PR with a four-locale term table:

```text
English | 繁體中文 | 简体中文 | 日本語
```

Seed it with common casino/UI vocabulary used across features (for example chips, player, dealer/banker, win/loss/push, bet/wager, payout, rank, leaderboard). Each later translation PR adds any newly introduced game-specific canonical terms before or alongside its message dictionary (for example Blackjack insurance/natural, Craps Pass Line/Don't Pass, Baccarat Banker, poker hand names).

The glossary does not generate runtime copy and does not replace complete sentence templates. It is only the editorial source for consistent terminology across sequential PRs.

## Server and Browser Locale Handoff

Locale is one document-level fact.

`AppLayout` owns the SSR locale and writes it once on the root document:

```html
<html lang="ja" data-locale="ja">
```

Do not add `data-locale={Astro.locals.locale}` independently to every game root.

Browser-side code uses one shared helper from `src/lib/i18n/locale.ts`:

```ts
getDocumentLocale(document)
```

It reads `document.documentElement.dataset.locale ?? document.documentElement.lang`, normalizes it, and returns `en` only if the document value is absent/malformed.

This lets game clients, achievement toasts, settlement recovery, and profile-statistics rendering share the same handoff. Unit tests set the locale on `document.documentElement` rather than manufacturing feature-specific root attributes.

No client-only translation pass is required after initial rendering, avoiding language flash.

## Domain and Persistence Boundary

Domain state remains language-neutral.

Do not persist or transport translated text when a stable identifier/code can be used instead.

Examples:

- game type remains `blackjack`, not a localized game name;
- blackjack actions remain enums such as `hit`, `stand`, `double-down`, `split`;
- multiplayer poker protocol values remain protocol codes;
- achievement identity remains a closed `AchievementId`;
- mission identity becomes a closed `MissionId`;
- leaderboard ranking metrics remain `RankingMetric` values;
- poker hand ranks and Craps bet types remain stable identifiers;
- leaderboard/game statistics remain numeric/domain values.

Presentation resolves localized names, descriptions, and sentences from those identifiers.

For user-visible failures, prefer stable error/result codes and translate them at the presentation boundary. Do not redesign unrelated APIs solely for i18n, but migrate existing English strings that are currently used as player-facing results.

### Closed Presentation Key Sets

When display copy is removed from a domain record, the replacement dictionary must be keyed by a closed domain type so adding a new domain value cannot silently produce blank UI.

Use:

- `ACHIEVEMENT_IDS` / `AchievementId` (already present) for achievement copy;
- new `MISSION_IDS` / `MissionId` for mission copy and `MissionDefinition.id` / `MissionView.missionDefId`;
- `RANKING_METRICS` / `RankingMetric` for leaderboard metric labels;
- `keyof typeof HAND_RANKINGS` (or an equivalent existing closed poker hand-rank identity) for poker hand labels;
- `BetType` for localized Craps bet labels, backed by a language-neutral runtime bet-type membership structure rather than an English label map.

Do not use `Record<string, string>` for an exhaustive player-facing catalog when the domain already has a finite key set.

### Existing Game-Domain English

Several current game modules return English strings directly from domain/game code. Their migration PR moves those player-facing results to closed codes/enums rather than merely wrapping the surrounding page:

- wager/bet errors in Pai Gow Poker, Video Poker, Three-Card Showdown, Sic Bo, and Craps;
- Pai Gow arrangement validation errors;
- poker/Pai Gow/Craps hand, category, and bet display labels;
- comparable player-facing status strings discovered in the migrated game.

Reuse the existing shared validator rather than duplicating range logic. `src/lib/bet-validation.ts` gains a language-neutral `validateBetCode()` result while its current English `validateBet()` wrapper remains temporarily for unmigrated callers. Migrated game engines consume codes and clients/renderers translate them. Remove the English wrapper only after the final audit proves no production caller remains.

For game-specific validation such as Craps phase/odds restrictions or Pai Gow arrangement errors, use a local closed code union in that game. Do not create a generic cross-game error framework.

Visible card rank glyphs such as `A`, `K`, `Q`, and `J` remain invariant. Accessibility names such as `Jack of hearts` and `Joker` are player-facing and are localized.

### Ranking Metric Labels

`RANKING_METRIC_LABELS` is presentation data, not game-statistics domain data. Move those labels into the leaderboard i18n module keyed exhaustively by `RankingMetric`; keep `RANKING_METRICS` itself language-neutral. Remove the presentation-label re-export from `src/lib/game-stats/game-stats.ts` when the leaderboard surface migrates.

### Achievements

Achievement rules continue to own IDs, categories, icons, thresholds, and unlock logic. Player-facing names/descriptions come from `messages/achievements.ts`.

Settlement payloads and toast queue entries carry `AchievementId` plus non-text presentation data such as `icon`, not an English `name`. The toast resolves the name using the active document locale.

Any independent JSON-boundary type that currently repeats `{ id, name, icon }` (including Roulette spin client/route tests) is migrated in the same achievement PR so stale English fields cannot survive until the Roulette translation PR.

### Missions

Mission rules continue to own IDs, period, metric, target, reward, and icon. Add `MISSION_IDS as const` / `MissionId`, use it for definitions/views, then remove English `title`/`description` from `MissionDefinition` and `MissionView`.

The `/api/missions/board` payload remains language-neutral. The missions page resolves title/description by `missionDefId`, including after client-side board refresh/re-render.

### Shared Settlement Presentation

Reuse the existing settlement messages seam.

`PublicGameSettlementMessages` already carries failed/retrying/retry-failed copy. Extend it with `retryLabel` instead of leaving `Retry settlement` hard-coded in the shared helper. Unmigrated games may continue supplying the current English string until their owning game PR migrates them.

Shared balance synchronization also stops hard-coding locale/chip wording and uses the document locale plus the shared chip-formatting presentation helper.

### AI Advisor Text

The authoritative game decision remains language-neutral. Deterministic explanation templates are localized locally.

When an optional AI provider rewrites/explains an already-selected action, the prompt requests the active locale. The provider must not be allowed to change the authoritative action merely because localization is enabled.

## Formatting and Chip Convention

Extend `src/lib/formatting.ts` for locale-aware numeric/date formatting; do not create a second generic formatter.

Player-facing virtual money is **chips, not currency**. Retire `$` prefixes app-wide as each surface migrates. Use one shared presentation helper:

```ts
formatChips(value: number, locale: Locale): string
```

It returns a localized chip phrase such as `1 chip` / `10,000 chips`, with equivalent Traditional Chinese, Simplified Chinese, and Japanese wording. This helper owns the tiny English singular distinction without introducing a plural framework.

The underlying number formatting still comes from `src/lib/formatting.ts`; the translated chip noun/phrase belongs to the common i18n presentation layer.

Use the same convention for balances, wagers, bets, payouts, minimum/maximum bet text, results, and dynamic header synchronization. Do not mix `$10,000`, `10,000 chips`, and bare `10,000` for the same virtual-money concept.

Keep language-neutral symbols/identifiers unchanged where appropriate, including:

- visible card rank symbols `A`, `K`, `Q`, `J`;
- payout ratios such as `3:2`;
- room codes;
- usernames;
- API/provider/model names.

### Permanent Formatting Guard

Today the codebase contains many direct `toLocaleString()` and `Intl.*` presentation call sites, so enabling a global lint ban in the foundation PR would make that PR fail before later surfaces are migrated.

Instead:

1. each surface migration removes direct locale formatting from the files it owns;
2. the final activation PR performs one broad search for remaining production `toLocaleString` / `toLocaleDateString` / `toLocaleTimeString` / direct `Intl` formatting calls;
3. after those are removed or intentionally centralized, add a permanent ESLint `no-restricted-syntax` guard for production `src/**` code, excluding `src/lib/formatting.ts`, `src/lib/i18n/**`, and tests.

This gives the reviewer-requested build-time protection without requiring a temporary allowlist for dozens of known legacy call sites.

## Fonts and Visual Validation

Do not add a bundled CJK font initially.

The existing display/body fonts can fall back to system CJK fonts. Add a CJK font only if readability, weight matching, or layout quality is materially poor.

Do not postpone all visual validation until activation. For every translation PR:

1. locally change `ENABLED_LOCALES` to all four locales;
2. inspect that PR's migrated surface in English, Traditional Chinese, Simplified Chinese, and Japanese for wrapping, clipping, control sizing, and obvious font problems;
3. revert the temporary `ENABLED_LOCALES` change before committing/merging.

This is a developer verification procedure, not a feature flag.

## Locale Availability

English is the source/authoring locale.

All four locales exist in migrated message files and are exercised by unit/component tests, but production request resolution uses only `ENABLED_LOCALES`. Initially that list contains only `en`; `zh-Hant`, `zh-Hans`, and `ja` are added together after the final completeness pass.

Because dictionary shape is compile-time enforced, migrated feature dictionaries do not rely on runtime English fallback for missing keys.

## Rollout

Implement incrementally. Every rollout ticket maps to exactly one PR.

Recommended sequence:

1. i18n foundation + global shell + shared game names/chip convention + glossary.
2. Home, auth, profile, statistics, achievements, and achievement JSON boundaries.
3. Missions, leaderboard, and daily challenge, including locale-correct cache variation.
4. Blackjack + ranked Blackjack.
5. Small client-module games: Slots, Sic Bo, Pai Gow Poker, Three-Card Showdown, and Video Poker.
6. Renderer-heavy games: Baccarat, Roulette, and Keno.
7. Craps, including its remaining domain validation/bet-key cleanup.
8. Single-player Poker + multiplayer Poker.
9. Final English/formatting audit, permanent lint guard, cross-surface visual QA, and activation of `zh-Hant`, `zh-Hans`, and `ja`.

The Craps and Poker/MP work is split before implementation because Craps is already the largest remaining individual surface and owns the remaining domain-level validation conversion. Do not defer that reviewability decision until a branch is half-written.

## Testing

Keep testing focused on behavior rather than duplicating every existing E2E case four times.

### Foundation Tests

Unit-test:

- locale normalization returning canonical values or `null`;
- cookie precedence;
- `Accept-Language` q-value ordering;
- disabled-locale exclusion;
- English request fallback;
- document-locale reading;
- interpolation;
- shared game-name coverage across `GAME_TYPES` plus lobby extras;
- locale-aware numeric formatting;
- localized `formatChips()` including English singular/plural behavior.

Do not add a foundation-only Playwright spec for disabled-locale filtering. The resolver unit tests cover selection, while existing Astro container tests are extended to carry `locale: 'en'` explicitly and assert AppLayout's `<html lang>` / `data-locale` rendering. The final activation flow remains a real browser E2E because cookie mutation/reload/persistence are browser behavior.

### Container Fixtures

When `App.Locals.locale` becomes required, update the existing Daily Challenge and Profile Astro container fixtures to set `locale: 'en'` explicitly. Remove the whole-object `as App.Locals` escape hatch; if fake runtime bindings still need a cast, constrain that cast to the nested runtime value so future top-level `App.Locals` fields are type-checked.

### Surface Migration Tests

For each migrated feature:

- preserve existing behavioral tests;
- replace fragile English-text selectors with stable test IDs only where localization would otherwise break the locator;
- add focused unit/component assertions for representative non-English dynamic and static messages;
- use closed-ID/key types so missing catalog entries are build failures;
- run the existing E2E suite for that surface;
- perform the temporary four-locale local visual check;
- keep production-route E2E assertions in English until final activation.

Do not create four copies of every game E2E suite.

### Final Activation Test

When non-English locales are added to `ENABLED_LOCALES`, add one browser E2E flow that:

- starts without a locale cookie and verifies browser-language detection;
- changes language through the visible picker;
- verifies the locale cookie;
- reloads/navigates;
- verifies persistence;
- verifies `<html lang>` / `data-locale` and representative localized shell/game/progression labels.

## Error Handling

Unsupported, malformed, or disabled locale values fall through enabled-locale request resolution and ultimately resolve to English.

Translation lookup stays deterministic and local; localization must never block game logic, wallet settlement, authentication, or persistence.

## Design Constraints

- No schema changes.
- No route changes.
- No runtime i18n dependency.
- No translated values in core domain/protocol/persistence state.
- No partially translated locale exposed by picker, cookie, or automatic browser-language detection.
- One document-level locale handoff; do not repeat locale attributes on each game root.
- One canonical game-name translation catalog.
- One app-wide localized chip-amount convention; no `$` prefix for virtual chips after migration.
- Exhaustive player-facing catalogs use closed domain key types, not arbitrary strings.
- Feature dictionaries are compile-time complete from the English branch.
- Prefer feature-local dictionaries and existing presentation seams over a generic localization subsystem.
- Every implementation ticket maps to one PR.