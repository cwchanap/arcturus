# Browser-local BYOK AI + Blackjack Explanation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Status:** Implemented on 2026-08-12. The rollout and verification order below is part of the HPA-185 handoff.

**Goal:** Collapse five duplicated provider clients into one browser-local BYOK boundary, make Blackjack advice always local-first and deterministic, and delete D1 credential/server paths after every live caller has migrated.

**Architecture:** Add `src/lib/ai` beside the existing `src/lib/wallet` boundary. Move provider/model validation there, reuse `fetchJsonWithTimeout` plus the existing `extractBalancedJsonObjects()` parser, and store one provider/model/key record in browser `localStorage`. Games keep prompts, domain validation, caches, and fallbacks. Blackjack removes its redundant `useLLM` toggle; Poker keeps `useLLMAI` because its LLM opponents can make automatic paid calls during play.

**Tech Stack:** TypeScript, Astro 5, Bun, Vitest, Playwright, browser `localStorage`, Drizzle Kit, Cloudflare D1 for unrelated application state.

## Global Constraints

- Keep the existing `src/lib/<domain>` layout; do not create a parallel `src/modules` tree.
- No provider SDK, provider hierarchy, plugin registry, server proxy, streaming, agents, tools, prompt registry, provider fallback router, usage service, credential vault, audit trail, or compatibility layer.
- Store exactly one active `{ provider, model, apiKey }` record under `arcturus-ai-settings`.
- Move existing provider/model constants and validators from `src/lib/llm-settings.ts`; do not fork them.
- Preserve model choices: OpenAI `gpt-4o`; Gemini `gemini-2.5-flash` and `gemini-2.5-flash-lite`.
- Default provider timeout is `5_000` ms. Only Craps overrides it to its existing `8_000` ms budget.
- Shared AI code owns provider HTTP mapping and generic JSON-object extraction only. Games own prompts and field/domain validation.
- `AiResult` errors are limited to `timeout`, `provider-error`, and `invalid-response`; parseable HTTP failures may carry `status?: number`.
- Blackjack Ask AI works with default settings and for guests without any provider request.
- Remove Blackjack `useLLM`, its settings/UI/test contract, configuration overlay, and automatic post-round commentary.
- Poker keeps `useLLMAI`, `DecisionCache`, rule-based fallback, and its current guest/provider policy because its LLM opponent path can call providers automatically during play.
- Baccarat receives transport migration only; do not add UI.
- Keep legacy `/api/profile/llm-settings` and D1 credential storage until Blackjack and Poker no longer call them.
- Tasks 2–5 are one non-deployable migration sequence. Do not deploy or merge a partial sequence merely to avoid a temporary local-vs-D1 configuration mismatch.
- Remove `llm_settings` through a forward generated migration; do not rewrite historical migration files.
- Do not log API-key values.

## Implementation Risks

1. **Parser regression:** the shared client must reuse `extractBalancedJsonObjects()` instead of introducing another greedy brace regex.
2. **Blackjack E2E blast radius:** removing `useLLM`, the config overlay, and commentary invalidates multiple E2E files; Task 3 owns all of them before its commit.
3. **Migration gap:** after Profile moves local but before all games migrate, newly saved keys do not reach unmigrated D1-reading games. This is acceptable only because Tasks 2–5 ship together.
4. **Stalled provider body:** use `fetchJsonWithTimeout`, which keeps the abort timer active through JSON body parsing.
5. **Craps latency regression:** preserve its existing 8-second budget through `AiGenerateRequest.timeoutMs`.

---

## File Structure

### Create

- `src/lib/ai/types.ts`
- `src/lib/ai/settings.ts`
- `src/lib/ai/client.ts`
- `src/lib/ai/index.ts`
- `src/lib/ai/settings.test.ts`
- `src/lib/ai/client.test.ts`
- `src/lib/baccarat/llmBaccaratStrategy.test.ts`
- `drizzle/0017_drop_llm_settings.sql` generated in Task 6.

### Modify

- `src/lib/llm-settings.ts` temporarily in Task 1; delete in Task 6.
- `src/lib/llm-settings.test.ts` temporarily in Task 1; delete in Task 6.
- `src/lib/llm-response-parsing.test.ts`
- `src/pages/profile.astro`
- `src/lib/profile-form-handlers.ts`
- `integration/profile-page.test.ts`
- `e2e/profile.spec.ts`
- `src/lib/blackjack/types.ts`
- `src/lib/blackjack/constants.ts`
- `src/lib/blackjack/GameSettingsManager.ts`
- `src/lib/blackjack/GameSettingsManager.test.ts`
- `src/lib/blackjack/llmBlackjackStrategy.ts`
- `src/lib/blackjack/llmBlackjackStrategy.test.ts`
- `src/lib/blackjack/index.ts`
- `src/lib/blackjack/blackjackClient.ts`
- `src/lib/blackjack/blackjackClient.init.test.ts`
- `src/pages/games/blackjack.astro`
- `e2e/blackjack-settings.spec.ts`
- `e2e/blackjack-llm.spec.ts`
- `e2e/blackjack-split.spec.ts`
- `e2e/public-single-player-games.spec.ts`
- `src/lib/craps/llmCrapsStrategy.ts`
- `src/pages/games/craps.astro`
- `src/lib/craps/craps-advice.test.ts`
- `src/lib/baccarat/llmBaccaratStrategy.ts`
- `src/lib/poker/llmAIStrategy.ts`
- `src/lib/poker/llmAIStrategy.test.ts`
- `src/lib/poker/AIRivalAssistant.ts`
- `src/lib/poker/AIRivalAssistant.test.ts`
- `src/lib/poker/PokerGame.ts`
- `src/lib/poker/PokerGame.test.ts`
- `src/db/schema.ts`

### Delete

- `src/lib/blackjack/llmResponseParsing.ts`
- `src/lib/profile-ui-state.ts`
- `src/lib/profile-api.ts`
- `src/lib/llm-settings.ts`
- `src/lib/llm-settings.test.ts`
- `src/pages/api/profile/llm-settings.ts`
- `src/pages/api/profile/reveal-api-key.ts`
- `src/pages/api/craps-advice.ts`
- `src/lib/craps/craps-advice-validation.test.ts`

Historical `drizzle/0000_powerful_wrecking_crew.sql` and `drizzle/0002_jittery_firebrand.ts` remain unchanged.

---

## Task 1: Add the shared AI client and reuse the existing JSON parser

**Files:**
- Create: `src/lib/ai/types.ts`
- Create: `src/lib/ai/settings.ts`
- Create: `src/lib/ai/client.ts`
- Create: `src/lib/ai/index.ts`
- Create: `src/lib/ai/settings.test.ts`
- Create: `src/lib/ai/client.test.ts`
- Modify: `src/lib/llm-settings.ts`
- Modify: `src/lib/llm-response-parsing.test.ts`
- Test: `src/lib/llm-settings.test.ts`
- Delete: `src/lib/blackjack/llmResponseParsing.ts`
- Reuse: `src/lib/fetch-with-timeout.ts`
- Reuse: `src/lib/llm-response-parsing.ts`

**Interfaces:**
- Consumes: `fetchJsonWithTimeout<T>(url: string, init: RequestInit, timeoutMs: number)` and `extractBalancedJsonObjects(input: string): string[]`.
- Produces: `AiProvider`, `AiSettings`, `AiGenerateRequest`, `AiErrorCode`, `AiResult<T>`, provider/model constants/validators, local settings functions, `generateAiText()`, and `generateAiJson()`.

- [ ] **Step 1: Write failing local-settings tests**

Create `src/lib/ai/settings.test.ts`:

```ts
import { afterEach, expect, test } from 'bun:test';
import {
  AI_SETTINGS_STORAGE_KEY,
  clearAiSettings,
  isValidModel,
  isValidProvider,
  loadAiSettings,
  saveAiSettings,
} from './settings';

const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  },
});

afterEach(() => memory.clear());

test('reuses the current provider/model validation contract', () => {
  expect(isValidProvider('openai')).toBe(true);
  expect(isValidProvider('other')).toBe(false);
  expect(isValidModel('openai', 'gpt-4o')).toBe(true);
  expect(isValidModel('openai', 'gemini-2.5-flash')).toBe(false);
});

test('save replaces the one active record and trims the key', () => {
  saveAiSettings({ provider: 'openai', model: 'gpt-4o', apiKey: ' sk-test ' });
  expect(loadAiSettings()).toEqual({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' });

  saveAiSettings({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'AIza-test' });
  expect(loadAiSettings()).toEqual({
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKey: 'AIza-test',
  });
});

test('load ignores garbage while save rejects invalid records', () => {
  localStorage.setItem(AI_SETTINGS_STORAGE_KEY, '{broken');
  expect(loadAiSettings()).toBeNull();
  expect(() => saveAiSettings({ provider: 'openai', model: 'bad-model', apiKey: 'x' })).toThrow();
  expect(() => saveAiSettings({ provider: 'openai', model: 'gpt-4o', apiKey: '   ' })).toThrow();
});

test('clear removes the current record', () => {
  saveAiSettings({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' });
  clearAiSettings();
  expect(loadAiSettings()).toBeNull();
});
```

- [ ] **Step 2: Verify the settings tests fail before implementation**

Run:

```bash
bun test src/lib/ai/settings.test.ts
```

Expected: FAIL resolving `./settings`.

- [ ] **Step 3: Implement shared types and move provider/model definitions**

Create `src/lib/ai/types.ts`:

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

Create `src/lib/ai/settings.ts`:

```ts
import type { AiProvider, AiSettings } from './types';

export const AI_SETTINGS_STORAGE_KEY = 'arcturus-ai-settings';
export const AI_PROVIDERS = ['openai', 'gemini'] as const;
export const AI_MODELS: Record<AiProvider, readonly string[]> = {
  openai: ['gpt-4o'],
  gemini: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
};

export function isValidProvider(value: string): value is AiProvider {
  return AI_PROVIDERS.includes(value as AiProvider);
}

export function isValidModel(provider: AiProvider, model: string): boolean {
  return AI_MODELS[provider].includes(model);
}

function isAiSettings(value: unknown): value is AiSettings {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<AiSettings>;
  return (
    typeof item.provider === 'string' &&
    isValidProvider(item.provider) &&
    typeof item.model === 'string' &&
    isValidModel(item.provider, item.model) &&
    typeof item.apiKey === 'string' &&
    item.apiKey.trim().length > 0
  );
}

export function loadAiSettings(): AiSettings | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(AI_SETTINGS_STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    return isAiSettings(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveAiSettings(settings: AiSettings): void {
  if (!isValidProvider(settings.provider) || !isValidModel(settings.provider, settings.model)) {
    throw new Error('Unsupported AI provider or model');
  }
  const apiKey = settings.apiKey.trim();
  if (!apiKey) throw new Error('API key is required');
  localStorage.setItem(AI_SETTINGS_STORAGE_KEY, JSON.stringify({ ...settings, apiKey }));
}

export function clearAiSettings(): void {
  localStorage.removeItem(AI_SETTINGS_STORAGE_KEY);
}
```

In `src/lib/llm-settings.ts`, remove its duplicated `AI_PROVIDERS`, `AI_MODELS`, `isValidProvider`, and `isValidModel` definitions and import/re-export them from `./ai/settings`. Keep its D1 functions until Task 6.

- [ ] **Step 4: Run new and legacy settings tests**

Run:

```bash
bun test src/lib/ai/settings.test.ts src/lib/llm-settings.test.ts
```

Expected: PASS.

- [ ] **Step 5: Retarget the existing parser tests before deleting the Blackjack wrapper**

Edit `src/lib/llm-response-parsing.test.ts` so it imports only:

```ts
import { describe, expect, test } from 'bun:test';
import { extractBalancedJsonObjects } from './llm-response-parsing';
```

Delete the `parseLLMResponse`/Blackjack-action test sections. Keep the extractor cases for no braces, one object, multiple objects, nested braces, braces inside strings, escaped quotes, stray closing brace, and unclosed objects.

Then delete `src/lib/blackjack/llmResponseParsing.ts`.

- [ ] **Step 6: Write failing shared-client tests, including parser reuse and timeout/status behavior**

Create `src/lib/ai/client.test.ts` with representative cases:

```ts
import { afterEach, expect, mock, test } from 'bun:test';
import { generateAiJson, generateAiText } from './client';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('OpenAI mapping extracts text', async () => {
  globalThis.fetch = mock(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      messages: Array<{ content: string }>;
    };
    expect(body.model).toBe('gpt-4o');
    expect(body.messages.at(-1)?.content).toBe('Explain this move');
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'Stand here.' } }] }),
    );
  }) as typeof fetch;

  expect(
    await generateAiText(
      { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
      { prompt: 'Explain this move' },
    ),
  ).toEqual({ ok: true, value: 'Stand here.' });
});

test('generateAiJson tries balanced candidates instead of a greedy brace regex', async () => {
  globalThis.fetch = mock(async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                'first {not valid} then {"reasoning":"Brace } inside string is safe"} trailing {"ignored":true}',
            },
          },
        ],
      }),
    ),
  ) as typeof fetch;

  expect(
    await generateAiJson(
      { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
      { prompt: 'Explain' },
    ),
  ).toEqual({ ok: true, value: { reasoning: 'Brace } inside string is safe' } });
});

test('parseable HTTP error preserves status', async () => {
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }),
  ) as typeof fetch;

  expect(
    await generateAiText(
      { provider: 'openai', model: 'gpt-4o', apiKey: 'bad-key' },
      { prompt: 'x' },
    ),
  ).toEqual({
    ok: false,
    code: 'provider-error',
    message: 'Provider request failed (401)',
    status: 401,
  });
});

test('timeout override is passed through the shared request path', async () => {
  globalThis.fetch = mock(
    async (_url, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
  ) as typeof fetch;

  const started = Date.now();
  const result = await generateAiText(
    { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
    { prompt: 'x', timeoutMs: 1 },
  );
  expect(Date.now() - started).toBeLessThan(500);
  expect(result).toEqual({ ok: false, code: 'timeout', message: 'AI request timed out' });
});
```

- [ ] **Step 7: Implement the two-provider client on existing timeout/parser seams**

Create `src/lib/ai/client.ts`:

```ts
import { fetchJsonWithTimeout } from '../fetch-with-timeout';
import { extractBalancedJsonObjects } from '../llm-response-parsing';
import type { AiGenerateRequest, AiResult, AiSettings } from './types';

export const AI_REQUEST_TIMEOUT_MS = 5_000;

type OpenAiPayload = {
  choices?: Array<{ message?: { content?: string } }>;
};

type GeminiPayload = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
};

function buildProviderRequest(settings: AiSettings, request: AiGenerateRequest) {
  const temperature = request.temperature ?? 0.3;
  const maxOutputTokens = request.maxOutputTokens ?? 200;

  if (settings.provider === 'openai') {
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
          model: settings.model,
          messages: [
            ...(request.system ? [{ role: 'system', content: request.system }] : []),
            { role: 'user', content: request.prompt },
          ],
          temperature,
          max_tokens: maxOutputTokens,
        }),
      } satisfies RequestInit,
    };
  }

  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:generateContent?key=${settings.apiKey}`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `${request.system ? `${request.system}\n\n` : ''}${request.prompt}`,
              },
            ],
          },
        ],
        generationConfig: { temperature, maxOutputTokens },
      }),
    } satisfies RequestInit,
  };
}

export async function generateAiText(
  settings: AiSettings,
  request: AiGenerateRequest,
): Promise<AiResult<string>> {
  const { url, init } = buildProviderRequest(settings, request);

  let response: Response;
  let data: OpenAiPayload | GeminiPayload;
  try {
    const result = await fetchJsonWithTimeout<OpenAiPayload | GeminiPayload>(
      url,
      init,
      request.timeoutMs ?? AI_REQUEST_TIMEOUT_MS,
    );
    response = result.response;
    data = result.data;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, code: 'timeout', message: 'AI request timed out' };
    }
    if (error instanceof SyntaxError) {
      return { ok: false, code: 'invalid-response', message: 'Provider returned invalid JSON' };
    }
    return { ok: false, code: 'provider-error', message: 'AI request failed' };
  }

  if (!response.ok) {
    return {
      ok: false,
      code: 'provider-error',
      message: `Provider request failed (${response.status})`,
      status: response.status,
    };
  }

  const value =
    settings.provider === 'openai'
      ? (data as OpenAiPayload).choices?.[0]?.message?.content
      : (data as GeminiPayload).candidates?.[0]?.content?.parts
          ?.map((part) => part.text ?? '')
          .join('');

  return typeof value === 'string' && value.trim()
    ? { ok: true, value: value.trim() }
    : { ok: false, code: 'invalid-response', message: 'Provider returned no text' };
}

export async function generateAiJson(
  settings: AiSettings,
  request: AiGenerateRequest,
): Promise<AiResult<Record<string, unknown>>> {
  const text = await generateAiText(settings, request);
  if (!text.ok) return text;

  for (const candidate of extractBalancedJsonObjects(text.value)) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ok: true, value: parsed as Record<string, unknown> };
      }
    } catch {
      // Try the next balanced object.
    }
  }

  return { ok: false, code: 'invalid-response', message: 'Provider returned no valid JSON object' };
}
```

Create `src/lib/ai/index.ts`:

```ts
export type {
  AiProvider,
  AiSettings,
  AiGenerateRequest,
  AiErrorCode,
  AiResult,
} from './types';
export {
  AI_SETTINGS_STORAGE_KEY,
  AI_PROVIDERS,
  AI_MODELS,
  isValidProvider,
  isValidModel,
  loadAiSettings,
  saveAiSettings,
  clearAiSettings,
} from './settings';
export { AI_REQUEST_TIMEOUT_MS, generateAiText, generateAiJson } from './client';
```

- [ ] **Step 8: Run focused tests/lint and commit**

Run:

```bash
bun test \
  src/lib/ai/settings.test.ts \
  src/lib/ai/client.test.ts \
  src/lib/llm-settings.test.ts \
  src/lib/llm-response-parsing.test.ts
bunx eslint src/lib/ai src/lib/llm-settings.ts src/lib/llm-response-parsing.ts
```

Expected: PASS with zero warnings.

Commit:

```bash
git add src/lib/ai src/lib/llm-settings.ts src/lib/llm-response-parsing.test.ts
git add -u src/lib/blackjack/llmResponseParsing.ts
git commit -m "feat: add shared browser AI client"
```

---

## Task 2: Move Profile AI settings to browser-local storage

**Files:**
- Modify: `src/pages/profile.astro`
- Modify: `src/lib/profile-form-handlers.ts`
- Modify: `integration/profile-page.test.ts`
- Modify: `e2e/profile.spec.ts`
- Delete: `src/lib/profile-ui-state.ts`
- Delete: `src/lib/profile-api.ts`
- Keep for now: `src/lib/llm-settings.ts`
- Keep for now: `src/pages/api/profile/llm-settings.ts`
- Keep for now: `src/pages/api/profile/reveal-api-key.ts`

**Interfaces:**
- Consumes: `AI_MODELS`, `AI_PROVIDERS`, `loadAiSettings()`, `saveAiSettings()`, `clearAiSettings()`.
- Produces: Profile browser UI with no D1 AI read/write or reveal fetch.

- [ ] **Step 1: Change Profile tests to require local persistence**

In `e2e/profile.spec.ts`, cover the real local record:

```ts
await page.goto('/profile');
await page.selectOption('#ai-provider', 'openai');
await page.selectOption('#ai-model', 'gpt-4o');
await page.fill('#api-key', 'sk-e2e-local');
await page.click('#ai-settings-form button[type="submit"]');

const stored = await page.evaluate(() => localStorage.getItem('arcturus-ai-settings'));
expect(JSON.parse(stored!)).toEqual({
  provider: 'openai',
  model: 'gpt-4o',
  apiKey: 'sk-e2e-local',
});

await page.reload();
await expect(page.locator('#api-key-status')).toContainText('Saved');
```

Also cover Show, Copy, Clear, and switching providers replacing the single stored record. Do not intercept `/api/profile/llm-settings` or `/api/profile/reveal-api-key` in the new cases.

In `integration/profile-page.test.ts`, remove `getLlmSettings` setup and assert Profile rendering no longer performs an AI-settings D1 read.

- [ ] **Step 2: Run focused tests and verify they fail against the server-backed implementation**

Run:

```bash
vitest run integration/profile-page.test.ts
bunx playwright test e2e/profile.spec.ts
```

Expected: at least the new local-settings cases FAIL before implementation.

- [ ] **Step 3: Delete reveal-oriented UI state and make form handling local**

Delete `src/lib/profile-ui-state.ts`.

In `src/lib/profile-form-handlers.ts`, use the shared settings API directly:

```ts
import {
  clearAiSettings,
  loadAiSettings,
  saveAiSettings,
  type AiSettings,
} from './ai';

export function readCurrentAiSettings(): AiSettings | null {
  return loadAiSettings();
}

export function saveAiSettingsFromForm(
  provider: AiSettings['provider'],
  model: string,
  apiKeyInput: string,
  previous: AiSettings | null,
): AiSettings {
  const masked = /^•+$/.test(apiKeyInput);
  const apiKey =
    masked && previous?.provider === provider
      ? previous.apiKey
      : apiKeyInput.trim();
  const next = { provider, model, apiKey };
  saveAiSettings(next);
  return next;
}

export function clearAiSettingsFromForm(): void {
  clearAiSettings();
}
```

Keep existing `showToast`, `setFeedback`, and `populateModels` helpers if still used. Delete server-save/reveal helpers and imports from `profile-api.ts`.

- [ ] **Step 4: Make `profile.astro` initialize from localStorage only**

Remove the server-side `getLlmSettings()` read from Profile’s `Promise.all` and remove the serialized server AI-settings payload.

In the client script:

```ts
import {
  AI_MODELS,
  AI_PROVIDERS,
  loadAiSettings,
} from '../lib/ai';

const stored = loadAiSettings();
let aiState = stored ?? {
  provider: 'openai' as const,
  model: AI_MODELS.openai[0],
  apiKey: '',
};
```

Show/copy uses `aiState.apiKey` directly. Clear removes local settings. Update copy/help text to state that the key is stored in this browser only and switching provider replaces the active record.

- [ ] **Step 5: Delete the now-unused Profile API wrapper, but keep server endpoints temporarily**

Delete:

```text
src/lib/profile-api.ts
```

Do **not** delete `/api/profile/llm-settings`, `/api/profile/reveal-api-key`, or `src/lib/llm-settings.ts` yet; unmigrated Blackjack/Poker still read them.

- [ ] **Step 6: Run focused Profile/build verification and commit**

Run:

```bash
vitest run integration/profile-page.test.ts
bunx playwright test e2e/profile.spec.ts
bun run build
```

Expected: PASS.

Commit:

```bash
git add src/pages/profile.astro src/lib/profile-form-handlers.ts integration/profile-page.test.ts e2e/profile.spec.ts
git add -u src/lib/profile-ui-state.ts src/lib/profile-api.ts
git commit -m "refactor: keep BYOK settings in browser"
```

**Deployment note:** do not deploy this commit by itself. Newly saved Profile keys are local-only while Blackjack/Poker still read legacy D1 settings until later tasks.

---

## Task 3: Make Blackjack local-first and update its complete E2E blast radius

**Files:**
- Modify: `src/lib/blackjack/types.ts`
- Modify: `src/lib/blackjack/constants.ts`
- Modify: `src/lib/blackjack/GameSettingsManager.ts`
- Modify: `src/lib/blackjack/GameSettingsManager.test.ts`
- Modify: `src/lib/blackjack/llmBlackjackStrategy.ts`
- Modify: `src/lib/blackjack/llmBlackjackStrategy.test.ts`
- Modify: `src/lib/blackjack/index.ts`
- Modify: `src/lib/blackjack/blackjackClient.ts`
- Modify: `src/lib/blackjack/blackjackClient.init.test.ts`
- Modify: `src/pages/games/blackjack.astro`
- Modify: `e2e/blackjack-settings.spec.ts`
- Modify: `e2e/blackjack-llm.spec.ts`
- Modify: `e2e/blackjack-split.spec.ts`
- Modify: `e2e/public-single-player-games.spec.ts`

**Interfaces:**
- Consumes: `AiSettings`, `generateAiJson()`, `loadAiSettings()`.
- Produces: `getBlackjackStrategyAdvice(context): BlackjackAdvice` and `getBlackjackAdvice(context, settings): Promise<BlackjackAdvice>` where the action is always deterministic/legal and provider output may change reasoning only.

- [ ] **Step 1: Remove `useLLM` from the Blackjack settings contract tests first**

Update `GameSettingsManager.test.ts` and `e2e/blackjack-settings.spec.ts` so saved/reset settings cover only starting chips, min/max bet, and dealer speed.

In `e2e/blackjack-settings.spec.ts`:

- remove `controls.useLlm` from the settings-control helper;
- remove the saved-settings expectation that `useLlm` is checked;
- remove the reset-defaults expectation that `useLlm` is unchecked;
- replace the old “LLM toggle can disable AI Rival” test with a local-advice test that requires no toggle.

- [ ] **Step 2: Remove `useLLM` from production settings/UI**

Delete the property from `BlackjackSettings`, defaults, update/reset logic, and settings markup. Delete `llmUserEnabled` from `blackjackClient.ts`.

Run:

```bash
rg "useLLM|setting-use-llm" src/lib/blackjack src/pages/games/blackjack.astro e2e/blackjack-settings.spec.ts
```

Expected: zero matches after the task edits are complete.

- [ ] **Step 3: Promote the existing basic-strategy fallback into the authoritative local function**

In `llmBlackjackStrategy.ts`, rename/export the current basic-strategy function rather than replacing it with a new abstraction:

```ts
export function getBlackjackStrategyAdvice(
  context: BlackjackAdviceContext,
): BlackjackAdvice {
  const { playerHand, dealerUpCard, availableActions } = context;
  const handValue = calculateHandValue(playerHand.cards);
  const dealerValue = ['J', 'Q', 'K'].includes(dealerUpCard.rank)
    ? 10
    : dealerUpCard.rank === 'A'
      ? 11
      : Number.parseInt(dealerUpCard.rank, 10);

  let action: BlackjackAction = 'stand';
  let reasoning = '';

  if (handValue.value <= 11) {
    action = 'hit';
    reasoning = `With ${handValue.value}, take a card because this total cannot bust on one hit.`;
  } else if (handValue.value >= 17) {
    action = 'stand';
    reasoning = `With ${handValue.value}, stand rather than take unnecessary bust risk.`;
  } else if (dealerValue >= 7) {
    action = 'hit';
    reasoning = `With ${handValue.value} against dealer ${dealerValue}, improve the hand against a strong up-card.`;
  } else {
    action = 'stand';
    reasoning = `With ${handValue.value} against dealer ${dealerValue}, let the dealer take the bust risk.`;
  }

  if (
    availableActions.includes('double-down') &&
    (handValue.value === 10 || handValue.value === 11)
  ) {
    action = 'double-down';
    reasoning = `With ${handValue.value}, double down while the one-card upside is strong.`;
  }

  if (availableActions.includes('split') && playerHand.cards.length === 2) {
    const [first, second] = playerHand.cards;
    if (first.rank === second.rank && (first.rank === 'A' || first.rank === '8')) {
      action = 'split';
      reasoning = `Split ${first.rank}s according to the current basic-strategy rule.`;
    }
  }

  const legalActions = availableActions.filter((candidate) => candidate !== 'ask-ai');
  if (!legalActions.includes(action)) {
    action = legalActions.includes('hit')
      ? 'hit'
      : legalActions.includes('stand')
        ? 'stand'
        : legalActions[0];
  }

  return {
    recommendedAction: action ?? null,
    reasoning: `${reasoning} (basic strategy)`,
    confidence: 1,
    raw: '',
  };
}
```

Keep the ticket scoped to the existing strategy rules; do not add a full strategy-table engine.

- [ ] **Step 4: Change provider behavior to reasoning-only**

Use the shared client:

```ts
export async function getBlackjackAdvice(
  context: BlackjackAdviceContext,
  settings: AiSettings | null,
): Promise<BlackjackAdvice> {
  const deterministic = getBlackjackStrategyAdvice(context);
  if (!settings || !deterministic.recommendedAction) return deterministic;

  const result = await generateAiJson(settings, {
    system: 'Explain the already-selected Blackjack move. Do not choose a different move.',
    prompt: [
      `Move: ${deterministic.recommendedAction}`,
      `Base explanation: ${deterministic.reasoning}`,
      'Return {"reasoning":"one concise explanation"}.',
    ].join('\n'),
    temperature: 0.3,
    maxOutputTokens: 120,
  });

  if (!result.ok) return deterministic;
  const reasoning = result.value.reasoning;
  return typeof reasoning === 'string' && reasoning.trim()
    ? {
        ...deterministic,
        reasoning: reasoning.trim(),
        raw: JSON.stringify(result.value),
      }
    : deterministic;
}
```

Delete Blackjack’s private provider functions, private action parser, and `getRoundCommentary()`.

Update `src/lib/blackjack/index.ts` to export `getBlackjackStrategyAdvice` / `getBlackjackAdvice` and remove `getRoundCommentary`.

- [ ] **Step 5: Add strategy tests using the existing `card`, `createContext`, and `mockFetch` helpers**

Representative deterministic case:

```ts
const context = createContext(
  [card('10', 'hearts'), card('6', 'spades')],
  card('10', 'clubs'),
  ['hit', 'stand'],
);
const local = getBlackjackStrategyAdvice(context);
expect(local.recommendedAction).toBe('hit');
expect(context.availableActions).toContain(local.recommendedAction);
```

Provider cannot change the action:

```ts
mockFetch(async () =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: '{"action":"stand","reasoning":"Dealer pressure still favors taking a card."}',
          },
        },
      ],
    }),
  ),
);

const advice = await getBlackjackAdvice(context, {
  provider: 'openai',
  model: 'gpt-4o',
  apiKey: 'test-key',
});
expect(advice.recommendedAction).toBe('hit');
expect(advice.reasoning).toContain('Dealer pressure');
```

Provider failure returns exactly local advice:

```ts
mockFetch(async () => {
  throw new Error('network down');
});
expect(
  await getBlackjackAdvice(context, {
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: 'test-key',
  }),
).toEqual(local);
```

Keep explicit hit, stand, double-down, split, and unavailable-preferred-action fixtures.

- [ ] **Step 6: Remove guest/config gating and automatic commentary in the client**

Delete:

- `llmConfigured` / `llmSettingsLoading` / `loadLlmSettings()`;
- the “AI Rival is disabled” branch;
- guest button disabling;
- config-overlay flow;
- commentary DOM state and post-round provider call.

The click path becomes:

```ts
const providerSettings = isGuestMode ? null : loadAiSettings();
const advice = await getBlackjackAdvice(context, providerSettings);
aiAdviceBox.classList.remove('hidden');
aiAdviceAction.textContent = advice.recommendedAction
  ? `Recommended: ${advice.recommendedAction.toUpperCase()}`
  : 'No legal recommendation';
aiAdviceReasoning.textContent = advice.reasoning;
highlightRecommendedAction(advice.recommendedAction);
```

Guests therefore receive local advice and never send their local browser key to a provider through Blackjack.

Delete commentary/config-overlay markup from `blackjack.astro` when no longer used.

- [ ] **Step 7: Update `blackjackClient.init.test.ts` with the existing DOM harness**

Use existing `buildBlackjackDOM`, `installFetch`, `clickDeal`, `clickStand`, and `flush` helpers.

Guest local advice case:

```ts
const root = buildBlackjackDOM({ guestMode: true, userId: 'guest-ai', initialBalance: 1000 });
localStorage.setItem(
  'arcturus-ai-settings',
  JSON.stringify({ provider: 'openai', model: 'gpt-4o', apiKey: 'stale-guest-key' }),
);
const { calls } = installFetch();
initBlackjackClient();
await flush(5);
clickDeal();
await flush(2);
(document.getElementById('btn-ai-rival') as HTMLButtonElement).click();
await flush(2);
expect(document.getElementById('ai-advice-action')?.textContent).toContain('Recommended:');
expect(calls.some((call) => call.url.includes('api.openai.com'))).toBe(false);
root.remove();
```

Round completion no longer performs AI traffic:

```ts
const root = buildBlackjackDOM({ guestMode: false, userId: 'auth-ai', initialBalance: 1000 });
const { calls } = installFetch();
initBlackjackClient();
await flush(5);
clickDeal();
await flush(2);
clickStand();
await flush(15);
expect(calls.some((call) => call.url.includes('api.openai.com'))).toBe(false);
root.remove();
```

- [ ] **Step 8: Rewrite `e2e/blackjack-llm.spec.ts` in this task, not final cleanup**

Change `gotoBlackjack()` to navigation only:

```ts
async function gotoBlackjack(page: Page) {
  await page.goto('/games/blackjack', { waitUntil: 'networkidle' });
}
```

Delete the old helper that intercepts `/api/profile/llm-settings`, the no-key overlay test, the “Unable to get advice” expectation, and the post-round commentary test.

No-provider case:

```ts
await page.addInitScript(() => localStorage.removeItem('arcturus-ai-settings'));
const providerRequests: string[] = [];
page.on('request', (request) => {
  if (
    request.url().includes('api.openai.com') ||
    request.url().includes('generativelanguage.googleapis.com')
  ) {
    providerRequests.push(request.url());
  }
});
await gotoBlackjack(page);
await dealHand(page, 50);
const aiButton = page.getByRole('button', { name: 'Ask AI Rival' });
await expect(aiButton).toBeEnabled();
await aiButton.click();
await expect(page.locator('#ai-advice-action')).toContainText('Recommended:');
await expect(page.locator('#ai-advice-reasoning')).not.toBeEmpty();
expect(providerRequests).toEqual([]);
```

Configured explicit-only case:

```ts
await page.addInitScript(() =>
  localStorage.setItem(
    'arcturus-ai-settings',
    JSON.stringify({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-fake' }),
  ),
);
let calls = 0;
await page.route('https://api.openai.com/**', async (route) => {
  calls += 1;
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      choices: [
        { message: { content: '{"reasoning":"Local strategy explained."}' } },
      ],
    }),
  });
});
await gotoBlackjack(page);
await dealHand(page, 50);
expect(calls).toBe(0);
await page.getByRole('button', { name: 'Ask AI Rival' }).click();
await expect.poll(() => calls).toBe(1);
await page.getByRole('button', { name: 'Stand' }).click();
await expect(page.getByRole('button', { name: 'New Round' })).toBeVisible({ timeout: 15000 });
expect(calls).toBe(1);
```

Provider-failure case must still show deterministic recommendation/reasoning.

- [ ] **Step 9: Update public guest and split regression E2E unconditionally**

In `e2e/public-single-player-games.spec.ts`, remove the persisted Blackjack `useLLM: true` setup, `#setting-use-llm` assertions, disabled Ask AI assertion, and “Sign in” status expectation. Replace them with an enabled Ask AI + local advice/no-provider-request assertion.

Keep Poker’s `poker_game_settings.useLLMAI` guest test unchanged because Poker retains that setting.

`e2e/blackjack-split.spec.ts` does not need new feature assertions; run it as regression coverage for the same Blackjack client initialization/action path and change only any `useLLM`/removed-DOM references if its current file contains them.

- [ ] **Step 10: Run the complete Blackjack gate before committing**

Run:

```bash
bun test src/lib/blackjack
bunx playwright test \
  e2e/blackjack-settings.spec.ts \
  e2e/blackjack-llm.spec.ts \
  e2e/blackjack-split.spec.ts \
  e2e/public-single-player-games.spec.ts
rg "useLLM|setting-use-llm|getRoundCommentary|ai-commentary-box|llm-config-overlay" \
  src/lib/blackjack \
  src/pages/games/blackjack.astro \
  e2e/blackjack-settings.spec.ts \
  e2e/blackjack-llm.spec.ts \
  e2e/public-single-player-games.spec.ts
```

Expected: tests PASS; scan has zero Blackjack legacy matches.

Commit:

```bash
git add src/lib/blackjack src/pages/games/blackjack.astro
git add e2e/blackjack-settings.spec.ts e2e/blackjack-llm.spec.ts e2e/blackjack-split.spec.ts e2e/public-single-player-games.spec.ts
git commit -m "feat: make blackjack advice always local-first"
```

---

## Task 4: Move Craps advice off the server proxy while preserving timeout/status UX

**Files:**
- Modify: `src/lib/craps/llmCrapsStrategy.ts`
- Modify: `src/pages/games/craps.astro`
- Rewrite: `src/lib/craps/craps-advice.test.ts`
- Delete: `src/pages/api/craps-advice.ts`
- Delete: `src/lib/craps/craps-advice-validation.test.ts`

**Interfaces:**
- Consumes: `AiSettings`, `AiResult<T>`, `generateAiJson()`, `loadAiSettings()`.
- Produces: `getCrapsAdvice(context, settings): Promise<AiResult<CrapsAdvice>>` with local bet aggregation, 8-second provider budget, and no Astro advice route.

- [ ] **Step 1: Preserve useful pure aggregation tests and replace route tests**

Move `aggregateBets()` from the deleted API route into `llmCrapsStrategy.ts`. Keep existing tests proving same type/point bets aggregate, different points remain separate, different types remain separate, and odds are summed.

Add a shared-client strategy test:

```ts
const result = await getCrapsAdvice(
  {
    phase: 'come-out',
    point: null,
    chipBalance: 1000,
    activeBets: [{ id: 'bet-1', type: 'passLine', amount: 25 }],
    rollHistory: [{ die1: 3, die2: 4, total: 7 }],
  },
  { provider: 'openai', model: 'gpt-4o', apiKey: 'test-key' },
);
expect(result.ok).toBe(true);
```

Delete route auth/DB/request-body tests; that boundary disappears.

- [ ] **Step 2: Replace provider transport and retain game-domain parsing**

```ts
export async function getCrapsAdvice(
  ctx: CrapsAdviceContext,
  settings: AiSettings,
): Promise<AiResult<CrapsAdvice>> {
  const normalized = { ...ctx, activeBets: aggregateBets(ctx.activeBets) };
  const result = await generateAiJson(settings, {
    system: buildSystemPrompt(),
    prompt: buildPrompt(normalized),
    temperature: 0.8,
    maxOutputTokens: 250,
    timeoutMs: 8_000,
  });
  if (!result.ok) return result;
  return { ok: true, value: parsePayload(result.value) };
}
```

Delete Craps’ local OpenAI/Gemini functions, local `LLMSettings`, and old timeout constant. Keep prompt, bet validation, response-field parsing, and the moved `aggregateBets()` local to Craps.

- [ ] **Step 3: Call Craps directly from the page and preserve actionable errors**

```ts
llmAdviceBtn.addEventListener('click', async () => {
  if (isGuestMode) {
    llmAdviceEl.textContent = 'Sign in and configure an AI provider in Profile to use provider advice.';
    return;
  }

  const settings = loadAiSettings();
  if (!settings) {
    llmAdviceEl.textContent = 'Configure an AI provider in Profile to use advice.';
    return;
  }

  const state = game.getState();
  const result = await getCrapsAdvice(
    {
      phase: state.phase,
      point: state.point,
      activeBets: state.activeBets,
      rollHistory: state.rollHistory,
      chipBalance: state.chipBalance,
    },
    settings,
  );

  if (!result.ok) {
    llmAdviceEl.textContent =
      result.status === 401
        ? 'Invalid API key. Update your AI settings in Profile.'
        : result.status === 429
          ? 'AI provider rate limit reached. Please wait a moment.'
          : 'AI advice is unavailable. You can keep playing normally.';
    return;
  }

  llmAdviceEl.textContent = result.value.advice;
});
```

- [ ] **Step 4: Delete the proxy only after the page migration is complete**

Delete:

```text
src/pages/api/craps-advice.ts
src/lib/craps/craps-advice-validation.test.ts
```

- [ ] **Step 5: Run Craps tests/build/scan and commit**

Run:

```bash
bun test src/lib/craps
bun run build
rg "/api/craps-advice|getLlmSettings|api.openai.com|generativelanguage.googleapis.com" \
  src/lib/craps \
  src/pages/games/craps.astro
```

Expected: tests/build PASS; scan has zero matches.

Commit:

```bash
git add src/lib/craps src/pages/games/craps.astro
git add -u src/pages/api/craps-advice.ts
git commit -m "refactor: call craps AI from browser"
```

---

## Task 5: Migrate Baccarat and both Poker AI paths

**Files:**
- Create: `src/lib/baccarat/llmBaccaratStrategy.test.ts`
- Modify: `src/lib/baccarat/llmBaccaratStrategy.ts`
- Modify: `src/lib/poker/llmAIStrategy.ts`
- Modify: `src/lib/poker/llmAIStrategy.test.ts`
- Modify: `src/lib/poker/AIRivalAssistant.ts`
- Modify: `src/lib/poker/AIRivalAssistant.test.ts`
- Modify: `src/lib/poker/PokerGame.ts`
- Modify: `src/lib/poker/PokerGame.test.ts`

**Interfaces:**
- Consumes: `AiSettings`, `generateAiJson()`, `loadAiSettings()`.
- Produces: existing Baccarat/Poker domain outputs with no direct provider HTTP outside `src/lib/ai/client.ts`.

- [ ] **Step 1: Add failing Baccarat/Poker tests around the shared-client behavior**

Baccarat representative assertion:

```ts
const result = await getBaccaratAdvice(context, {
  provider: 'openai',
  model: 'gpt-4o',
  apiKey: 'test-key',
});
expect(result.suggestedBets).toContain('banker');
```

Poker LLM-opponent failure must still use the current rule-based fallback:

```ts
const decision = await makeLLMDecision(
  context,
  'tight-aggressive',
  { provider: 'openai', model: 'gpt-4o', apiKey: 'test-key' },
);
expect(['fold', 'check', 'call', 'raise']).toContain(decision.action);
```

Poker AI Rival/PokerGame tests should set:

```ts
localStorage.setItem(
  'arcturus-ai-settings',
  JSON.stringify({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-local' }),
);
```

and assert no `/api/profile/llm-settings` fetch occurs after migration.

- [ ] **Step 2: Migrate Baccarat transport only**

Keep its existing prompt/session logic. Replace local provider methods with:

```ts
const result = await generateAiJson(settings, {
  system: buildSystemPrompt(),
  prompt: buildPrompt(context),
  temperature: 0.7,
  maxOutputTokens: 300,
});
if (!result.ok) throw new Error(result.message);
return parseBaccaratPayload(result.value);
```

Delete its local `LLMSettings`, timeout constant, `callOpenAI`, and `callGemini`. Do not add UI.

- [ ] **Step 3: Migrate Poker LLM opponents while preserving cache/fallback**

Keep `DecisionCache` unchanged.

Convert the parser to accept an already-parsed payload:

```ts
function parseLLMPayload(
  payload: Record<string, unknown>,
  context: GameContext,
): AIDecision | null {
  const rawAction = payload.action;
  const action = typeof rawAction === 'string' ? rawAction.toLowerCase() : '';
  if (!['fold', 'check', 'call', 'raise'].includes(action)) return null;

  let amount = 0;
  if (action === 'raise') {
    const requested = typeof payload.amount === 'number' ? Math.round(payload.amount) : 0;
    const minRaise = Math.max(context.minimumBet, 10);
    amount = Math.max(minRaise, Math.min(requested, context.player.chips, 200));
  }

  return {
    action: action as AIDecision['action'],
    amount,
    confidence: 0.8,
    reasoning: `LLM decision: ${action}${action === 'raise' ? ` $${amount}` : ''}`,
  };
}
```

Provider path:

```ts
const result = await generateAiJson(llmSettings, {
  system: 'You are an expert poker AI. Respond only with valid JSON.',
  prompt: buildLLMPrompt(context, personality),
  temperature: 0.7,
  maxOutputTokens: 100,
});

if (!result.ok) {
  return ruleBasedFallback(context, personality, difficulty, 'LLM error fallback');
}

const decision = parseLLMPayload(result.value, context);
if (!decision) {
  return ruleBasedFallback(context, personality, difficulty, 'LLM parse failed');
}

decisionCache.set(context, decision);
return decision;
```

Delete local provider methods only; retain cache and rule-based behavior.

- [ ] **Step 4: Migrate Poker AI Rival and settings lookup**

In `AIRivalAssistant.ts`:

```ts
private hydrateFromLocalSettings(): void {
  this.aiSettings = loadAiSettings();
  this.setButtonState({ disabled: !this.aiSettings });
  this.updateStatus();
}
```

Replace its OpenAI/Gemini methods with `generateAiJson()`, keeping `parseAiMove()` and button/highlight behavior local.

In `PokerGame.ts`, replace `getLLMSettings()`’s `/api/profile/llm-settings` fetch with `loadAiSettings()`.

Keep `settings.useLLMAI` and its missing-key guard. It controls automatic LLM opponents and therefore remains explicit cost control.

- [ ] **Step 5: Run affected tests and provider/settings scans**

Run:

```bash
bun test \
  src/lib/baccarat/llmBaccaratStrategy.test.ts \
  src/lib/poker/llmAIStrategy.test.ts \
  src/lib/poker/AIRivalAssistant.test.ts \
  src/lib/poker/PokerGame.test.ts
rg "api.openai.com|generativelanguage.googleapis.com|/api/profile/llm-settings" \
  src/lib/baccarat \
  src/lib/poker
```

Expected: tests PASS; scan has zero matches.

- [ ] **Step 6: Commit**

```bash
git add src/lib/baccarat src/lib/poker
git commit -m "refactor: share AI provider transport"
```

**Deployment note:** Tasks 2–5 now form the complete browser-local migration. Do not deploy a partial subset.

---

## Task 6: Delete legacy D1 credential storage and generate a forward migration

**Files:**
- Modify: `src/db/schema.ts`
- Generate: `drizzle/0017_drop_llm_settings.sql`
- Delete: `src/lib/llm-settings.ts`
- Delete: `src/lib/llm-settings.test.ts`
- Delete: `src/pages/api/profile/llm-settings.ts`
- Delete: `src/pages/api/profile/reveal-api-key.ts`

**Interfaces:**
- Consumes: all caller migrations from Tasks 2–5.
- Produces: no runtime server-side AI credential persistence or API.

- [ ] **Step 1: Prove no live caller still needs the legacy path**

Run:

```bash
rg "/api/profile/llm-settings|/api/profile/reveal-api-key|getLlmSettings|upsertLlmSettings" \
  src integration e2e
```

Expected before deletion: only the legacy endpoint/repository files themselves remain. If another live caller appears, migrate it before continuing.

- [ ] **Step 2: Remove `llmSettings` from the active schema**

Delete the `llmSettings = sqliteTable('llm_settings', ...)` definition from `src/db/schema.ts` and remove any now-unused imports caused by that deletion.

- [ ] **Step 3: Generate a named forward migration through the repository script**

Run:

```bash
bun run db:generate --name=drop_llm_settings
```

Inspect the new migration. Expected SQL effect:

```sql
DROP TABLE `llm_settings`;
```

The generated filename should use the next migration number and `drop_llm_settings` name. Commit any generated Drizzle metadata as produced by the command. Do not hand-edit historical `0000` or delete `0002_jittery_firebrand.ts`.

- [ ] **Step 4: Delete the legacy repository/endpoints and their tests**

Delete:

```text
src/lib/llm-settings.ts
src/lib/llm-settings.test.ts
src/pages/api/profile/llm-settings.ts
src/pages/api/profile/reveal-api-key.ts
```

- [ ] **Step 5: Verify active references are gone while history may still mention the table**

Run:

```bash
rg "llm-settings|reveal-api-key|getLlmSettings|upsertLlmSettings" src integration e2e
rg "llm_settings" src
rg "llm_settings" drizzle
```

Expected:

- first scan: zero matches;
- second scan: zero matches;
- third scan: historical creation plus the new forward drop migration may match.

- [ ] **Step 6: Run schema/test/build gates and commit**

Run:

```bash
bun run test
bun run build
```

Expected: PASS.

Commit:

```bash
git add src/db/schema.ts drizzle
git add -u src/lib/llm-settings.ts src/lib/llm-settings.test.ts src/pages/api/profile/llm-settings.ts src/pages/api/profile/reveal-api-key.ts
git commit -m "refactor: remove server AI credential storage"
```

---

## Task 7: Cross-feature cleanup and full verification

**Files:**
- Modify only existing files implicated by a failing verification command.

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: one provider boundary, one local settings record, green tests, and no obsolete AI infrastructure.

- [ ] **Step 1: Run architecture scans**

```bash
rg "api.openai.com|generativelanguage.googleapis.com" src/lib src/pages
rg "/api/profile/llm-settings|/api/profile/reveal-api-key|/api/craps-advice" src integration e2e
rg "useLLM|setting-use-llm|getRoundCommentary|llm-config-overlay|ai-commentary-box" \
  src/lib/blackjack \
  src/pages/games/blackjack.astro \
  e2e
rg "parseLLMResponse" src/lib
```

Expected:

- provider URLs appear only in `src/lib/ai/client.ts`;
- legacy endpoint/Blackjack scans have zero matches;
- `parseLLMResponse` scan has zero matches;
- `extractBalancedJsonObjects` remains in `src/lib/llm-response-parsing.ts`, its tests, and `src/lib/ai/client.ts`.

- [ ] **Step 2: Run unit and integration suites**

Run:

```bash
bun run test
```

Expected: PASS.

- [ ] **Step 3: Run lint, format check, and build**

Run:

```bash
bun run lint
bun run format:check
bun run build
```

Expected: PASS with zero errors/warnings.

- [ ] **Step 4: Run representative E2E gates**

Run:

```bash
bunx playwright test \
  e2e/blackjack-settings.spec.ts \
  e2e/blackjack-llm.spec.ts \
  e2e/blackjack-split.spec.ts \
  e2e/public-single-player-games.spec.ts \
  e2e/profile.spec.ts \
  e2e/craps.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full Playwright gate**

Run:

```bash
bun run test:e2e
```

Expected: PASS under the repository’s normal E2E environment.

- [ ] **Step 6: Review the final diff for KISS/deletion goals**

Run:

```bash
git diff --stat main...HEAD
git diff main...HEAD -- \
  src/lib/ai \
  src/lib/llm-response-parsing.ts \
  src/lib/llm-response-parsing.test.ts \
  src/lib/blackjack \
  src/lib/craps \
  src/lib/baccarat \
  src/lib/poker \
  src/pages/profile.astro \
  src/db/schema.ts \
  drizzle
```

Verify from the diff:

- one provider transport;
- one local settings record;
- one provider/model validator source;
- existing balanced JSON extractor is reused rather than copied;
- no Blackjack enable toggle or guest local-advice gate;
- no automatic Blackjack provider request;
- Poker retains `useLLMAI` only for automatic opponent cost control;
- Craps explicitly keeps an 8-second timeout and status-aware 401/429 UX;
- no legacy runtime credential API/repository;
- no compatibility adapter/provider hierarchy;
- migration history was not rewritten.

- [ ] **Step 7: Commit only concrete verification fixes if verification changed files**

Run:

```bash
git status --short
```

If the tree is clean, do not create an empty commit. If a preceding verification command required a fix, stage the exact paths shown by `git status --short`, rerun the failed command, and commit those concrete paths with:

```bash
git commit -m "fix: complete HPA-185 AI migration"
```

## HPA-185 production rollout and migration recovery

Tasks 2–6 are one deployable browser-local migration. For production, deploy and
verify the new Worker before applying the destructive D1 migration:

1. Deploy the new Worker with `bun run deploy`.
2. Verify the deployed Worker is serving the new browser-local Profile and game
   code (including a Profile save and an explicit Blackjack Ask AI smoke check).
3. Only after that verification succeeds, run `bun run db:migrate:remote`.

Do not run the migration first. The old Worker still reads `llm_settings`, so
dropping that table before the new Worker is active can break requests served by
the old code.

If the migration SQL succeeds but recording the migration fails, the migration
runner prints:

```text
⚠️  WARNING: Migration was applied but tracking record failed!
📋 MANUAL RECOVERY REQUIRED:
   Run this command to manually mark the migration as applied:
```

Copy and run the exact command printed immediately below that warning. Its form
is:

```bash
wrangler d1 execute arcturus --remote --command="INSERT INTO _migrations (name, appliedAt) VALUES ('<migration>', <appliedAt>)"
```

Use the migration filename and timestamp printed by the runner; do not rerun the
SQL after it has succeeded.
