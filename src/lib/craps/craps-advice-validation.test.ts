import { describe, expect, test } from 'bun:test';
import { createPostHandler } from '../../pages/api/craps-advice';

function createLocals() {
	return {
		session: { user: { id: 'user-1' } },
		runtime: { env: { DB: { binding: true } } },
	};
}

function createValidAdvicePayload(overrides: Record<string, unknown> = {}) {
	return {
		phase: 'come-out',
		point: null,
		chipBalance: 1000,
		activeBets: [{ id: 'bet-1', type: 'passLine', amount: 25 }],
		rollHistory: [{ die1: 3, die2: 4, total: 7 }],
		query: 'What should I do next?',
		...overrides,
	};
}

async function readJson(response: Response) {
	return JSON.parse(await response.text());
}

describe('craps advice API route validation branches', () => {
	const POST = createPostHandler({
		createDb: (() => ({ db: true })) as any,
		getLlmSettings: (async () => ({
			provider: 'openai',
			model: 'gpt-4o',
			openaiApiKey: 'key',
			geminiApiKey: null,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		})) as any,
		getCrapsAdvice: (async () => ({
			advice: 'test advice',
			suggestedBets: ['passLine'],
			confidence: 'medium',
			raw: 'raw',
		})) as any,
	});

	test('rejects active bets with invalid point value', async () => {
		const response = await POST({
			locals: createLocals(),
			request: new Request('http://test.local', {
				method: 'POST',
				body: JSON.stringify(
					createValidAdvicePayload({
						activeBets: [{ id: 'bet-point', type: 'come', amount: 10, point: 7 }],
					}),
				),
			}),
		} as any);

		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('Invalid advice context');
	});

	test('rejects active bets with invalid odds value', async () => {
		const response = await POST({
			locals: createLocals(),
			request: new Request('http://test.local', {
				method: 'POST',
				body: JSON.stringify(
					createValidAdvicePayload({
						activeBets: [{ id: 'bet-odds', type: 'come', amount: 10, point: 6, odds: -1 }],
					}),
				),
			}),
		} as any);

		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('Invalid advice context');
	});

	test('rejects roll history entries with non-numeric fields', async () => {
		const response = await POST({
			locals: createLocals(),
			request: new Request('http://test.local', {
				method: 'POST',
				body: JSON.stringify(
					createValidAdvicePayload({
						rollHistory: [{ die1: '1', die2: 2, total: 3 }],
					}),
				),
			}),
		} as any);

		const body = await readJson(response);
		expect(response.status).toBe(400);
		expect(body.error).toBe('Invalid advice context');
	});
});
