import type { D1Database } from '@cloudflare/workers-types';
import { and, eq, sql } from 'drizzle-orm';
import { mission, user } from '../db/schema';
import type { Database } from './db';

function isSameCalendarDay(left: Date, right: Date): boolean {
	return (
		left.getUTCFullYear() === right.getUTCFullYear() &&
		left.getUTCMonth() === right.getUTCMonth() &&
		left.getUTCDate() === right.getUTCDate()
	);
}

export class MissionType {
	private constructor(
		public readonly id: string,
		public readonly title: string,
		public readonly description: string,
		public readonly reward: number,
	) {}

	static readonly DAILY_LOGIN = new MissionType(
		'daily-login',
		'Daily Login',
		'Log in every day to claim bonus chips.',
		1000,
	);

	static all(): MissionType[] {
		return [MissionType.DAILY_LOGIN];
	}

	static fromId(id: string): MissionType | undefined {
		return MissionType.all().find((missionType) => missionType.id === id);
	}
}

export interface MissionProgress {
	mission: MissionType;
	completedDate: Date | null;
	completedToday: boolean;
}

export interface MissionCompletionResult {
	status: 'completed' | 'already-completed';
	progress: MissionProgress;
	chipBalance: number | null;
}

let schemaInitialized = false;

async function ensureMissionSchema(db: Database) {
	if (schemaInitialized) {
		return;
	}

	const client = (db as unknown as { $client?: D1Database }).$client;

	if (!client) {
		schemaInitialized = true;
		return;
	}

	await client
		.prepare(
			[
				'CREATE TABLE IF NOT EXISTS "mission" (',
				'"missionId" text NOT NULL,',
				'"userId" text NOT NULL,',
				'"completedDate" integer,',
				'PRIMARY KEY("userId", "missionId"),',
				'FOREIGN KEY ("userId") REFERENCES "user"("id") ON UPDATE no action ON DELETE no action',
				');',
			].join('\n'),
		)
		.run();

	try {
		await client
			.prepare('ALTER TABLE "user" ADD COLUMN "chipBalance" integer DEFAULT 10000 NOT NULL;')
			.run();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/duplicate column name/i.test(message)) {
			throw error;
		}
	}

	schemaInitialized = true;
}

async function fetchMissionRecord(db: Database, userId: string, missionType: MissionType) {
	const [record] = await db
		.select()
		.from(mission)
		.where(and(eq(mission.userId, userId), eq(mission.missionId, missionType.id)))
		.limit(1);

	return record ?? null;
}

async function ensureMissionExists(db: Database, userId: string, missionType: MissionType) {
	await db
		.insert(mission)
		.values({
			missionId: missionType.id,
			userId,
		})
		.onConflictDoNothing();
}

export async function getMissionProgress(
	db: Database,
	userId: string,
	missionType: MissionType,
): Promise<MissionProgress> {
	await ensureMissionSchema(db);
	await ensureMissionExists(db, userId, missionType);

	const record = await fetchMissionRecord(db, userId, missionType);
	const completedDate = record?.completedDate ?? null;
	const completedToday = completedDate ? isSameCalendarDay(completedDate, new Date()) : false;

	return {
		mission: missionType,
		completedDate,
		completedToday,
	};
}

async function getChipBalance(db: Database, userId: string) {
	await ensureMissionSchema(db);

	const [row] = await db
		.select({ chipBalance: user.chipBalance })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);

	return row?.chipBalance ?? null;
}

export async function completeMission(
	db: Database,
	userId: string,
	missionType: MissionType,
): Promise<MissionCompletionResult> {
	const currentProgress = await getMissionProgress(db, userId, missionType);

	if (currentProgress.completedToday) {
		const chipBalance = await getChipBalance(db, userId);
		return {
			status: 'already-completed',
			progress: currentProgress,
			chipBalance,
		};
	}

	const now = new Date();

	await db
		.insert(mission)
		.values({
			missionId: missionType.id,
			userId,
			completedDate: now,
		})
		.onConflictDoUpdate({
			target: [mission.userId, mission.missionId],
			set: { completedDate: now },
		});

	await db
		.update(user)
		.set({ chipBalance: sql`${user.chipBalance} + ${missionType.reward}` })
		.where(eq(user.id, userId));

	const updatedProgress = await getMissionProgress(db, userId, missionType);
	const chipBalance = await getChipBalance(db, userId);

	return {
		status: 'completed',
		progress: updatedProgress,
		chipBalance,
	};
}

export async function getUserChipBalance(db: Database, userId: string) {
	return getChipBalance(db, userId);
}

export async function resetMissionProgress(db: Database, userId: string, missionType: MissionType) {
	await ensureMissionSchema(db);
	await ensureMissionExists(db, userId, missionType);

	await db
		.update(mission)
		.set({ completedDate: null })
		.where(and(eq(mission.userId, userId), eq(mission.missionId, missionType.id)));

	const progress = await getMissionProgress(db, userId, missionType);
	const chipBalance = await getChipBalance(db, userId);

	return {
		progress,
		chipBalance,
	};
}
