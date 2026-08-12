# HPA-185: Browser-local BYOK AI + Blackjack Explanation Design

## Status

Planning specification for HPA-185. This PR remains documentation-only; feature implementation belongs in a follow-up PR.

## Why this is next

The architecture roadmap in HPA-167 orders the work as HPA-542 → HPA-545 → HPA-185 → HPA-195 → HPA-553. HPA-545 merged into `main` in PR #30, so HPA-185 is the next unblocked roadmap item.

## Problem

Arcturus already supports OpenAI and Gemini in several single-player AI features, but the provider boundary is duplicated instead of modular:

- `src/lib/blackjack/llmBlackjackStrategy.ts`, `src/lib/craps/llmCrapsStrategy.ts`, `src/lib/baccarat/llmBaccaratStrategy.ts`, `src/lib/poker/llmAIStrategy.ts`, and `src/lib/poker/AIRivalAssistant.ts` each know provider URLs, headers, request shapes, response extraction, and timeout behavior.
- Provider/model constants and validators live inside the D1-backed `src/lib/llm-settings.ts`, coupling otherwise reusable configuration rules to persistence.
- API keys are stored in D1 through `src/lib/llm-settings.ts`, exposed through `/api/profile/llm-settings` and `/api/profile/reveal-api-key`, and then shipped back to browser callers.
- `/api/craps-advice` exists primarily so the server can retrieve the D1-stored key before calling the provider.
- Blackjack currently gates the entire Ask AI interaction behind `useLLM`, which defaults to false, and disables it for guests even though the project can compute useful local advice without any provider.
- Blackjack lets the model choose the recommended action even though a deterministic local strategy can decide the action legally.
- Blackjack also makes automatic post-round commentary requests, adding cost outside the explicit “what should I do and why?” interaction.

The result is more code and more state than this hobby project needs.

## Goals

1. Create one small browser-side `src/lib/ai` module that owns BYOK settings and OpenAI/Gemini HTTP mapping.
2. Move the existing provider/model constants and validators into that module instead of duplicating them.
3. Store one active provider/model/API-key record in browser `localStorage`; remove D1 AI credential persistence and its API endpoints after all callers migrate.
4. Migrate active OpenAI/Gemini callers to the shared AI client while keeping prompts, game validation, caches, and fallback policy inside each game module.
5. Make Blackjack recommendation selection deterministic and legal for every player, including guests.
6. Let a configured provider rewrite only the deterministic Blackjack explanation after an explicit Ask AI click.
7. Remove the redundant Blackjack `useLLM` toggle and automatic post-round AI commentary.
8. Prefer deletion over adapters, compatibility paths, provider frameworks, or repository-wide reorganization.

## Non-goals

- No server-side provider proxy.
- No encrypted credential vault or cross-device settings sync.
- No migration of D1 keys or previous browser formats. Users re-enter a key after the breaking change.
- No provider SDK dependency; keep the existing fetch-based approach.
- No provider plugin system, model router, fallback provider, streaming, agents, tools, prompt registry, conversation memory, vector storage, usage metering, audit trail, or rate-limit service.
- No broad rewrite of Poker, Baccarat, or Craps AI behavior.
- No Baccarat AI UI; `getBaccaratAdvice()` has no active page caller, so only its transport is migrated.
- No restructuring from `src/lib/<domain>` to a second `src/modules` hierarchy.
- No change to Poker’s current LLM-opponent cache or guest/key policy.

## Approaches considered

### A. Small `src/lib/ai` module + browser-local settings — selected

Add a focused AI module beside `src/lib/wallet` and the current per-game libraries. It owns only stable shared concepts: provider/model validation, one browser-local settings record, and the two provider HTTP mappings. Game modules keep prompts and game-domain behavior.

This removes duplicated provider code while matching the existing repository layout.

### B. Extract provider HTTP but keep D1-backed key storage — rejected

This would preserve the settings repository, profile APIs, reveal endpoint, server/client serialization, and Craps proxy. There is no cross-device requirement justifying that machinery.

### C. Start a new `src/modules` hierarchy — rejected

The roadmap requires modular boundaries, not a repository-wide directory migration. A second module root would increase concepts without helping HPA-185.

## Proposed module boundary

```text
src/lib/ai/
  types.ts
  settings.ts
  client.ts
  index.ts
```

Do not create `openai.ts`, `gemini.ts`, a provider interface, or a provider registry. There are two concrete providers; one switch in `client.ts` is easier to maintain.

### Public types

```ts
export type AiProvider = 'openai' | 'gemini';

export interface AiSettings {
  provider: AiProvider;
  model: string;
  apiKey: string;
}

export interface AiGenerateRequest {
  system?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export type AiErrorCode =
  | 'missing-key'
  | 'timeout'
  | 'provider-error'
  | 'invalid-response';

export type AiResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: AiErrorCode; message: string };
```

`AiResult` is the shared timeout/HTTP seam, not a provider error taxonomy.

## Settings API

Move, rather than fork, the current provider/model definitions and validators from `src/lib/llm-settings.ts`:

```ts
export const AI_SETTINGS_STORAGE_KEY = 'arcturus-ai-settings';
export const AI_PROVIDERS = ['openai', 'gemini'] as const;
export const AI_MODELS = {
  openai: ['gpt-4o'],
  gemini: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
} as const;

export function isValidProvider(value: string): value is AiProvider;
export function isValidModel(provider: AiProvider, model: string): boolean;
export function loadAiSettings(): AiSettings | null;
export function saveAiSettings(settings: AiSettings): void;
export function clearAiSettings(): void;
```

One browser stores one current provider/model/key record. Switching provider replaces the whole record; a second hidden key is not retained.

Validation policy is intentionally asymmetric:

- `loadAiSettings()` treats malformed/unsupported stored data as unconfigured and returns `null`.
- `saveAiSettings()` validates provider, model, and a non-empty trimmed key and throws on invalid input. The profile’s existing feedback path reports the failure instead of silently writing data that cannot be loaded.
- Clearing uses `clearAiSettings()` rather than saving an empty key.

During migration, `src/lib/llm-settings.ts` may temporarily import/re-export the moved provider/model constants and validators so there is one source of truth while its remaining server callers still exist. That bridge disappears when the D1 path is deleted.

## Provider client API

```ts
export const AI_REQUEST_TIMEOUT_MS = 5_000;

export function generateAiText(
  settings: AiSettings,
  request: AiGenerateRequest,
): Promise<AiResult<string>>;

export function generateAiJson(
  settings: AiSettings,
  request: AiGenerateRequest,
): Promise<AiResult<Record<string, unknown>>>;
```

`client.ts` reuses `fetchJsonWithTimeout` from `src/lib/fetch-with-timeout.ts`, not `fetchWithTimeout`, so the 5-second timeout remains armed while the response body is read and parsed.

It owns:

- OpenAI `/v1/chat/completions` URL, authorization header, messages request shape, and text extraction.
- Gemini `generateContent` URL, API-key query parameter, contents request shape, and text extraction.
- One 5-second timeout for both providers, replacing Craps’ current 8-second special case.
- Non-2xx normalization when a provider returns a parseable JSON body.
- Text extraction and extraction/parsing of one JSON object for `generateAiJson()`.

If a provider returns a non-JSON body, the JSON helper cannot return the `Response` because parsing failed; classify that as `invalid-response` rather than adding a second body-reading abstraction solely to preserve an HTTP status. Normal provider JSON error responses still map to `provider-error`. This keeps the four-code contract small while fixing the stalled-body timeout defect.

`client.ts` does not validate `action`, `move`, `suggestedBets`, or `reasoning`; those remain game-domain concerns.

## Profile settings flow

`/profile` remains the existing signed-in configuration screen, but its AI panel becomes entirely client-side:

1. Server rendering no longer reads AI settings from D1.
2. Client initialization calls `loadAiSettings()`.
3. The form shows the active provider/model and masks the local key.
4. Save calls `saveAiSettings()` and reports thrown validation/storage errors through existing feedback UI.
5. Show and copy use the already-local `apiKey`; there is no reveal fetch.
6. Clear calls `clearAiSettings()`.
7. Copy states that the key is stored in this browser only and switching provider replaces the current provider/key.

`src/lib/profile-ui-state.ts` exists mainly to model dual server-stored keys plus reveal/copy fetch behavior. Delete that class instead of preserving its reveal abstraction with a new shape. Keep only small DOM/form helpers that remain useful in `profile-form-handlers.ts`.

The shared `ai` module has no authentication concept.

## Migration sequence

Implementation commits must remain runnable. Do not delete the D1/API path before its last caller moves.

1. Add `src/lib/ai`; move provider/model constants and validators there while temporarily re-exporting them from `llm-settings.ts`.
2. Move Profile to local settings. Keep legacy settings endpoints because Blackjack/Poker still call them at this point.
3. Migrate Blackjack to deterministic/local advice and remove its `useLLM` gate/toggle.
4. Migrate Craps to the local settings/shared-client path, then delete `/api/craps-advice` in that same task.
5. Migrate Baccarat transport plus both Poker AI paths.
6. Once no live caller uses D1 AI settings, delete `llm-settings.ts`, its test, profile API helpers/endpoints, and the schema table; generate a forward SQL migration.
7. Replace old browser/E2E contracts and run full verification.

No intermediate commit should leave active code calling a deleted endpoint.

## Persistence deletion and Drizzle history

Remove `llmSettings` from `src/db/schema.ts`, then use the repository’s existing workflow:

```bash
bun run db:generate
```

Commit the newly generated SQL migration that drops `llm_settings` and any Drizzle metadata produced by that command. Inspect the generated migration before committing; it should not contain unrelated schema changes.

Do **not** rewrite `drizzle/0000_powerful_wrecking_crew.sql` or selectively delete historical migration files. `scripts/apply-migrations.ts` applies numbered `.sql` files in order, so a new forward migration is the executable path for both existing and freshly reset hobby databases. Old migration history may still mention `llm_settings`; runtime/source code must not.

No D1-to-localStorage export, dual-read, backfill, or compatibility API is added.

## Blackjack behavior

### Ask AI is always local-first

The current `useLLM` setting is redundant under the new interaction: Ask AI is explicitly user-triggered, and provider configuration already determines whether personalization is possible. Remove `useLLM` from Blackjack settings, its settings UI, and tests.

For every player-turn state:

- Ask AI is available to signed-in players and guests.
- The click always computes and renders deterministic local advice.
- Guests use local advice only. They do not need an API key or account-backed AI setting.
- Signed-in players with a valid local provider record may receive one provider rewrite after the click.
- Missing provider configuration never blocks or replaces the local answer with an overlay.

Delete the Blackjack configuration overlay if no other behavior needs it.

### Deterministic recommendation is authoritative

Promote the current `getBasicStrategyAdvice()` logic to the explicit exported local strategy function:

```ts
export function getBlackjackStrategyAdvice(
  context: BlackjackAdviceContext,
): BlackjackAdvice;
```

It receives the current hand, dealer up-card, and `availableActions`. It returns one action contained in `availableActions` excluding `ask-ai`, plus a concise explanation.

Keep this ticket focused: test the current hit/stand/double/split branches and legal fallback, but do not turn HPA-185 into a full strategy-table rewrite.

### Model only rewrites reasoning

On explicit Ask AI click:

1. Compute `deterministic = getBlackjackStrategyAdvice(context)` first.
2. Render that recommendation regardless of provider configuration.
3. For a signed-in player with valid local settings, call `generateAiJson()` once with the fixed action and base explanation.
4. Request only a short `reasoning` field.
5. Ignore any model action field if one appears.
6. On timeout/provider failure/malformed output, keep the deterministic explanation.

### Remove automatic commentary

Delete `getRoundCommentary()`, its barrel export, the post-round call, and commentary-only DOM. Provider calls happen only after the explicit Ask AI click.

## Other game migrations

The transport migration is deliberately mechanical:

- **Poker LLM opponents:** keep `DecisionCache`, prompt construction, move parsing, and rule-based fallback in `llmAIStrategy.ts`; replace only provider transport.
- **Poker AI Rival:** load the local record through the shared settings function and use the shared provider client. Rename the class helper to `hydrateFromLocalSettings()` so it is not visually confused with imported `loadAiSettings()`.
- **Poker guest policy:** keep current behavior; HPA-185 does not make provider-backed Poker AI available to guests.
- **Baccarat:** migrate provider transport only. Do not add a page/UI for otherwise-unused `getBaccaratAdvice()`.
- **Craps:** move the useful pure bet aggregation/prompt behavior into the Craps strategy module, replace provider transport, call it directly from the existing page button, and then delete `/api/craps-advice`. Drop route-only auth/DB/request validation because that server boundary no longer exists.

No game imports another game’s AI code.

## Failure behavior

- Missing key: local/rule-based behavior continues.
- Provider timeout: shared client returns `timeout`; games fall back locally.
- Parseable provider non-2xx: shared client returns `provider-error`.
- Malformed/non-JSON provider body: shared client returns `invalid-response`.
- Invalid localStorage record: treat as unconfigured.
- Invalid profile save or localStorage write failure: show existing profile error feedback; no retry subsystem.

## Testing strategy

### Shared AI module

Unit-test settings round-trip, replacement, clear, invalid load, invalid save, moved provider/model validators, OpenAI/Gemini mapping, body-timeout handling, error normalization, and JSON extraction.

### Blackjack

Unit-test deterministic legality and hit/stand/double/split/fallback branches. Test provider rewrite cannot change the action and provider failure returns the exact local result.

Update `e2e/blackjack-settings.spec.ts` because its current `useLLM: false` gate is intentionally removed. Add guest/local advice coverage and confirm the default path requires no setting toggle.

### Migrated games

Preserve Poker/Baccarat/Craps domain parser/fallback tests while mocking the shared client. Keep `DecisionCache` tests. Do not duplicate provider request-shape tests in every game.

### Integration/E2E

- Profile: local save/reload/show/copy/clear with no settings/reveal API.
- Blackjack no provider: click Ask AI and receive a legal recommendation with zero provider requests.
- Blackjack configured provider: zero provider requests before click, exactly one on click, none after round completion.
- Blackjack guest: local advice works and no provider request is made.
- Provider failure: deterministic advice remains visible.

## Implementation risks

### Risk 1: old Blackjack gating survives the strategy refactor

If `llmUserEnabled`, guest button disabling, or the `useLLM` settings test survives, the core local-first behavior is still unreachable. Mitigation: remove the setting/property/UI gate in the Blackjack task and update `blackjack-settings.spec.ts` in that same commit.

### Risk 2: legacy endpoints are deleted before callers migrate

Profile can move to localStorage before Poker/Blackjack do. Deleting `/api/profile/llm-settings` at that point would break intermediate commits. Mitigation: legacy persistence deletion is a dedicated cleanup task after all game callers migrate.

### Risk 3: duplicated provider client inherits the stalled-body timeout bug

`fetchWithTimeout` clears its timer after headers, before body parsing. Mitigation: `src/lib/ai/client.ts` uses `fetchJsonWithTimeout` so timeout coverage includes `response.json()`.

## Security and privacy stance

The key is a user-supplied BYOK credential stored in ordinary browser `localStorage` and sent directly to the selected provider. This is intentionally not hardened secret storage. UI copy must say “stored in this browser only.” Do not log API-key values.

## Definition of done

- `src/lib/ai` is the only active OpenAI/Gemini HTTP implementation.
- Provider/model constants and validators have one home in `src/lib/ai/settings.ts`.
- One browser-local settings record replaces D1 AI settings.
- D1 schema helpers and AI settings/reveal endpoints are gone from active code; migration history may still mention the old table.
- `/api/craps-advice` is gone.
- Blackjack has no `useLLM` gate/toggle; Ask AI always provides legal local advice, including for guests.
- Signed-in configured Blackjack may use one explicit provider call to rewrite reasoning only.
- Automatic Blackjack round commentary and its barrel/DOM surface are gone.
- Poker, Baccarat, Craps, and Blackjack retain game-specific prompts/validation while sharing provider transport.
- No intermediate implementation commit calls a deleted endpoint.
- Focused tests, repository tests, lint, format check, build, and representative E2E coverage pass.
