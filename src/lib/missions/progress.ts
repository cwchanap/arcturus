import type { MissionDefinition, MissionGameEvent } from './types';

export interface ExistingProgress {
	progress: number;
	metadataJson: string | null;
}

export interface IncrementResult {
	amount: number;
	metadata?: string[];
}

export function clampProgress(progress: number, target: number): number {
	return Math.max(0, Math.min(progress, target));
}

export function computeIncrement(
	def: MissionDefinition,
	event: MissionGameEvent,
	existing: ExistingProgress | null,
): IncrementResult {
	const metric = def.metric;

	switch (metric.kind) {
		case 'handsPlayed': {
			if (metric.gameType && event.gameType !== metric.gameType) return { amount: 0 };
			if (!metric.gameType && event.gameType === 'poker_mp') return { amount: 0 };
			return { amount: event.handCount };
		}
		case 'roundsWon': {
			if (metric.gameType && event.gameType !== metric.gameType) return { amount: 0 };
			const wins = event.winsIncrement > 0 ? event.winsIncrement : event.outcome === 'win' ? 1 : 0;
			return { amount: wins };
		}
		case 'spinsCompleted': {
			if (event.gameType !== 'slots') return { amount: 0 };
			return { amount: event.handCount };
		}
		case 'mpHandsCompleted': {
			if (event.gameType !== 'poker_mp') return { amount: 0 };
			return { amount: 1 };
		}
		case 'gamesTried': {
			const existingGames = parseMetadata(existing?.metadataJson);
			if (existingGames.includes(event.gameType)) return { amount: 0 };
			return { amount: 1, metadata: [...existingGames, event.gameType] };
		}
	}
}

export function parseMetadata(json: string | null | undefined): string[] {
	if (!json) return [];
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
	} catch {
		return [];
	}
}
