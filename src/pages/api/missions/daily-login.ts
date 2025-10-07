import type { APIRoute } from 'astro';
import { createDb } from '../../../lib/db';
import {
	MissionType,
	completeMission,
	getMissionProgress,
	getUserChipBalance,
} from '../../../lib/missions';
import { getMockD1Database } from '../../../lib/mock-d1';

function jsonResponse(body: Record<string, unknown>, init?: ResponseInit) {
	return new Response(JSON.stringify(body), {
		headers: {
			'content-type': 'application/json',
		},
		...init,
	});
}

async function getDb(locals: App.Locals) {
	let dbBinding = locals.runtime?.env?.DB ?? null;

	if (!dbBinding && import.meta.env.DEV) {
		try {
			dbBinding = await getMockD1Database();
		} catch (error) {
			console.error('Error creating mock D1 database:', error);
		}
	}

	return dbBinding ? createDb(dbBinding) : null;
}

const missionType = MissionType.DAILY_LOGIN;

export const GET: APIRoute = async ({ locals }) => {
	const session = locals.session;
	if (!session) {
		return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
	}

	const db = await getDb(locals);
	if (!db) {
		return jsonResponse({ error: 'Database unavailable' }, { status: 500 });
	}

	const progress = await getMissionProgress(db, session.user.id, missionType);
	const chipBalance = await getUserChipBalance(db, session.user.id);

	return jsonResponse({
		missionId: progress.mission.id,
		title: progress.mission.title,
		description: progress.mission.description,
		reward: progress.mission.reward,
		completedToday: progress.completedToday,
		completedDate: progress.completedDate?.toISOString() ?? null,
		chipBalance,
	});
};

export const POST: APIRoute = async ({ locals }) => {
	const session = locals.session;
	if (!session) {
		return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
	}

	const db = await getDb(locals);
	if (!db) {
		return jsonResponse({ error: 'Database unavailable' }, { status: 500 });
	}

	const result = await completeMission(db, session.user.id, missionType);

	return jsonResponse({
		status: result.status,
		missionId: result.progress.mission.id,
		reward: result.progress.mission.reward,
		completedToday: result.progress.completedToday,
		completedDate: result.progress.completedDate?.toISOString() ?? null,
		chipBalance: result.chipBalance,
	});
};
