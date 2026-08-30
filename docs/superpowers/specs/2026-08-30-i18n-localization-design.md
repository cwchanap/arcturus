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
- Avoid exposing partially translated locales.
- Reuse existing presentation seams instead of creating per-page copies of game names, formatting, or locale handoff.
- Keep the rollout incremental, with one PR per implementation ticket.

## Non-goals

- Locale-prefixed routes such as `/ja/games/blackjack`.
- SEO-oriented per-locale page trees.
- Database or account-level locale synchronization.
- Translation management SaaS/CMS integration.
- ICU MessageFormat, plural-rule frameworks, or runtime i18n dependencies unless future requirements justify them.
- Automatic machine translation at runtime.
- Adding CJK webfonts before visual testing shows system font fallback is insufficient.
- Reworking multiplayer protocol/domain codes solely for localization.

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

A supported-but-disabled locale is ignored by production request resolution. This prevents a browser language or stale/manual cookie from exposing a partially migrated UI before the final activation PR.

Middleware resolves the locale once per request and exposes it through `Astro.locals.locale`. This must happen before middleware branches that can call `next()`, including the no-DB/auth path.

The language picker renders only enabled locales. When multiple locales are enabled, changing the selection writes the locale cookie and reloads the current URL. No redirect or route rewriting is required.

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
    roulette.ts
    ...
```

Messages are grouped by feature rather than by locale. Each feature module contains the same message keys for all four locales.

A lightweight `defineMessages()` helper validates that all locale variants in a feature expose the same keys. A small `createTranslator()` helper performs lookup and simple named interpolation such as `{value}`.

Do not add ICU parsing, a namespace registry, a general message-expression language, or a global translation singleton. Complete sentence templates should be preferred over assembling fragments so Chinese and Japanese word order remains natural.

### Shared Game Display Names

Game display names are a cross-feature presentation concept and must have one source of truth.

`src/lib/game-stats/constants.ts` already exposes `GAME_TYPES` and `GAME_TYPE_LABELS`, while the home page currently carries another English game-name list. Do not create new copies in `common.ts`, `home.ts`, leaderboard messages, and every game module.

Create one `messages/games.ts` dictionary keyed by:

- every `GAME_TYPES` value;
- `daily-challenge`;
- `poker-mp`;
- `blackjack-ranked`.

Use one canonical English label per key. For the current poker game, use `Texas Hold'em Poker` consistently rather than mixing it with the generic `Poker`. Keep `Multiplayer Poker` as the separate lobby/game label.

`GAME_TYPE_LABELS` should become the English projection/wrapper over this canonical game-name source, so existing leaderboard/profile/statistics call sites can migrate without inventing another label map.

Feature dictionaries may refer to game-name keys, but must not retranslate the game names themselves.

## Server and Browser Locale Handoff

Locale is one document-level fact.

`AppLayout` owns the SSR locale and writes it once on the root document:

```html
<html lang="ja" data-locale="ja">
```

Do not add `data-locale={Astro.locals.locale}` independently to every game root.

Browser-side code uses one shared helper from `src/lib/i18n/locale.ts`, conceptually:

```ts
getDocumentLocale(document)
```

which reads `document.documentElement.dataset.locale ?? document.documentElement.lang`, normalizes it, and falls back to `en` only if the document is malformed.

This lets game clients, achievement toasts, settlement recovery, and profile-statistics rendering share the same handoff. Unit tests can set the locale on `document.documentElement` rather than manufacturing feature-specific root attributes.

No client-only translation pass should be required after initial rendering, avoiding language flash.

## Domain and Persistence Boundary

Domain state remains language-neutral.

Do not persist or transport translated text when a stable identifier/code can be used instead.

Examples:

- game type remains `blackjack`, not a localized game name;
- blackjack actions remain enums such as `hit`, `stand`, `double-down`, `split`;
- multiplayer poker protocol values remain protocol codes;
- achievement identity remains the achievement ID;
- mission identity remains the mission ID/key;
- leaderboard/game statistics remain numeric/domain values.

Presentation resolves localized names, descriptions, and sentences from those identifiers.

For user-visible failures, prefer stable error/result codes and translate them at the presentation boundary. Do not redesign unrelated APIs solely for i18n, but do migrate existing English strings that are currently used as player-facing results.

### Existing Game-Domain English

Several current game modules return English strings directly from domain/game code. Their migration PR must move those player-facing results to closed codes/enums rather than merely wrapping the surrounding page:

- wager/bet errors in Pai Gow Poker, Video Poker, Three-Card Showdown, and Sic Bo;
- Pai Gow arrangement validation errors;
- poker/Pai Gow hand/category display names;
- comparable player-facing status strings discovered in the migrated game.

The rule is local and incremental: change the domain result to a stable code in the same PR that migrates that game, and translate the code in the existing client/renderer. Do not create a generic error-code framework for all games.

Visible card rank glyphs such as `A`, `K`, `Q`, and `J` remain invariant. Accessibility names such as `Jack of hearts` and `Joker` are player-facing and must be localized.

### Shared Settlement Presentation

Reuse the existing settlement messages seam.

`PublicGameSettlementMessages` already carries failed/retrying/retry-failed copy. Extend that seam to cover `retryLabel` instead of leaving `Retry settlement` hard-coded in the shared helper. Unmigrated games may continue supplying the existing English string until their game PR migrates them.

Shared balance synchronization must also stop hard-coding `en-US`/`chips`; it should use the active document locale plus the shared formatting/common-message helpers. `settlement-recovery.ts` may retain defensive defaults only if every production player-facing call path passes localized labels by final activation.

### Achievements

Achievement rules should continue to own IDs, categories, icons, thresholds, and unlock logic. Player-facing achievement names/descriptions come from `messages/achievements.ts`.

Settlement payloads and toast queue entries should carry stable achievement identity plus non-text presentation data (for example `id` and `icon`), not an English `name`. The toast resolves the name using the active document locale.

Numeric thresholds are interpolated and formatted using the active locale instead of hard-coded `en-US` formatting.

### Missions

Mission rules should continue to own IDs, period, metric, target, reward, and icon. Remove English `title`/`description` from `MissionDefinition` and `MissionView` when the missions surface migrates.

The `/api/missions/board` payload remains language-neutral. The missions page resolves title/description by `missionDefId`, including after client-side board refresh/re-render.

### AI Advisor Text

The authoritative game decision remains language-neutral. Deterministic explanation templates are localized locally.

When an optional AI provider rewrites/explains an already-selected action, the prompt requests the active locale. The provider must not be allowed to change the authoritative action merely because localization is enabled.

## Formatting

Extend `src/lib/formatting.ts`; do not create a second formatting package.

Replace hard-coded locale formatting such as `Intl.NumberFormat('en-US')` / `toLocaleString('en-US')` in player-facing code as its owning surface migrates. Known call sites include the shared app shell, shared public-game settlement, ranked Blackjack UI, daily Blackjack UI, `GameCard`, and profile statistics.

Use `Intl` for:

- numbers;
- percentages;
- dates/times where displayed.

Keep language-neutral symbols/identifiers unchanged where appropriate, including:

- visible card rank symbols `A`, `K`, `Q`, `J`;
- payout ratios such as `3:2`;
- room codes;
- usernames;
- API/provider/model names;
- chip numeric values.

The noun/phrase around a number is translated as presentation copy rather than embedded in a generic numeric formatter.

## Fonts and Visual Validation

Do not add a bundled CJK font initially.

The existing display/body fonts can fall back to system CJK fonts. Add a CJK font only if readability, weight matching, or layout quality is materially poor.

Do not postpone all visual validation until activation. For every translation PR:

1. locally change `ENABLED_LOCALES` to all four locales;
2. inspect that PR's migrated surface in English, Traditional Chinese, Simplified Chinese, and Japanese for wrapping, clipping, control sizing, and obvious font problems;
3. revert the temporary `ENABLED_LOCALES` change before committing/merging.

This is a developer verification procedure, not a feature flag. Do not add environment flags or test-only runtime locale switches.

## Locale Availability and Fallback

English is the source/authoring locale.

All four locales may exist in message files and be exercised by unit/component tests during migration, but production request resolution uses only `ENABLED_LOCALES`. Initially that list contains only `en`; `zh-Hant`, `zh-Hans`, and `ja` are added together after the final completeness pass.

During development, a missing non-English message may fall back to English so isolated work remains usable. Completeness checks still require every migrated feature dictionary to expose the same keys as English before that feature PR merges.

Do not add environment flags, database flags, test-only runtime locale overrides, or a feature-flag service for locale activation.

## Rollout

Implement incrementally. Every rollout ticket maps to exactly one PR.

Recommended sequence:

1. i18n foundation + global shell
   - locale parsing/resolution;
   - `Astro.locals.locale`;
   - translation helpers and message completeness;
   - shared game-name catalog;
   - document-level locale handoff;
   - language picker;
   - layout/nav/footer;
   - locale-aware formatting foundation;
   - shared settlement retry-label seam.

2. Home, auth, profile, achievements, and shared profile/statistics presentation.

3. Missions, leaderboard, and daily challenge.

4. Blackjack + ranked Blackjack.

5. Small client-module games: Slots, Sic Bo, Pai Gow Poker, Three-Card Showdown, and Video Poker.

6. Renderer-heavy games: Baccarat, Roulette, and Keno.

7. Large remaining surfaces: Craps, single-player Poker, and multiplayer Poker.

8. Final completeness audit, cross-surface visual QA, and activation of `zh-Hant`, `zh-Hans`, and `ja`.

Task 7 is intentionally left as one PR because Craps/Poker/MP already have real separate presentation seams; split it only if implementation of the earlier game PRs demonstrates that the resulting diff is not reviewable.

## Testing

Keep testing focused on behavior rather than duplicating every existing E2E case four times.

### Foundation Tests

Unit-test:

- `normalizeLocaleTag()` returning canonical locales or `null`;
- cookie precedence;
- `Accept-Language` q-value ordering;
- disabled-locale exclusion from production request resolution;
- English fallback in `resolveRequestLocale()`;
- document-locale reading;
- interpolation;
- locale-aware formatting helpers;
- translation key completeness;
- shared game-name completeness for `GAME_TYPES` plus lobby extras.

Add one focused Playwright check that verifies the rollout guardrail:

- a supported-but-disabled locale cookie or browser language does not expose that locale;
- `<html lang>` / `data-locale` remain `en` while only English is enabled;
- the global shell renders English;
- the picker does not expose disabled locales.

### Surface Migration Tests

For each migrated feature:

- preserve existing behavioral tests;
- replace fragile English-text selectors with stable test IDs only where localization would otherwise break the locator;
- add focused unit/component assertions that directly exercise representative non-English dynamic and static messages;
- run the existing E2E suite for that surface, including ranked Blackjack E2E in the Blackjack PR;
- perform the temporary four-locale local visual check described above;
- keep production-route E2E assertions in English until final activation.

Do not create four copies of every game E2E suite.

### Final Activation Test

When the three non-English locales are added to `ENABLED_LOCALES`, add one picker E2E flow that:

- changes language through the visible picker;
- verifies the locale cookie;
- reloads/navigates;
- verifies persistence;
- verifies `<html lang>` / `data-locale` and representative localized labels;
- verifies browser-language detection now selects an enabled non-English locale on first visit.

## Error Handling

Unsupported, malformed, or disabled locale values fall back through the enabled-locale resolution path and ultimately to English.

Missing development-time translations may fall back to English, but completeness validation must prevent incomplete locales from being enabled for players.

Translation lookup stays deterministic and local; localization must never block game logic, wallet settlement, authentication, or persistence.

## Design Constraints

- No schema changes.
- No route changes.
- No runtime i18n dependency unless a future requirement exceeds the small translation layer.
- No translated values in core domain/protocol/persistence state.
- No partially translated locale exposed by picker, cookie, or automatic browser-language detection.
- One document-level locale handoff; do not repeat locale attributes on each game root.
- One canonical game-name translation catalog; do not duplicate game names across feature dictionaries.
- Prefer feature-local dictionaries and existing presentation seams over a generic localization subsystem.
- Every implementation ticket maps to one PR.