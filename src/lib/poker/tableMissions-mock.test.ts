/**
 * Mock-registry unit tests for `selectPokerMissions` that need a definition
 * shape the real registry cannot produce.
 *
 * Bun cannot unregister a `mock.module` patch — the restore re-mock only
 * re-binds the real implementation, leaving the module record patched — so
 * patched-registry tests live in this file (the `*-mock.test.ts` pattern)
 * and the main `tableMissions.test.ts` stays on the real registry.
 */

import { describe, expect, mock, test } from 'bun:test';
import type { BoardState, MissionMetric, MissionView } from '../missions/types';
import { selectPokerMissions } from './tableMissions';

function mission(overrides: Partial<MissionView> & Pick<MissionView, 'missionDefId'>): MissionView {
	return {
		icon: '★',
		period: 'daily',
		progress: 0,
		target: 3,
		completed: false,
		claimed: false,
		claimable: false,
		rewardChips: 500,
		isOverride: false,
		...overrides,
	};
}

function board(daily: MissionView[], weekly: MissionView[] = []): BoardState {
	return {
		streak: {
			current: 0,
			longest: 0,
			claimableToday: false,
			dayOfCycle: 1,
			rewardPreview: 0,
			lastClaimPeriodKey: '',
		},
		daily,
		weekly,
		rerollAvailable: false,
		nextDailyReset: '',
		nextWeeklyReset: '',
		chipBalance: 1000,
	};
}

describe('selectPokerMissions (mocked registry)', () => {
	test('excludes a bigWin metric scoped to another game', async () => {
		// The registry's only bigWin definition is poker-scoped, so this mock
		// scopes it to another game to prove the shared guard rejects it. The
		// finally re-mock re-binds the real getMissionDef; the file boundary
		// contains the patched registry record, which Bun cannot unregister.
		const actual = await import('../missions/registry');
		const realGetMissionDef = actual.getMissionDef;
		const blackjackBigWin: MissionMetric = {
			kind: 'bigWin',
			minDelta: 500,
			gameType: 'blackjack',
		};
		mock.module('../missions/registry', () => ({
			...actual,
			getMissionDef: (id: string) => {
				const def = realGetMissionDef(id);
				return id === 'daily-poker-big-pot' && def ? { ...def, metric: blackjackBigWin } : def;
			},
		}));
		try {
			const selected = selectPokerMissions(
				board([mission({ missionDefId: 'daily-poker-big-pot', isOverride: true })]),
			);
			expect(selected).toEqual([]);
		} finally {
			mock.module('../missions/registry', () => ({
				...actual,
				getMissionDef: (id: string) => realGetMissionDef(id),
			}));
		}
	});
});
