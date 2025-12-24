/**
 * AIRivalAssistant - Handles the "Ask AI Rival" feature
 * Provides AI-powered move suggestions using OpenAI or Gemini APIs
 */

import type { Card, Player, Suit } from './types';
import { getCallAmount, getHighestBet } from './index';

export type AiProvider = 'openai' | 'gemini';
export type AiSettings = {
	provider: AiProvider;
	model: string;
	openaiApiKey: string | null;
	geminiApiKey: string | null;
};
export type AiMoveType = 'fold' | 'check' | 'call' | 'raise';
export type AiMove = {
	move: AiMoveType;
	amount?: number | null;
	raw: string;
};

export class AIRivalAssistant {
	private aiSettings: AiSettings | null = null;

	constructor() {
		this.loadAiSettings();
	}

	// Small helper to avoid DOM access crashes in non-browser environments
	private getElementById(id: string): HTMLElement | null {
		if (typeof document === 'undefined' || typeof document.getElementById !== 'function') {
			return null;
		}
		return document.getElementById(id);
	}

	// === UI State Management ===

	public setButtonState(options: { loading?: boolean; disabled?: boolean } = {}) {
		const button = this.getElementById('btn-ai-move');
		const htmlButton =
			typeof HTMLButtonElement !== 'undefined' && button instanceof HTMLButtonElement
				? button
				: button && (button as Element).nodeType === 1 && (button as Element).tagName === 'BUTTON'
					? (button as HTMLButtonElement)
					: null;
		if (!htmlButton) {
			return;
		}

		if (!htmlButton.dataset.originalLabel) {
			htmlButton.dataset.originalLabel = htmlButton.textContent ?? 'Ask AI Rival';
		}

		if (typeof options.disabled === 'boolean') {
			htmlButton.disabled = options.disabled;
		}

		if (options.loading) {
			htmlButton.textContent = 'Thinking…';
			htmlButton.classList.add('animate-pulse');
		} else {
			htmlButton.textContent = htmlButton.dataset.originalLabel ?? 'Ask AI Rival';
			htmlButton.classList.remove('animate-pulse');
		}
	}

	public updateStatus(message?: string, tone: 'neutral' | 'success' | 'error' = 'neutral') {
		const statusEl = this.getElementById('ai-rival-status');
		if (!statusEl) return;

		let text = message;
		let resolvedTone = tone;

		if (!text) {
			if (!this.aiSettings) {
				text = 'AI rival not configured.';
				resolvedTone = 'error';
			} else {
				const providerLabel =
					this.aiSettings.provider === 'openai'
						? 'OpenAI GPT-4o'
						: `Gemini ${this.aiSettings.model}`;
				const hasKey = Boolean(this.getAiKey(this.aiSettings));
				if (hasKey) {
					text = `Ready with ${providerLabel}`;
					resolvedTone = 'success';
				} else {
					text = `Missing ${this.aiSettings.provider === 'openai' ? 'OpenAI' : 'Gemini'} API key`;
					resolvedTone = 'error';
				}
			}
		}

		statusEl.textContent = text;
		statusEl.classList.remove('text-slate-300', 'text-emerald-400', 'text-rose-400');

		if (resolvedTone === 'success') {
			statusEl.classList.add('text-emerald-400');
		} else if (resolvedTone === 'error') {
			statusEl.classList.add('text-rose-400');
		} else {
			statusEl.classList.add('text-slate-300');
		}
	}

	// === Settings Management ===

	private getAiKey(settings: AiSettings | null): string | null {
		if (!settings) return null;
		if (settings.provider === 'openai') {
			return settings.openaiApiKey ?? null;
		}
		if (settings.provider === 'gemini') {
			return settings.geminiApiKey ?? null;
		}
		return null;
	}

	private async loadAiSettings() {
		this.updateStatus('Loading rival settings…', 'neutral');
		try {
			const response = await fetch('/api/profile/llm-settings');
			if (!response.ok) {
				throw new Error(`Unexpected status ${response.status}`);
			}
			const data = (await response.json()) as { settings?: AiSettings | null };
			const settings = data?.settings;
			if (
				settings &&
				(settings.provider === 'openai' || settings.provider === 'gemini') &&
				typeof settings.model === 'string'
			) {
				this.aiSettings = {
					provider: settings.provider,
					model: settings.model,
					openaiApiKey: typeof settings.openaiApiKey === 'string' ? settings.openaiApiKey : null,
					geminiApiKey: typeof settings.geminiApiKey === 'string' ? settings.geminiApiKey : null,
				};
				const hasKey = Boolean(this.getAiKey(this.aiSettings));
				this.setButtonState({ disabled: !hasKey });
				this.updateStatus();
			} else {
				this.aiSettings = null;
				this.setButtonState({ disabled: true });
				this.updateStatus('No AI rival settings stored yet.', 'error');
			}
		} catch (error) {
			console.error('Failed to load AI rival settings:', error);
			this.aiSettings = null;
			this.setButtonState({ disabled: true });
			this.updateStatus('Unable to load rival settings.', 'error');
		}
	}

	// === Prompt Building ===

	private getSuitSymbol(suit: Suit): string {
		const symbols = {
			hearts: '♥',
			diamonds: '♦',
			clubs: '♣',
			spades: '♠',
		};
		return symbols[suit];
	}

	private formatCard(card: Card) {
		return `${card.value}${this.getSuitSymbol(card.suit)}`;
	}

	private formatCards(cards: Card[]) {
		return cards.length ? cards.map((card) => this.formatCard(card)).join(', ') : 'None';
	}

	private buildPrompt(
		gamePhase: string,
		humanPlayer: Player,
		communityCards: Card[],
		pot: number,
		players: Player[],
	) {
		const phaseLabel = gamePhase.toUpperCase();
		const playerCards = this.formatCards(humanPlayer?.hand || []);
		const communityCardsStr = communityCards.length
			? this.formatCards(communityCards)
			: 'Not revealed yet';

		const highestBet = getHighestBet(players);
		const callAmount = getCallAmount(humanPlayer, highestBet);

		return `You are an AI poker rival advising the user on Texas Hold'em strategy.
Game phase: ${phaseLabel}
Player hole cards: ${playerCards}
Community cards: ${communityCardsStr}
Pot size: $${pot}
Current bet to match: $${callAmount}

Respond with a JSON object describing your recommended move.
Use the shape {"move":"fold|check|call|raise","amount":number?}. Amount is required only for raises.
Keep the JSON as the only output.`;
	}

	// === API Calls ===

	private async callOpenAi(prompt: string, model: string, apiKey: string) {
		const response = await fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages: [
					{
						role: 'system',
						content:
							'You are an elite poker rival helping determine the next move. Answer in JSON only.',
					},
					{ role: 'user', content: prompt },
				],
				temperature: 0.6,
			}),
		});

		const data = (await response.json()) as {
			error?: { message?: string };
			choices?: Array<{ message?: { content?: string } }>;
		};
		if (!response.ok) {
			const message =
				typeof data?.error?.message === 'string'
					? data.error.message
					: `OpenAI request failed with status ${response.status}`;
			throw new Error(message);
		}

		return data?.choices?.[0]?.message?.content ?? JSON.stringify({ move: 'check', amount: null });
	}

	private async callGemini(prompt: string, model: string, apiKey: string) {
		const response = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					generationConfig: {
						temperature: 0.6,
					},
					contents: [
						{
							role: 'user',
							parts: [
								{
									text: `You are an elite poker rival helping determine the next move. Answer in JSON only.\n${prompt}`,
								},
							],
						},
					],
				}),
			},
		);

		const data = (await response.json()) as {
			error?: { message?: string } | string;
			candidates?: Array<{
				content?: { parts?: Array<{ text?: string }> };
			}>;
		};
		if (!response.ok) {
			const message =
				typeof data?.error === 'string'
					? data.error
					: (data?.error?.message ?? `Gemini request failed with status ${response.status}`);
			throw new Error(message ?? 'Unknown Gemini error');
		}

		const text = data?.candidates?.[0]?.content?.parts
			?.map((part: { text?: string }) => part.text ?? '')
			.join('')
			.trim();

		return text || JSON.stringify({ move: 'check', amount: null });
	}

	// === Response Parsing ===

	private parseAiMove(raw: string): AiMove {
		const source = typeof raw === 'string' ? raw.trim() : '';
		let payload = source;

		const jsonMatch = source.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			payload = jsonMatch[0];
		}

		let parsed: Record<string, unknown> | null = null;

		try {
			parsed = JSON.parse(payload);
		} catch (_error) {
			// ignore parse error and fallback to heuristics
		}

		let move: AiMoveType | null = null;
		let amount: number | null = null;

		if (parsed && typeof parsed === 'object') {
			const rawMove = parsed.move;
			if (typeof rawMove === 'string') {
				const normalized = rawMove.toLowerCase();
				if (
					normalized === 'fold' ||
					normalized === 'check' ||
					normalized === 'call' ||
					normalized === 'raise'
				) {
					move = normalized;
				}
			}

			const rawAmount = parsed.amount;
			if (rawAmount !== undefined && rawAmount !== null) {
				const attempt = Number(rawAmount);
				if (!Number.isNaN(attempt)) {
					amount = attempt;
				}
			}
		}

		if (!move) {
			if (/fold/i.test(source)) move = 'fold';
			else if (/check/i.test(source)) move = 'check';
			else if (/call/i.test(source)) move = 'call';
			else if (/raise/i.test(source)) move = 'raise';
			else move = 'check';
		}

		if (move === 'raise' && (amount === null || Number.isNaN(amount))) {
			const amountMatch = source.match(/(\d{2,4})/);
			if (amountMatch) {
				amount = Number(amountMatch[1]);
			}
		}

		return {
			move,
			amount: Number.isFinite(amount) ? amount : null,
			raw: source,
		};
	}

	private clampRaise(amount: number | null | undefined) {
		if (amount === null || amount === undefined || Number.isNaN(amount)) {
			return null;
		}
		const clamped = Math.max(10, Math.min(Math.round(amount), 1000));
		return clamped;
	}

	// === UI Application ===

	public highlightSuggestedMove(move: AiMoveType | null) {
		const buttonMap: Record<AiMoveType, string> = {
			fold: 'btn-fold',
			check: 'btn-check',
			call: 'btn-call',
			raise: 'btn-raise',
		};

		(Object.keys(buttonMap) as AiMoveType[]).forEach((key) => {
			const el = this.getElementById(buttonMap[key]);
			if (!(typeof HTMLButtonElement !== 'undefined' && el instanceof HTMLButtonElement)) return;
			el.classList.remove('ring-2', 'ring-offset-2', 'ring-yellow-400');
			if (move && key === move) {
				el.classList.add('ring-2', 'ring-offset-2', 'ring-yellow-400');
			}
		});
	}

	private applyAiMove(move: AiMove, updateGameStatusCallback: (message: string) => void) {
		this.highlightSuggestedMove(move.move);

		let description = '';
		if (move.move === 'fold') {
			description = 'fold';
		} else if (move.move === 'check') {
			description = 'check';
		} else if (move.move === 'call') {
			description = 'call';
		} else if (move.move === 'raise') {
			const raise = this.clampRaise(move.amount);
			if (raise !== null) {
				const slider = this.getElementById('bet-slider');
				const betLabel = this.getElementById('bet-amount');
				if (typeof HTMLInputElement !== 'undefined' && slider instanceof HTMLInputElement) {
					slider.value = String(raise);
				}
				if (betLabel) {
					betLabel.textContent = `$${raise}`;
				}
				description = `raise $${raise}`;
			} else {
				description = 'raise';
			}
		}

		this.updateStatus(`Suggested move: ${description.toUpperCase()}`, 'success');
		updateGameStatusCallback(`AI rival recommends you ${description || move.move}.`);
	}

	// === Public API ===

	public async requestAiMove(
		gamePhase: string,
		humanPlayer: Player,
		communityCards: Card[],
		pot: number,
		players: Player[],
		updateGameStatusCallback: (message: string) => void,
	) {
		const settings = this.aiSettings;
		const apiKey = this.getAiKey(settings);
		if (!settings || !apiKey) {
			this.updateStatus('AI rival not ready. Check your profile settings.', 'error');
			this.setButtonState({ disabled: true });
			return;
		}

		this.setButtonState({ loading: true, disabled: true });
		this.updateStatus('Consulting the rival…', 'neutral');

		try {
			const prompt = this.buildPrompt(gamePhase, humanPlayer, communityCards, pot, players);
			let rawResponse = '';

			if (settings.provider === 'openai') {
				rawResponse = await this.callOpenAi(prompt, settings.model, apiKey);
			} else {
				rawResponse = await this.callGemini(prompt, settings.model, apiKey);
			}

			const move = this.parseAiMove(rawResponse);
			this.applyAiMove(move, updateGameStatusCallback);

			const stillHasKey = Boolean(this.getAiKey(this.aiSettings));
			this.setButtonState({ loading: false, disabled: !stillHasKey });
		} catch (error) {
			console.error('AI rival failed to respond:', error);
			this.updateStatus('Rival could not decide. Try again.', 'error');
			const stillHasKey = Boolean(this.getAiKey(this.aiSettings));
			this.setButtonState({ loading: false, disabled: !stillHasKey });
		}
	}
}
