# HPA-185: Browser-local BYOK AI + Blackjack Explanation Design

## Status

Planning specification for HPA-185. This PR remains documentation-only; feature implementation belongs in a follow-up PR.

## Why this is next

The architecture roadmap in HPA-167 orders the work as HPA-542 → HPA-545 → HPA-185 → HPA-195 → HPA-553. HPA-545 merged into `main` in PR #30, so HPA-185 is the next unblocked roadmap item.

## Problem

Arcturus already supports OpenAI and Gemini in several single-player AI features, but provider plumbing is duplicated instead of modular:

- `src/lib/blackjack/llmBlackjackStrategy.ts`, `src/lib/craps/llmCrapsStrategy.ts`, `src/lib/baccarat/llmBaccaratStrategy.ts`, `src/lib/poker/llmAIStrategy.ts`, and `src/lib/poker/AIRivalAssistant.ts` each know provider URLs, headers, request shapes, text extraction, and timeout behavior.
- Provider/model constants and validators live inside D1-backed `src/lib/llm-settings.ts`, coupling reusable configuration rules to persistence.
- API keys are stored in D1, exposed through `/api/profile/llm-settings` and `/api/profile/reveal-api-key`, and then sent back to browser callers.
- `/api/craps-advice` exists mainly so Craps can recover that D1-stored key before calling a provider.
- Blackjack gates the whole Ask AI interaction behind `useLLM`, which defaults to false, and disables the button for guests even though deterministic local advice needs no provider.
- Blackjack currently lets model output select an action even though the action can be selected locally and checked against the live legal-action list.
- Blackjack also makes automatic post-round commentary calls that are outside the explicit “what should I do and why?” interaction.
- The repository already contains `extractBalancedJsonObjects()` in `src/lib/llm-response-parsing.ts`, with tests for nested objects, braces in strings, escaped quotes, multiple objects, and unmatched braces, but current provider callers still use weaker ad-hoc JSON regex parsing.

The goal is to delete duplicated transport and credential infrastructure while reusing the strongest existing parsing seam, not to build an AI platform.

## Goals

1. Add one small browser-side `src/lib/ai` module that owns BYOK settings and OpenAI/Gemini HTTP mapping.
2. Move existing provider/model constants and validators into that module rather than duplicating them.
3. Reuse the existing balanced JSON extractor for structured model output.
4. Store one active provider/model/API-key record in browser `localStorage`; remove D1 credential persistence and settings/reveal APIs after all callers migrate.
5. Migrate active provider callers while keeping prompts, game validation, caches, and fallbacks inside each game.
6. Make Blackjack recommendations deterministic and legal for every player, including guests.
7. Allow a configured provider to rewrite only the deterministic Blackjack explanation after an explicit Ask AI click.
8. Remove Blackjack’s redundant `useLLM` toggle and automatic post-round commentary.
9. Prefer deletion over adapters, compatibility paths, provider frameworks, or repository-wide reorganization.

## Non-goals

- No server-side provider proxy.
- No encrypted credential vault or cross-device settings sync.
- No D1-to-localStorage key export, migration, backfill, or compatibility read.
- No provider SDK dependency; keep the existing fetch-based approach.
- No provider plugin system, provider class hierarchy, model router, fallback provider, streaming, agents, tools, prompt registry, memory, embeddings, usage metering, audit trail, or durable rate-limit service.
- No broad rewrite of Poker, Baccarat, or Craps AI behavior.
- No Baccarat AI UI; `getBaccaratAdvice()` has no active page caller, so only its transport is migrated.
- No restructuring from `src/lib/<domain>` to a second `src/modules` hierarchy.
- No removal of Poker’s `useLLMAI` setting. Poker’s LLM opponents invoke providers automatically during hands, so an explicit opt-in remains useful cost control. Blackjack’s Ask AI is already explicitly user-triggered, so its extra toggle is redundant.

## Approaches considered

### A. Small `src/lib/ai` module + browser-local settings — selected

Add a focused module beside `src/lib/wallet` and the current game libraries. It owns provider/model validation, one browser-local settings record, provider HTTP mapping, normalized transport failures, and generic JSON-object extraction.

Games continue to own prompts, result-field validation, legal actions, caches, and fallback behavior.

### B. Extract provider HTTP but keep D1-backed keys — rejected

This would retain the settings repository, profile APIs, reveal endpoint, server/client serialization, and Craps proxy. There is no cross-device requirement justifying those concepts.

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

Keep `src/lib/llm-response-parsing.ts` as the shared balanced-object parser used by `src/lib/ai/client.ts`. Delete the now-redundant Blackjack-only `src/lib/blackjack/llmResponseParsing.ts` once its old action-parser tests are removed.

Do not create `openai.ts`, `gemini.ts`, provider classes, or a provider registry. There are two concrete providers; a switch in `client.ts` is easier to understand.

## Public types

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
  timeoutMs?: number;
}

export type AiErrorCode = 'timeout' | 'provider-error' | 'invalid-response';

export type AiResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: AiErrorCode;
      message: string;
      status?: number;
    };
```

There is no `missing-key` result. `loadAiSettings()` never returns an empty key, `saveAiSettings()` rejects an empty key, and callers only invoke the provider client with a valid `AiSettings` record.

`status` is intentionally optional. Parseable HTTP errors preserve `response.status`, which lets game UI distinguish fixable BYOK failures such as 401 and 429 without creating a larger error taxonomy. Network failures, timeouts, and malformed/non-JSON responses may not have an HTTP status.

`timeoutMs` is a per-request escape hatch, not a timeout framework. Most callers use the 5-second default; Craps keeps its existing 8-second budget because its prompt/output budget is materially larger.

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

One browser stores one current provider/model/key record. Switching provider replaces the whole record; a second hidden provider key is not retained.

Validation policy is asymmetric on purpose:

- `loadAiSettings()` treats malformed or unsupported stored data as unconfigured and returns `null`.
- `saveAiSettings()` validates provider, model, and non-empty trimmed key and throws on invalid input.
- Clearing uses `clearAiSettings()` rather than saving an empty key.

During migration, `src/lib/llm-settings.ts` temporarily imports/re-exports the moved constants and validators so remaining server callers still have one source of truth. That bridge disappears with the D1 path.

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

### HTTP behavior

`client.ts` reuses `fetchJsonWithTimeout` from `src/lib/fetch-with-timeout.ts`, not `fetchWithTimeout`, so the abort timer remains active while the response body is parsed.

It owns:

- OpenAI `/v1/chat/completions` URL, authorization header, messages request shape, and content extraction.
- Gemini `generateContent` URL, API-key query parameter, contents request shape, and content extraction.
- `request.timeoutMs ?? AI_REQUEST_TIMEOUT_MS` as the timeout budget.
- Parseable non-2xx normalization with `status: response.status`.
- Provider text extraction.
- Structured JSON-object extraction via the existing `extractBalancedJsonObjects()` helper.

A provider response may contain prose, fences, multiple objects, nested objects, or braces inside strings. `generateAiJson()` must call `extractBalancedJsonObjects(text)`, try candidates in order, and return the first candidate that parses to a non-array object. It must not use the greedy `/\{[\s\S]*\}/` pattern.

If `fetchJsonWithTimeout` throws while parsing a non-JSON body, classify it as `invalid-response`; no `Response` is available in that path. Parseable provider errors retain status and use `provider-error`.

`client.ts` does not validate `action`, `move`, `suggestedBets`, `confidence`, or `reasoning`; those are game-domain concerns.

### Existing parser cleanup

- `src/lib/llm-response-parsing.ts` becomes a real production dependency of `src/lib/ai/client.ts`.
- `src/lib/llm-response-parsing.test.ts` keeps tests for `extractBalancedJsonObjects()` and drops tests that exist only for the obsolete Blackjack `parseLLMResponse()` wrapper.
- Delete `src/lib/blackjack/llmResponseParsing.ts` after the shared client becomes the structured-output parser.

This leaves one generic extraction helper plus game-specific field validation, rather than two stranded parser layers.

## Profile settings flow

`/profile` remains the signed-in configuration screen, but the AI panel becomes entirely client-side:

1. Server rendering stops reading AI settings from D1.
2. Client initialization calls `loadAiSettings()`.
3. The form shows active provider/model and a masked local key.
4. Save calls `saveAiSettings()` and reports validation/storage errors through existing feedback UI.
5. Show and copy use the already-local key; there is no reveal fetch.
6. Clear calls `clearAiSettings()`.
7. Copy states that the key is stored in this browser only and switching provider replaces the current provider/key.

`src/lib/profile-ui-state.ts` mainly models dual server-stored keys and reveal/copy fetch behavior. Delete it instead of preserving that abstraction with a new shape. Keep only small DOM/form helpers that remain useful in `profile-form-handlers.ts`.

The shared `ai` module has no authentication concept.

## Migration sequence and deployability

The implementation is one breaking PR. Tasks 2–5 are intentionally **not deployable as intermediate production states**.

1. Add `src/lib/ai`, move provider/model constants/validators there, and wire the existing balanced JSON extractor into the new client.
2. Move Profile to local settings while legacy settings APIs/D1 storage remain.
3. Migrate all Blackjack behavior and all Blackjack E2E contracts in one task.
4. Migrate Craps and delete `/api/craps-advice` in the same task.
5. Migrate Baccarat transport plus both Poker AI paths.
6. After no live caller uses D1 AI settings, delete `llm-settings.ts`, its test, profile API helpers/endpoints, and the schema table; generate a forward migration.
7. Run cross-feature cleanup and full verification.

Task commits should remain buildable/testable for the files they change, and no commit may call a deleted endpoint. However, after Task 2 a newly saved browser-local key does not reach still-unmigrated games until Tasks 3–5 land. Do not deploy or merge a partial Tasks 2–5 sequence. Adding dual-write compatibility solely to make those intermediate commits feature-complete is out of scope.

## Persistence deletion and Drizzle history

Remove `llmSettings` from `src/db/schema.ts`, then use the repository script with an explicit migration name:

```bash
bun run db:generate --name=drop_llm_settings
```

Inspect the generated migration before committing. It should drop `llm_settings` and contain no unrelated schema changes. Commit the generated SQL and any Drizzle metadata produced by the command.

Do **not** rewrite `drizzle/0000_powerful_wrecking_crew.sql` or delete historical migration files. `scripts/apply-migrations.ts` applies numbered `.sql` migrations in order, so a forward migration is the executable path for existing and freshly reset hobby databases. Historical migration files may still mention `llm_settings`; active source/runtime code must not.

No D1-to-localStorage export, dual-read, backfill, or compatibility API is added.

## Blackjack behavior

### Ask AI is always local-first

The current `useLLM` setting is redundant under the new interaction. Ask AI is itself explicit opt-in, and provider configuration determines whether a rewrite is possible.

Remove `useLLM` from:

- Blackjack settings types/defaults and `GameSettingsManager`.
- Blackjack settings UI.
- `blackjackClient.ts` state/gating.
- `e2e/blackjack-settings.spec.ts` saved/reset assertions and toggle-gate test.
- `e2e/public-single-player-games.spec.ts` guest persisted-setting setup/assertions.

For every player-turn state:

- Ask AI is available to signed-in players and guests.
- The click always computes and renders deterministic local advice.
- Guests use local advice only and make zero provider requests.
- Signed-in players with valid local settings may receive one provider rewrite after the click.
- Missing provider configuration never blocks or replaces local advice with an overlay.

Delete the Blackjack configuration overlay when its old provider-gate flow is removed.

### Deterministic recommendation is authoritative

Promote the current `getBasicStrategyAdvice()` logic rather than rewriting strategy from scratch:

```ts
export function getBlackjackStrategyAdvice(
  context: BlackjackAdviceContext,
): BlackjackAdvice;
```

It receives the current hand, dealer up-card, and `availableActions`. It returns one action contained in `availableActions` excluding `ask-ai`, plus a concise explanation.

HPA-185 tests the current hit/stand/double/split branches and legal fallback. It is not a full strategy-table research project.

### Model only rewrites reasoning

On explicit Ask AI click:

1. Compute `deterministic = getBlackjackStrategyAdvice(context)` first.
2. Render that recommendation regardless of provider configuration.
3. For a signed-in player with valid local settings, call `generateAiJson()` once with the fixed action and base explanation.
4. Request only `{"reasoning":"..."}`.
5. Ignore any model action field if one appears.
6. On timeout/provider failure/malformed output, keep the deterministic explanation.

### Remove automatic commentary

Delete `getRoundCommentary()`, its barrel export, the post-round call, commentary-only DOM, and the E2E that expects commentary. Provider calls happen only after explicit Ask AI.

### E2E ownership

The Blackjack implementation task must update all E2E tests invalidated by this behavior change **before its commit**:

- `e2e/blackjack-settings.spec.ts`
- `e2e/blackjack-llm.spec.ts`
- `e2e/blackjack-split.spec.ts` as regression coverage for the same client initialization/action path
- `e2e/public-single-player-games.spec.ts`

That task’s gate runs all four. Do not defer broken Blackjack E2E rewrites to a final cleanup task.

## Other game migrations

### Poker LLM opponents

Keep `DecisionCache`, prompt construction, move parsing, and rule-based fallback in `llmAIStrategy.ts`; replace only provider transport.

Keep Poker’s `useLLMAI`. Unlike Blackjack Ask AI, Poker LLM opponents can invoke the provider automatically during game progression, so a per-game enable switch is useful cost control.

### Poker AI Rival

Load the local record through the shared settings function and use the shared provider client. Rename the class helper to `hydrateFromLocalSettings()` so it is not visually confused with imported `loadAiSettings()`.

Keep current Poker guest/provider policy.

### Baccarat

Migrate provider transport only. Do not add a page/UI for otherwise-unused `getBaccaratAdvice()`.

### Craps

Move the useful pure `aggregateBets()` function from the deleted API route into the Craps strategy module. Keep prompt construction and `CrapsAdvice` field validation there.

Craps calls the shared client with its existing longer timeout budget:

```ts
generateAiJson(settings, {
  system: buildSystemPrompt(),
  prompt: buildPrompt(context),
  temperature: 0.8,
  maxOutputTokens: 250,
  timeoutMs: 8_000,
});
```

When the shared client returns `status === 401`, Craps should tell the user to check/update the configured API key. For `status === 429`, preserve a rate-limit-specific message. Other failures use the normal non-blocking fallback message.

Once the page calls the strategy directly, delete `/api/craps-advice` and its route-only validation tests rather than reproducing the server hop.

## Failure behavior

- No local settings: local/rule-based behavior continues; no provider client call is made.
- Provider timeout: shared client returns `timeout`; games fall back locally.
- Parseable provider non-2xx: shared client returns `provider-error` plus `status`.
- Malformed/non-JSON provider body: shared client returns `invalid-response`.
- Invalid localStorage record: treat as unconfigured.
- Invalid profile save or localStorage write failure: show existing profile error feedback; no retry subsystem.
- Craps 401/429: preserve actionable key/rate-limit messaging.

## Testing strategy

### Shared AI module and parser

Unit-test:

- settings round-trip, replacement, clear, invalid load, invalid save;
- moved provider/model validators;
- OpenAI/Gemini request mapping;
- default timeout and explicit timeout override;
- body-timeout handling;
- parseable non-2xx status preservation;
- network/timeout/malformed-response normalization;
- `generateAiJson()` using `extractBalancedJsonObjects()` with multiple/nested/fenced candidates.

Keep extractor-focused coverage in `src/lib/llm-response-parsing.test.ts`; remove obsolete Blackjack parser-wrapper tests.

### Blackjack

Unit-test deterministic legality and hit/stand/double/split/fallback branches. Test provider rewrite cannot change the action and provider failure returns the exact local result.

In the Blackjack task, update and run all affected E2E specs listed above. The new browser contract covers:

- no provider → local advice, zero provider requests;
- configured provider → zero requests before click, exactly one on click, none after round completion;
- guest → local advice, zero provider requests;
- provider failure → deterministic recommendation remains visible;
- no `useLLM` UI/state contract remains.

### Profile

Test local save/reload/show/copy/clear with no settings/reveal API dependency.

### Poker/Baccarat/Craps

Preserve domain parser/fallback tests while mocking the shared client. Keep Poker `DecisionCache` tests. Do not duplicate provider request-shape tests in every game.

## Implementation risks

### Risk 1: old Blackjack gating survives the refactor

If `llmUserEnabled`, guest button disabling, `useLLM` settings state, or old E2E expectations survive, local-first advice remains inaccessible or tests remain red. Mitigation: the Blackjack task owns source, settings tests, all affected Blackjack E2E, and public guest E2E together.

### Risk 2: legacy endpoints are deleted before callers migrate

Profile can move to localStorage before Poker/Blackjack do. Mitigation: D1/API deletion is a dedicated cleanup task after all game callers migrate. Tasks 2–5 are one non-deployable sequence.

### Risk 3: shared provider client regresses JSON parsing

A greedy brace regex is weaker than the repository’s existing tested extractor. Mitigation: `generateAiJson()` consumes `extractBalancedJsonObjects()` and deletes the stranded Blackjack parser wrapper.

### Risk 4: timeout unification unintentionally regresses Craps

Craps currently has an 8-second budget and a larger prompt/output budget. Mitigation: shared default remains 5 seconds, but `AiGenerateRequest.timeoutMs` allows Craps to preserve 8 seconds without adding a second transport path.

## Security and privacy stance

The key is a user-supplied BYOK credential stored in ordinary browser `localStorage` and sent directly to the selected provider. This is intentionally not hardened secret storage. UI copy must say “stored in this browser only.” Do not log API-key values.

## Definition of done

- `src/lib/ai` is the only active OpenAI/Gemini HTTP implementation.
- `src/lib/ai/client.ts` reuses `fetchJsonWithTimeout` and `extractBalancedJsonObjects()`.
- One browser-local settings record replaces D1 AI settings.
- Provider/model constants and validators have one source of truth.
- Parseable provider errors preserve HTTP status without adding a larger error taxonomy.
- Craps retains its 8-second timeout and actionable 401/429 feedback.
- D1 schema/helper/API credential paths are gone through a forward migration, with migration history unchanged.
- `/api/craps-advice` is gone.
- Blackjack Ask AI works by default and for guests, always chooses a legal deterministic action, and only uses a provider to rewrite reasoning after explicit user action.
- Blackjack `useLLM`, configuration overlay, automatic commentary, and their tests are gone.
- Poker retains `useLLMAI` because its automatic opponent calls need explicit cost control.
- `src/lib/blackjack/llmResponseParsing.ts` is gone; shared balanced JSON extraction remains tested and used.
- Poker, Baccarat, Craps, and Blackjack retain their game-specific prompt/validation behavior while sharing provider transport.
- Every implementation task leaves its directly affected tests green, and the Blackjack task does not defer its E2E blast radius to final cleanup.
