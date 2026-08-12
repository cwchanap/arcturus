# Browser-local BYOK AI + Blackjack Explanation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace duplicated/server-backed AI provider plumbing with one browser-local BYOK module, make Blackjack advice always available and deterministic, and delete obsolete credential/server paths only after every live caller has migrated.

**Architecture:** Add `src/lib/ai` beside the existing `src/lib/wallet` boundary. Move provider/model validation there, store one local provider/model/key record, and centralize only OpenAI/Gemini HTTP mapping through `fetchJsonWithTimeout`. Games keep prompts, parsers, caches, legality rules, and fallbacks. Blackjack removes its redundant `useLLM` toggle: every Ask AI click returns local advice, while a configured provider may rewrite only the reasoning for signed-in players.

**Tech Stack:** TypeScript, Astro 5, Bun, Vitest, Playwright, browser `localStorage`, Drizzle Kit, Cloudflare D1 for unrelated application state.

## Global Constraints

- Keep the existing `src/lib/<domain>` layout; do not create a parallel `src/modules` tree.
- No provider SDK, provider hierarchy, plugin registry, server proxy, streaming, agents, tools, prompt registry, provider fallback router, usage service, credential vault, audit trail, or compatibility layer.
- Store exactly one active `{ provider, model, apiKey }` record under `arcturus-ai-settings`.
- Move existing provider/model constants and validators from `src/lib/llm-settings.ts`; do not fork them.
- Preserve model choices: OpenAI `gpt-4o`; Gemini `gemini-2.5-flash` and `gemini-2.5-flash-lite`.
- Use one provider timeout: `5_000` ms.
- Shared AI code owns provider HTTP mapping only. Games own prompts and game-domain validation.
- Blackjack Ask AI works with default settings and for guests without any provider request.
- Remove Blackjack `useLLM`, its settings UI/test contract, configuration overlay, and automatic post-round commentary.
- Poker keeps `DecisionCache`, rule-based fallback, and its existing guest/provider policy.
- Baccarat gets transport migration only; do not add UI.
- Keep legacy `/api/profile/llm-settings` until Blackjack and Poker no longer call it.
- Remove `llm_settings` through a forward generated migration; do not rewrite historical migration files.
- Do not log API-key values.

## Implementation Risks

1. **Blackjack gate survives:** Task 3 removes `useLLM`, guest button disabling, and the old E2E gate in the same commit.
2. **Deleted endpoint gap:** Task 6 owns legacy API/D1 deletion only after Tasks 3-5 migrate the last callers.
3. **Stalled provider body:** Task 1 uses `fetchJsonWithTimeout`, which keeps the timeout armed through body parsing.

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
- `e2e/public-single-player-games.spec.ts` if its existing settings-endpoint interception remains after caller migration.

### Delete

- `src/lib/profile-ui-state.ts`
- `src/lib/llm-settings.ts`
- `src/lib/llm-settings.test.ts`
- `src/lib/profile-api.ts`
- `src/pages/api/profile/llm-settings.ts`
- `src/pages/api/profile/reveal-api-key.ts`
- `src/pages/api/craps-advice.ts`
- `src/lib/craps/craps-advice-validation.test.ts`

Historical `drizzle/0000_powerful_wrecking_crew.sql` and `drizzle/0002_jittery_firebrand.ts` remain unchanged.

---

### Task 1: Add the shared AI settings and provider client

**Files:**
- Create: `src/lib/ai/types.ts`
- Create: `src/lib/ai/settings.ts`
- Create: `src/lib/ai/client.ts`
- Create: `src/lib/ai/index.ts`
- Create: `src/lib/ai/settings.test.ts`
- Create: `src/lib/ai/client.test.ts`
- Modify: `src/lib/llm-settings.ts`
- Test: `src/lib/llm-settings.test.ts`
- Reuse: `src/lib/fetch-with-timeout.ts`

**Interfaces:**
- Consumes: `fetchJsonWithTimeout<T>(url, init, timeoutMs)`.
- Produces: `AiProvider`, `AiSettings`, `AiGenerateRequest`, `AiErrorCode`, `AiResult<T>`, provider/model constants/validators, local settings functions, `generateAiText()`, and `generateAiJson()`.

- [ ] **Step 1: Write failing settings tests**

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

test('validates the existing provider/model contract', () => {
  expect(isValidProvider('openai')).toBe(true);
  expect(isValidProvider('other')).toBe(false);
  expect(isValidModel('openai', 'gpt-4o')).toBe(true);
  expect(isValidModel('openai', 'gemini-2.5-flash')).toBe(false);
});

test('save replaces the single active record and trims the key', () => {
  saveAiSettings({ provider: 'openai', model: 'gpt-4o', apiKey: ' sk-test ' });
  expect(loadAiSettings()).toEqual({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' });

  saveAiSettings({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'AIza-test' });
  expect(loadAiSettings()).toEqual({
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKey: 'AIza-test',
  });
});

test('load ignores garbage while save rejects invalid values', () => {
  localStorage.setItem(AI_SETTINGS_STORAGE_KEY, '{broken');
  expect(loadAiSettings()).toBeNull();
  expect(() => saveAiSettings({ provider: 'openai', model: 'bad-model', apiKey: 'x' })).toThrow();
  expect(() => saveAiSettings({ provider: 'openai', model: 'gpt-4o', apiKey: '   ' })).toThrow();
});

test('clear removes the record', () => {
  saveAiSettings({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' });
  clearAiSettings();
  expect(loadAiSettings()).toBeNull();
});
```

- [ ] **Step 2: Verify the new settings test fails before implementation**

Run: `bun test src/lib/ai/settings.test.ts`

Expected: FAIL resolving `./settings`.

- [ ] **Step 3: Move provider/model definitions and implement local settings**

```ts
// src/lib/ai/types.ts
export type AiProvider = 'openai' | 'gemini';
export interface AiSettings { provider: AiProvider; model: string; apiKey: string; }
export interface AiGenerateRequest {
  system?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
}
export type AiErrorCode = 'missing-key' | 'timeout' | 'provider-error' | 'invalid-response';
export type AiResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: AiErrorCode; message: string };
```

```ts
// src/lib/ai/settings.ts
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

In `src/lib/llm-settings.ts`, import/re-export `AI_MODELS`, `AI_PROVIDERS`, `isValidModel`, and `isValidProvider` from `./ai/settings`; remove its duplicate definitions. Keep its DB functions until Task 6.

- [ ] **Step 4: Run new plus legacy settings tests**

Run: `bun test src/lib/ai/settings.test.ts src/lib/llm-settings.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing provider-client tests**

```ts
import { afterEach, expect, mock, test } from 'bun:test';
import { generateAiJson, generateAiText } from './client';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('OpenAI mapping extracts text', async () => {
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: 'Stand here.' } }] })),
  ) as typeof fetch;
  expect(await generateAiText(
    { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
    { prompt: 'Explain this move' },
  )).toEqual({ ok: true, value: 'Stand here.' });
});

test('Gemini mapping extracts JSON', async () => {
  globalThis.fetch = mock(async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: '{"reasoning":"Dealer is weak"}' }] } }],
  }))) as typeof fetch;
  expect(await generateAiJson(
    { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'AIza-test' },
    { prompt: 'Explain' },
  )).toEqual({ ok: true, value: { reasoning: 'Dealer is weak' } });
});

test('parseable HTTP errors, aborts, and malformed bodies normalize', async () => {
  globalThis.fetch = mock(async () => new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 })) as typeof fetch;
  const http = await generateAiText(
    { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
    { prompt: 'x' },
  );
  expect(http.ok).toBe(false);
  if (!http.ok) expect(http.code).toBe('provider-error');

  globalThis.fetch = mock(async () => { throw new DOMException('Aborted', 'AbortError'); }) as typeof fetch;
  const timeout = await generateAiText(
    { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
    { prompt: 'x' },
  );
  expect(timeout.ok).toBe(false);
  if (!timeout.ok) expect(timeout.code).toBe('timeout');

  globalThis.fetch = mock(async () => new Response('not-json')) as typeof fetch;
  const malformed = await generateAiText(
    { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
    { prompt: 'x' },
  );
  expect(malformed.ok).toBe(false);
  if (!malformed.ok) expect(malformed.code).toBe('invalid-response');
});
```

- [ ] **Step 6: Implement the two-provider client on `fetchJsonWithTimeout`**

```ts
// src/lib/ai/client.ts
import { fetchJsonWithTimeout } from '../fetch-with-timeout';
import type { AiGenerateRequest, AiResult, AiSettings } from './types';

export const AI_REQUEST_TIMEOUT_MS = 5_000;

type OpenAiPayload = { choices?: Array<{ message?: { content?: string } }> };
type GeminiPayload = { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };

function providerRequest(settings: AiSettings, request: AiGenerateRequest) {
  const temperature = request.temperature ?? 0.3;
  const maxOutputTokens = request.maxOutputTokens ?? 200;
  if (settings.provider === 'openai') {
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
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
        contents: [{ role: 'user', parts: [{ text: `${request.system ? `${request.system}\n\n` : ''}${request.prompt}` }] }],
        generationConfig: { temperature, maxOutputTokens },
      }),
    } satisfies RequestInit,
  };
}

export async function generateAiText(
  settings: AiSettings,
  request: AiGenerateRequest,
): Promise<AiResult<string>> {
  if (!settings.apiKey.trim()) return { ok: false, code: 'missing-key', message: 'API key not configured' };
  const { url, init } = providerRequest(settings, request);
  let response: Response;
  let data: OpenAiPayload | GeminiPayload;
  try {
    ({ response, data } = await fetchJsonWithTimeout<OpenAiPayload | GeminiPayload>(url, init, AI_REQUEST_TIMEOUT_MS));
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, code: 'timeout', message: 'AI request timed out' };
    }
    return { ok: false, code: 'invalid-response', message: 'Provider returned invalid JSON' };
  }
  if (!response.ok) {
    return { ok: false, code: 'provider-error', message: `Provider request failed (${response.status})` };
  }
  const value = settings.provider === 'openai'
    ? (data as OpenAiPayload).choices?.[0]?.message?.content
    : (data as GeminiPayload).candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('');
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
  const match = text.value.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false, code: 'invalid-response', message: 'Provider returned no JSON object' };
  try {
    return { ok: true, value: JSON.parse(match[0]) as Record<string, unknown> };
  } catch {
    return { ok: false, code: 'invalid-response', message: 'Provider returned invalid JSON object' };
  }
}
```

`src/lib/ai/index.ts` re-exports the public types/settings/client functions. Keep `providerRequest()` private.

- [ ] **Step 7: Run focused tests and commit**

Run: `bun test src/lib/ai src/lib/llm-settings.test.ts && bunx eslint src/lib/ai src/lib/llm-settings.ts`

Expected: PASS.

```bash
git add src/lib/ai src/lib/llm-settings.ts src/lib/llm-settings.test.ts
git commit -m "feat: add shared browser AI module"
```

---

### Task 2: Move Profile settings local without deleting legacy APIs

**Files:**
- Modify: `src/pages/profile.astro`
- Modify: `src/lib/profile-form-handlers.ts`
- Modify: `integration/profile-page.test.ts`
- Modify: `e2e/profile.spec.ts`
- Delete: `src/lib/profile-ui-state.ts`
- Keep: `src/lib/profile-api.ts`, profile AI API routes, `src/lib/llm-settings.ts`, and `src/db/schema.ts` until Task 6.

**Interfaces:**
- Consumes: `AI_MODELS`, `AI_PROVIDERS`, `isValidProvider()`, `loadAiSettings()`, `saveAiSettings()`, `clearAiSettings()`.
- Produces: Profile UI backed only by one local `AiSettings` record.

- [ ] **Step 1: Change Profile tests to require local persistence and no D1 settings read**

```ts
await page.goto('/profile');
await page.selectOption('#ai-provider', 'openai');
await page.selectOption('#ai-model', 'gpt-4o');
await page.fill('#api-key', 'sk-e2e-local');
await page.locator('#ai-settings-form').getByRole('button', { name: /save/i }).click();
expect(await page.evaluate(() => localStorage.getItem('arcturus-ai-settings'))).toBe(
  JSON.stringify({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-e2e-local' }),
);
```

In `integration/profile-page.test.ts`, remove the expected `getLlmSettings()` server read.

- [ ] **Step 2: Run Profile tests and verify they fail**

Run: `vitest run integration/profile-page.test.ts`

Expected: FAIL while Profile still reads D1 AI settings.

- [ ] **Step 3: Delete the reveal-oriented state class and save locally**

```ts
// src/lib/profile-form-handlers.ts
import { isValidProvider, saveAiSettings, type AiSettings } from './ai';

export function saveAiSettingsFromForm(
  providerValue: string,
  model: string,
  apiKey: string,
): AiSettings {
  if (!isValidProvider(providerValue)) throw new Error('Unsupported AI provider');
  const settings = { provider: providerValue, model, apiKey };
  saveAiSettings(settings);
  return settings;
}
```

Delete `src/lib/profile-ui-state.ts`; do not preserve `revealApiKey(fetchFn)` or dual-key flags.

- [ ] **Step 4: Wire Profile show/copy/clear directly to local state**

```ts
const stored = loadAiSettings();
let aiState = stored ?? {
  provider: 'openai' as const,
  model: AI_MODELS.openai[0],
  apiKey: '',
};

showKeyButton?.addEventListener('click', () => {
  if (apiKeyInput && aiState.apiKey) {
    apiKeyInput.type = 'text';
    apiKeyInput.value = aiState.apiKey;
  }
});

copyKeyButton?.addEventListener('click', async () => {
  if (!aiState.apiKey) return;
  await navigator.clipboard.writeText(aiState.apiKey);
  showToast(toastEl, toastMessage, 'API key copied to clipboard!');
});

clearKeyButton?.addEventListener('click', () => {
  clearAiSettings();
  aiState = { provider: aiState.provider, model: aiState.model, apiKey: '' };
  if (apiKeyInput) apiKeyInput.value = '';
});
```

Remove Profile’s server-side `getLlmSettings()` work and `aiSettingsPayload`. Update copy to “Stored in this browser only.” Leave old API files in place for unmigrated game callers.

- [ ] **Step 5: Verify and commit**

Run: `vitest run integration/profile-page.test.ts && bunx playwright test e2e/profile.spec.ts && bun run build`

Expected: PASS.

```bash
git add src/pages/profile.astro src/lib/profile-form-handlers.ts integration/profile-page.test.ts e2e/profile.spec.ts
git add -u src/lib/profile-ui-state.ts
git commit -m "refactor: keep AI settings in browser"
```

---

### Task 3: Make Blackjack Ask AI always local-first

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

**Interfaces:**
- Consumes: `AiSettings`, `generateAiJson()`, `loadAiSettings()`.
- Produces: `getBlackjackStrategyAdvice(context)` and `getBlackjackAdvice(context, settings)`; Ask AI available on every player turn.

- [ ] **Step 1: Add failing deterministic-authority tests**

```ts
test('hard 16 against dealer 10 recommends legal hit', () => {
  const context = makeContext({ playerRanks: ['10', '6'], dealerRank: '10', availableActions: ['hit', 'stand'] });
  const advice = getBlackjackStrategyAdvice(context);
  expect(advice.recommendedAction).toBe('hit');
  expect(context.availableActions).toContain(advice.recommendedAction);
});

test('provider cannot replace deterministic action', async () => {
  const context = makeContext({ playerRanks: ['10', '6'], dealerRank: '10', availableActions: ['hit', 'stand'] });
  mockGenerateAiJson.mockResolvedValue({
    ok: true,
    value: { action: 'stand', reasoning: 'Take a card against this strong up-card.' },
  });
  const advice = await getBlackjackAdvice(context, AI_SETTINGS);
  expect(advice.recommendedAction).toBe('hit');
});

test('provider failure returns exact local advice', async () => {
  const context = makeContext({ playerRanks: ['10', '6'], dealerRank: '10', availableActions: ['hit', 'stand'] });
  const local = getBlackjackStrategyAdvice(context);
  mockGenerateAiJson.mockResolvedValue({ ok: false, code: 'timeout', message: 'AI request timed out' });
  expect(await getBlackjackAdvice(context, AI_SETTINGS)).toEqual(local);
});
```

Keep/add stand, double-down, split, and unavailable-preferred-action fixtures.

- [ ] **Step 2: Remove `useLLM` from Blackjack settings and its E2E contract**

Delete `useLLM` from `BlackjackSettings`, `DEFAULT_SETTINGS`, GameSettingsManager read/write/update paths, Blackjack settings markup/client wiring, and related tests.

Replace the current E2E gate test with:

```ts
test('Ask AI works with default Blackjack settings', async ({ browser, baseURL }) => {
  const { context, page } = await createIsolatedBlackjackPage(browser, baseURL);
  try {
    await dealHand(page, 50);
    const aiButton = page.getByRole('button', { name: 'Ask AI Rival' });
    await expect(aiButton).toBeEnabled();
    await aiButton.click();
    await expect(page.locator('#ai-advice-action')).toContainText('Recommended:');
  } finally {
    await context.close();
  }
});
```

- [ ] **Step 3: Export the current basic fallback as authoritative local strategy**

Implement `getBlackjackStrategyAdvice()` by promoting the existing `getBasicStrategyAdvice()` logic. Preserve the current hit/stand/double/split rules, then enforce legality with:

```ts
const legalActions = availableActions.filter((action) => action !== 'ask-ai');
if (!legalActions.includes(recommendedAction)) {
  recommendedAction = legalActions.includes('hit')
    ? 'hit'
    : legalActions.includes('stand')
      ? 'stand'
      : legalActions[0];
}
```

Return `confidence: 1` and the deterministic reasoning.

- [ ] **Step 4: Make provider output reasoning-only**

```ts
export async function getBlackjackAdvice(
  context: BlackjackAdviceContext,
  settings: AiSettings | null,
): Promise<BlackjackAdvice> {
  const deterministic = getBlackjackStrategyAdvice(context);
  if (!settings || !deterministic.recommendedAction) return deterministic;
  const result = await generateAiJson(settings, {
    system: 'Explain the already-selected Blackjack move. Do not choose another move.',
    prompt: `Move: ${deterministic.recommendedAction}\nBase explanation: ${deterministic.reasoning}\nReturn {"reasoning":"one concise explanation"}.`,
    temperature: 0.3,
    maxOutputTokens: 120,
  });
  if (!result.ok) return deterministic;
  const reasoning = result.value.reasoning;
  return typeof reasoning === 'string' && reasoning.trim()
    ? { ...deterministic, reasoning: reasoning.trim(), raw: JSON.stringify(result.value) }
    : deterministic;
}
```

Delete private Blackjack provider functions/action parser and `getRoundCommentary()`. Remove its export from `src/lib/blackjack/index.ts`.

- [ ] **Step 5: Remove guest/settings gating from the click path and delete commentary/overlay DOM**

Delete `llmUserEnabled`, `llmConfigured`, `llmSettingsLoading`, `loadLlmSettings()`, guest button disabling, the “AI Rival is disabled” branch, configuration overlay, and post-round commentary code.

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

Guests always receive local advice and never call a provider.

- [ ] **Step 6: Add client tests and verify**

```ts
test('guest Ask AI does not call provider', async () => {
  setGuestMode(true);
  mockLoadAiSettings.mockReturnValue({ provider: 'openai', model: 'gpt-4o', apiKey: 'stale-key' });
  initBlackjackClient();
  await reachPlayerTurn();
  clickAskAi();
  expect(mockGenerateAiJson).not.toHaveBeenCalled();
});

test('round completion does not call provider', async () => {
  initBlackjackClient();
  await finishOneRound();
  expect(mockGenerateAiJson).not.toHaveBeenCalled();
});
```

Run: `bun test src/lib/blackjack && bunx playwright test e2e/blackjack-settings.spec.ts`

Expected: PASS.

```bash
git add src/lib/blackjack src/pages/games/blackjack.astro e2e/blackjack-settings.spec.ts
git commit -m "feat: make blackjack advice always local-first"
```

---

### Task 4: Move Craps advice off the server proxy

**Files:**
- Modify: `src/lib/craps/llmCrapsStrategy.ts`
- Modify: `src/pages/games/craps.astro`
- Rewrite: `src/lib/craps/craps-advice.test.ts`
- Delete: `src/pages/api/craps-advice.ts`
- Delete: `src/lib/craps/craps-advice-validation.test.ts`

**Interfaces:**
- Consumes: `AiSettings`, `generateAiJson()`, `loadAiSettings()`.
- Produces: existing `getCrapsAdvice()` with pure bet aggregation and no Astro advice route.

- [ ] **Step 1: Move `aggregateBets()` into Craps strategy and preserve its existing pure tests**

Keep the same grouping rule: same bet type + point combine `amount` and `odds`; different points/types remain separate. Remove route auth/DB/body-hardening tests because the route is deleted.

- [ ] **Step 2: Replace Craps provider calls with shared JSON client**

```ts
export async function getCrapsAdvice(ctx: CrapsAdviceContext, settings: AiSettings): Promise<CrapsAdvice> {
  const normalized = { ...ctx, activeBets: aggregateBets(ctx.activeBets) };
  const result = await generateAiJson(settings, {
    system: buildSystemPrompt(),
    prompt: buildPrompt(normalized),
    temperature: 0.8,
    maxOutputTokens: 250,
  });
  if (!result.ok) throw new Error(result.message);
  return parsePayload(result.value);
}
```

Delete Craps-local provider functions, `LLMSettings`, and the 8-second timeout.

- [ ] **Step 3: Call the strategy directly from `craps.astro`, then delete the route**

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
  try {
    const advice = await getCrapsAdvice({
      phase: state.phase,
      point: state.point,
      activeBets: state.activeBets,
      rollHistory: state.rollHistory,
      chipBalance: state.chipBalance,
    }, settings);
    llmAdviceEl.textContent = advice.advice;
  } catch {
    llmAdviceEl.textContent = 'AI advice is unavailable. You can keep playing normally.';
  }
});
```

Delete `src/pages/api/craps-advice.ts` and `src/lib/craps/craps-advice-validation.test.ts` after this caller change in the same task.

- [ ] **Step 4: Verify and commit**

Run:

```bash
bun test src/lib/craps
rg "/api/craps-advice|getLlmSettings" src/lib/craps src/pages/games/craps.astro
bun run build
```

Expected: tests/build PASS; scan has zero matches.

```bash
git add src/lib/craps src/pages/games/craps.astro
git add -u src/pages/api/craps-advice.ts
git commit -m "refactor: call craps AI from browser"
```

---

### Task 5: Migrate Baccarat and both Poker AI paths

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
- Produces: existing `BaccaratAdvice`, `AIDecision`, and `AiMove` contracts with one provider transport.

- [ ] **Step 1: Add failing shared-client seam tests**

```ts
mockGenerateAiJson.mockResolvedValue({
  ok: true,
  value: { advice: 'Banker has the lowest standard house edge.', suggestedBets: ['banker'], confidence: 'high' },
});
expect((await getBaccaratAdvice(context, AI_SETTINGS)).suggestedBets).toEqual(['banker']);
```

```ts
mockGenerateAiJson.mockResolvedValue({
  ok: false,
  code: 'provider-error',
  message: 'Provider request failed (500)',
});
const decision = await makeLLMDecision(context, 'tight-aggressive', AI_SETTINGS);
expect(['fold', 'check', 'call', 'raise']).toContain(decision.action);
expect(decision.reasoning).toContain('fallback');
```

- [ ] **Step 2: Migrate Baccarat transport only**

Keep Baccarat prompt/payload validation; replace private provider calls with:

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

Do not add Baccarat UI.

- [ ] **Step 3: Migrate Poker LLM opponents without changing `DecisionCache`**

```ts
const result = await generateAiJson(llmSettings, {
  system: 'You are an expert poker AI. Respond only with valid JSON.',
  prompt: buildLLMPrompt(context, personality),
  temperature: 0.7,
  maxOutputTokens: 100,
});
if (!result.ok) return ruleBasedFallback(context, personality, difficulty, 'LLM error fallback');
const decision = parseLLMPayload(result.value, context);
if (!decision) return ruleBasedFallback(context, personality, difficulty, 'LLM parse failed');
decisionCache.set(context, decision);
return decision;
```

Keep cache key/TTL/clear behavior unchanged.

- [ ] **Step 4: Migrate Poker AI Rival and PokerGame settings lookup**

```ts
// AIRivalAssistant.ts
private hydrateFromLocalSettings(): void {
  this.aiSettings = loadAiSettings();
  this.setButtonState({ disabled: !this.aiSettings });
  this.updateStatus();
}
```

Use `generateAiJson()` in AIRivalAssistant but keep `parseAiMove()` and highlighting local. Replace PokerGame’s profile-settings fetch with `loadAiSettings()`. Keep guests provider-disabled/rule-based.

- [ ] **Step 5: Verify and commit**

Run:

```bash
bun test src/lib/baccarat/llmBaccaratStrategy.test.ts src/lib/poker/llmAIStrategy.test.ts src/lib/poker/AIRivalAssistant.test.ts src/lib/poker/PokerGame.test.ts
rg "api.openai.com|generativelanguage.googleapis.com" src/lib src/pages
```

Expected: tests PASS; provider URLs only in `src/lib/ai/client.ts`.

```bash
git add src/lib/baccarat src/lib/poker
git commit -m "refactor: share AI provider transport"
```

---

### Task 6: Delete legacy D1/profile AI storage with a forward migration

**Files:**
- Modify: `src/db/schema.ts`
- Create: `drizzle/0017_drop_llm_settings.sql` with Drizzle Kit.
- Delete: `src/lib/llm-settings.ts`
- Delete: `src/lib/llm-settings.test.ts`
- Delete: `src/lib/profile-api.ts`
- Delete: `src/pages/api/profile/llm-settings.ts`
- Delete: `src/pages/api/profile/reveal-api-key.ts`
- Preserve: historical `drizzle/0000_powerful_wrecking_crew.sql` and `drizzle/0002_jittery_firebrand.ts`.

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: no active D1 AI credential repository/API/table.

- [ ] **Step 1: Prove remaining legacy API matches are implementation files only**

Run:

```bash
rg "/api/profile/llm-settings|/api/profile/reveal-api-key|getLlmSettings|upsertLlmSettings" src integration e2e
```

Expected: no Profile/Blackjack/Poker/Craps caller remains. Matches may exist only in the legacy helper/routes/tests deleted below.

- [ ] **Step 2: Remove `llmSettings` from `src/db/schema.ts` and generate the drop migration**

Delete the `llmSettings` table declaration, then run:

```bash
bunx drizzle-kit generate --name=drop_llm_settings
cat drizzle/0017_drop_llm_settings.sql
```

Expected: `drizzle/0017_drop_llm_settings.sql` removes `llm_settings` and contains no unrelated schema changes. Keep any metadata files generated by Drizzle Kit unedited.

- [ ] **Step 3: Delete the dead repository/API files**

```bash
rm src/lib/llm-settings.ts \
   src/lib/llm-settings.test.ts \
   src/lib/profile-api.ts \
   src/pages/api/profile/llm-settings.ts \
   src/pages/api/profile/reveal-api-key.ts
```

Do not edit or delete historical migration files.

- [ ] **Step 4: Verify active references are gone while migration history is allowed to mention the table**

Run:

```bash
rg "llm-settings|reveal-api-key|getLlmSettings|upsertLlmSettings" src integration e2e
rg "llm_settings" src
rg "llm_settings" drizzle
```

Expected: first two scans have zero matches. The `drizzle` scan may show historical creation plus `0017_drop_llm_settings.sql`.

- [ ] **Step 5: Run tests/build and commit**

Run: `bun run test && bun run build`

Expected: PASS.

```bash
git add src/db/schema.ts drizzle
git add -u src/lib/llm-settings.ts src/lib/llm-settings.test.ts src/lib/profile-api.ts src/pages/api/profile/llm-settings.ts src/pages/api/profile/reveal-api-key.ts
git commit -m "refactor: remove server AI credential storage"
```

---

### Task 7: Replace browser contracts and run full verification

**Files:**
- Modify: `e2e/blackjack-llm.spec.ts`
- Modify: `e2e/profile.spec.ts`
- Modify: `e2e/public-single-player-games.spec.ts` if it still contains a deleted settings-endpoint interception.

**Interfaces:**
- Consumes: Tasks 1-6.
- Produces: browser proof that Blackjack is local-first, provider calls are explicit-only, Profile is browser-local, and no legacy runtime path remains.

- [ ] **Step 1: Remove the old helper that enables `useLLM`**

```ts
async function gotoBlackjack(page: Page) {
  await page.goto('/games/blackjack', { waitUntil: 'networkidle' });
}
```

Delete the old settings-toggle steps from `gotoBlackjack()`.

- [ ] **Step 2: Cover authenticated no-provider advice**

```ts
test('no provider still receives local Blackjack advice', async ({ browser, baseURL }) => {
  const { context, page } = await createIsolatedBlackjackPage(browser, baseURL);
  try {
    await page.addInitScript(() => localStorage.removeItem('arcturus-ai-settings'));
    const providerRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('api.openai.com') || request.url().includes('generativelanguage.googleapis.com')) {
        providerRequests.push(request.url());
      }
    });
    await gotoBlackjack(page);
    await dealHand(page, 50);
    await page.getByRole('button', { name: 'Ask AI Rival' }).click();
    await expect(page.locator('#ai-advice-action')).toContainText('Recommended:');
    await expect(page.locator('#ai-advice-reasoning')).not.toBeEmpty();
    expect(providerRequests).toEqual([]);
  } finally {
    await context.close();
  }
});
```

- [ ] **Step 3: Cover guest local advice explicitly**

```ts
test('guest receives local advice and never calls provider', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('arcturus-ai-settings', JSON.stringify({
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: 'stale-key',
  })));
  const providerRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('api.openai.com') || request.url().includes('generativelanguage.googleapis.com')) {
      providerRequests.push(request.url());
    }
  });
  await gotoBlackjack(page);
  await dealHand(page, 50);
  const aiButton = page.getByRole('button', { name: 'Ask AI Rival' });
  await expect(aiButton).toBeEnabled();
  await aiButton.click();
  await expect(page.locator('#ai-advice-action')).toContainText('Recommended:');
  expect(providerRequests).toEqual([]);
});
```

This uses the default unauthenticated Playwright page instead of inventing a guest helper.

- [ ] **Step 4: Cover configured explicit-only provider use and failure fallback**

```ts
await page.addInitScript(() => localStorage.setItem('arcturus-ai-settings', JSON.stringify({
  provider: 'openai',
  model: 'gpt-4o',
  apiKey: 'sk-fake',
})));
let calls = 0;
await page.route('https://api.openai.com/**', async (route) => {
  calls += 1;
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ choices: [{ message: { content: '{"reasoning":"Local strategy explained."}' } }] }),
  });
});
await gotoBlackjack(page);
await dealHand(page, 50);
expect(calls).toBe(0);
await page.getByRole('button', { name: 'Ask AI Rival' }).click();
await expect.poll(() => calls).toBe(1);
await page.getByRole('button', { name: 'Stand' }).click();
await expect(page.getByRole('button', { name: 'New Round' })).toBeVisible({ timeout: 15_000 });
expect(calls).toBe(1);
```

Change the current provider-failure test to assert deterministic recommendation/reasoning stays visible. Delete the post-round commentary E2E.

- [ ] **Step 5: Run architecture scans**

```bash
rg "api.openai.com|generativelanguage.googleapis.com" src/lib src/pages
rg "/api/profile/llm-settings|/api/profile/reveal-api-key|/api/craps-advice" src integration e2e
rg "getRoundCommentary|useLLM" src/lib/blackjack src/pages/games/blackjack.astro e2e/blackjack-*.spec.ts
```

Expected: provider URLs only in `src/lib/ai/client.ts`; other scans have zero active matches.

- [ ] **Step 6: Run full code-quality gates**

Run:

```bash
bun run test
bun run lint
bun run format:check
bun run build
```

Expected: PASS.

- [ ] **Step 7: Run representative E2E gates**

Run:

```bash
bunx playwright test \
  e2e/blackjack-settings.spec.ts \
  e2e/blackjack-llm.spec.ts \
  e2e/profile.spec.ts \
  e2e/craps.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Review the final diff and leave verification clean**

```bash
git diff --stat main...HEAD
git diff main...HEAD -- src/lib/ai src/lib/blackjack src/lib/craps src/lib/baccarat src/lib/poker src/pages/profile.astro src/db/schema.ts drizzle/0017_drop_llm_settings.sql
git status --short
```

Verify: one provider transport; one local settings record; one validator source; no Blackjack enable/guest-local gate; no automatic Blackjack provider request; no legacy runtime credential API/repository; no compatibility/provider framework; historical migrations unchanged.

Expected final `git status --short`: empty. If verification exposes a defect, return to the task that owns that behavior, fix it there, rerun that task’s focused checks, and commit it with that task rather than creating a generic catch-all commit.
