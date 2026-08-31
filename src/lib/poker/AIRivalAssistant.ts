/**
 * AIRivalAssistant - Handles the "Ask AI Rival" feature
 * Provides AI-powered move suggestions using OpenAI or Gemini APIs
 */

import type { Card, Player } from './types';
import { getCallAmount, getHighestBet } from './index';
import { getSuitSymbol } from '../card-format';
import { generateAiJson, loadAiSettings, type AiSettings } from '../ai';
import { isGuestModeValue } from '../public-game-session';
import { getDocumentLocale, type Locale } from '../i18n/locale';
import { formatChips } from '../i18n/messages/common';
import { getPokerLanguageName, pokerTranslator } from '../i18n/messages/poker';

export type AiMoveType = 'fold' | 'check' | 'call' | 'raise';
export type AiMove = {
	move: AiMoveType;
	amount?: number | null;
	raw: string;
};

export class AIRivalAssistant {
	private aiSettings: AiSettings | null = null;
	private readonly locale: Locale;
	private readonly t: ReturnType<typeof pokerTranslator>;

	constructor() {
		// AppLayout writes data-locale on <html>; the assistant reads it so the
		// browser and SSR share one locale handoff for advice copy.
		this.locale = getDocumentLocale();
		this.t = pokerTranslator(this.locale);
		if (this.isGuestMode()) {
			this.setButtonState({ disabled: true });
			this.updateStatus(this.t('aiRivalGuestStatus'), 'neutral');
			return;
		}
		this.hydrateFromLocalSettings();
	}

	// Small helper to avoid DOM access crashes in non-browser environments
	private getElementById(id: string): HTMLElement | null {
		if (typeof document === 'undefined' || typeof document.getElementById !== 'function') {
			return null;
		}
		return document.getElementById(id);
	}

	private isGuestMode(): boolean {
		const rootEl = this.getElementById('poker-root');
		const balanceEl = this.getElementById('player-balance');
		return (
			isGuestModeValue(rootEl?.dataset.guestMode) || isGuestModeValue(balanceEl?.dataset.guestMode)
		);
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
			htmlButton.dataset.originalLabel = htmlButton.textContent ?? this.t('askAiRival');
		}

		if (typeof options.disabled === 'boolean') {
			htmlButton.disabled = options.disabled;
		}

		if (options.loading) {
			htmlButton.textContent = this.t('aiRivalThinking');
			htmlButton.classList.add('animate-pulse');
		} else {
			htmlButton.textContent = htmlButton.dataset.originalLabel ?? this.t('askAiRival');
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
				text = this.t('aiRivalNotConfigured');
				resolvedTone = 'error';
			} else {
				const providerLabel =
					this.aiSettings.provider === 'openai'
						? 'OpenAI GPT-4o'
						: `Gemini ${this.aiSettings.model}`;
				const hasKey = Boolean(this.getAiKey(this.aiSettings));
				if (hasKey) {
					text = this.t('aiRivalReady', { provider: providerLabel });
					resolvedTone = 'success';
				} else {
					text = this.t('aiRivalMissingKey', {
						provider: this.aiSettings.provider === 'openai' ? 'OpenAI' : 'Gemini',
					});
					resolvedTone = 'error';
				}
			}
		}

		statusEl.textContent = text;
		statusEl.classList.remove(
			'text-[var(--deco-ivory-dim)]',
			'text-[var(--deco-jade)]',
			'text-[var(--deco-oxblood-bright)]',
		);

		if (resolvedTone === 'success') {
			statusEl.classList.add('text-[var(--deco-jade)]');
		} else if (resolvedTone === 'error') {
			statusEl.classList.add('text-[var(--deco-oxblood-bright)]');
		} else {
			statusEl.classList.add('text-[var(--deco-ivory-dim)]');
		}
	}

	// === Settings Management ===

	private getAiKey(settings: AiSettings | null): string | null {
		return settings?.apiKey?.trim() || null;
	}

	private hydrateFromLocalSettings(): void {
		this.aiSettings = loadAiSettings();
		this.setButtonState({ disabled: !this.aiSettings });
		this.updateStatus();
	}

	// === Prompt Building ===

	private formatCard(card: Card) {
		return `${card.value}${getSuitSymbol(card.suit)}`;
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

Respond in ${getPokerLanguageName(this.locale)}. Respond with a JSON object describing your recommended move.
Use the shape {"move":"fold|check|call|raise","amount":number?}. Amount is required only for raises.
Keep the JSON as the only output.`;
	}

	// === Response Parsing ===

	private parseAiMove(payload: Record<string, unknown>): AiMove {
		let move: AiMoveType | null = null;
		let amount: number | null = null;

		const rawMove = payload.move;
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

		const rawAmount = payload.amount;
		if (rawAmount !== undefined && rawAmount !== null) {
			const attempt = Number(rawAmount);
			if (Number.isFinite(attempt)) {
				amount = attempt;
			}
		}

		const validatedMove = move ?? 'check';

		return {
			move: validatedMove,
			amount: Number.isFinite(amount) ? amount : null,
			raw: JSON.stringify(payload),
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
			el.classList.remove('ring-2', 'ring-offset-2', 'ring-[var(--deco-brass-bright)]');
			if (move && key === move) {
				el.classList.add('ring-2', 'ring-offset-2', 'ring-[var(--deco-brass-bright)]');
			}
		});
	}

	private applyAiMove(move: AiMove, updateGameStatusCallback: (message: string) => void) {
		this.highlightSuggestedMove(move.move);

		let description = '';
		if (move.move === 'fold') {
			description = this.t('aiMoveFold');
		} else if (move.move === 'check') {
			description = this.t('aiMoveCheck');
		} else if (move.move === 'call') {
			description = this.t('aiMoveCall');
		} else if (move.move === 'raise') {
			const raise = this.clampRaise(move.amount);
			if (raise !== null) {
				const slider = this.getElementById('bet-slider');
				const betLabel = this.getElementById('bet-amount');
				if (typeof HTMLInputElement !== 'undefined' && slider instanceof HTMLInputElement) {
					slider.value = String(raise);
				}
				if (betLabel) {
					betLabel.textContent = formatChips(raise, this.locale);
				}
				description = this.t('aiMoveRaiseAmount', { amount: formatChips(raise, this.locale) });
			} else {
				description = this.t('aiMoveRaise');
			}
		}

		this.updateStatus(this.t('aiRivalSuggested', { move: description }), 'success');
		updateGameStatusCallback(this.t('aiRivalRecommends', { move: description }));
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
			this.updateStatus(this.t('aiRivalNotReady'), 'error');
			this.setButtonState({ disabled: true });
			return;
		}

		this.setButtonState({ loading: true, disabled: true });
		this.updateStatus(this.t('aiRivalConsulting'), 'neutral');

		try {
			const prompt = this.buildPrompt(gamePhase, humanPlayer, communityCards, pot, players);
			const result = await generateAiJson(settings, {
				system:
					'You are an elite poker rival helping determine the next move. Answer in JSON only.',
				prompt,
				temperature: 0.6,
				maxOutputTokens: 200,
			});
			if (!result.ok) throw new Error(result.message);

			const move = this.parseAiMove(result.value);
			this.applyAiMove(move, updateGameStatusCallback);

			const stillHasKey = Boolean(this.getAiKey(this.aiSettings));
			this.setButtonState({ loading: false, disabled: !stillHasKey });
		} catch (error) {
			console.error('AI rival failed to respond:', error);
			this.updateStatus(this.t('aiRivalError'), 'error');
			const stillHasKey = Boolean(this.getAiKey(this.aiSettings));
			this.setButtonState({ loading: false, disabled: !stillHasKey });
		}
	}
}
