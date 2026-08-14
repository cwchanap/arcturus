import {
	sqliteTable,
	text,
	integer,
	primaryKey,
	index,
	uniqueIndex,
	unique,
} from 'drizzle-orm/sqlite-core';

export const user = sqliteTable('user', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	email: text('email').notNull().unique(),
	emailVerified: integer('emailVerified', { mode: 'boolean' }).notNull(),
	image: text('image'),
	chipBalance: integer('chipBalance').notNull().default(10000),
	createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
	updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
});

export const session = sqliteTable('session', {
	id: text('id').primaryKey(),
	expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
	token: text('token').notNull().unique(),
	createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
	updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
	ipAddress: text('ipAddress'),
	userAgent: text('userAgent'),
	userId: text('userId')
		.notNull()
		.references(() => user.id),
});

export const walletSettlement = sqliteTable(
	'wallet_settlement',
	{
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		settlementId: text('settlementId').notNull(),
		attemptId: text('attemptId').notNull(),
		balance: integer('balance').notNull(),
		createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.userId, table.settlementId] }),
		createdIdx: index('wallet_settlement_created_idx').on(table.createdAt),
	}),
);

export const account = sqliteTable('account', {
	id: text('id').primaryKey(),
	accountId: text('accountId').notNull(),
	providerId: text('providerId').notNull(),
	userId: text('userId')
		.notNull()
		.references(() => user.id),
	accessToken: text('accessToken'),
	refreshToken: text('refreshToken'),
	idToken: text('idToken'),
	accessTokenExpiresAt: integer('accessTokenExpiresAt', { mode: 'timestamp' }),
	refreshTokenExpiresAt: integer('refreshTokenExpiresAt', { mode: 'timestamp' }),
	scope: text('scope'),
	password: text('password'),
	createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
	updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
});

export const verification = sqliteTable('verification', {
	id: text('id').primaryKey(),
	identifier: text('identifier').notNull(),
	value: text('value').notNull(),
	expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
	createdAt: integer('createdAt', { mode: 'timestamp' }),
	updatedAt: integer('updatedAt', { mode: 'timestamp' }),
});

export const mission = sqliteTable(
	'mission',
	{
		missionId: text('missionId').notNull(),
		userId: text('userId')
			.notNull()
			.references(() => user.id),
		completedDate: integer('completedDate', { mode: 'timestamp' }),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.userId, table.missionId] }),
	}),
);

export const missionProgress = sqliteTable(
	'mission_progress',
	{
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		missionDefId: text('missionDefId').notNull(),
		periodKey: text('periodKey').notNull(),
		progress: integer('progress').notNull().default(0),
		metadataJson: text('metadataJson'),
		completedAt: integer('completedAt', { mode: 'timestamp' }),
		claimedAt: integer('claimedAt', { mode: 'timestamp' }),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.userId, table.missionDefId, table.periodKey] }),
	}),
);

export const missionGameTried = sqliteTable(
	'mission_game_tried',
	{
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		missionDefId: text('missionDefId').notNull(),
		periodKey: text('periodKey').notNull(),
		gameType: text('gameType').notNull(),
		firstTriedAt: integer('firstTriedAt').notNull(),
	},
	(table) => ({
		pk: primaryKey({
			columns: [table.userId, table.missionDefId, table.periodKey, table.gameType],
		}),
	}),
);

export const loginStreak = sqliteTable('login_streak', {
	userId: text('userId')
		.primaryKey()
		.references(() => user.id, { onDelete: 'cascade' }),
	currentStreak: integer('currentStreak').notNull().default(0),
	longestStreak: integer('longestStreak').notNull().default(0),
	lastClaimPeriodKey: text('lastClaimPeriodKey').notNull().default(''),
});

export const missionOverride = sqliteTable(
	'mission_override',
	{
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		periodKey: text('periodKey').notNull(),
		originalMissionDefId: text('originalMissionDefId').notNull(),
		replacementMissionDefId: text('replacementMissionDefId').notNull(),
		rerolledAt: integer('rerolledAt', { mode: 'timestamp' }).notNull(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.userId, table.periodKey, table.originalMissionDefId] }),
		// One reroll per user per daily period. The PK alone allows multiple
		// rows for the same (userId, periodKey) keyed by originalMissionDefId;
		// this unique constraint closes the concurrent-reroll race where two
		// requests both pass the read-side `overrides.length === 0` check and
		// both INSERT. The reroll path uses INSERT ... ON CONFLICT(userId,
		// periodKey) DO NOTHING and treats 0 rows affected as `reroll-used`.
		onePerDay: unique('mission_override_one_per_day').on(table.userId, table.periodKey),
	}),
);

/**
 * Game statistics per user per game type.
 * Tracks performance metrics for game-specific leaderboards.
 */
export const gameStats = sqliteTable(
	'game_stats',
	{
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		gameType: text('gameType').notNull(), // 'poker' | 'blackjack' | 'baccarat' | 'craps' | 'slots' | 'roulette' | 'keno'

		// Core statistics
		totalWins: integer('totalWins').notNull().default(0),
		totalLosses: integer('totalLosses').notNull().default(0),
		handsPlayed: integer('handsPlayed').notNull().default(0),
		biggestWin: integer('biggestWin').notNull().default(0),

		// Net profit for leaderboard ranking (sum of all deltas)
		netProfit: integer('netProfit').notNull().default(0),

		updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.userId, table.gameType] }),
		// Indexes for leaderboard queries
		gameTypeWinsIdx: index('game_stats_type_wins_idx').on(table.gameType, table.totalWins),
		gameTypeProfitIdx: index('game_stats_type_profit_idx').on(table.gameType, table.netProfit),
		gameTypeBiggestWinIdx: index('game_stats_type_biggest_win_idx').on(
			table.gameType,
			table.biggestWin,
		),
	}),
);

/**
 * User achievements (badges) tracking.
 * Records when users earn specific achievements.
 */
export const userAchievement = sqliteTable(
	'user_achievement',
	{
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		achievementId: text('achievementId').notNull(), // 'rising_star', 'high_roller', etc.
		earnedAt: integer('earnedAt', { mode: 'timestamp' }).notNull(),
		// Game context when achievement was earned (null for global achievements)
		gameType: text('gameType'),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.userId, table.achievementId] }),
		// Index for fetching user's achievements
		userEarnedIdx: index('user_achievement_user_earned_idx').on(table.userId, table.earnedAt),
	}),
);

export const blackjackRun = sqliteTable(
	'blackjack_run',
	{
		id: text('id').primaryKey(),
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		// Equals userId only while the run is active. The unique index on
		// (activeUserId, mode) enforces one active run per user per mode;
		// SQLite allows multiple NULLs in a unique index, so inactive rows
		// (activeUserId = NULL) never conflict.
		activeUserId: text('activeUserId').references(() => user.id, { onDelete: 'cascade' }),
		mode: text('mode').notNull(), // 'ranked' | 'daily'
		// Daily only; null for Ranked runs.
		periodKey: text('periodKey'),
		startRequestId: text('startRequestId').notNull(),
		// Ranked only; null for Daily runs.
		initialWager: integer('initialWager'),
		// Server-only sensitive replay material. Never expose through public APIs or logs.
		seed: text('seed').notNull(),
		// Plain ordered command log (no hash). The canonical replay source.
		commandsJson: text('commandsJson').notNull(),
		nextSequence: integer('nextSequence').notNull().default(0),
		status: text('status').notNull(),
		// Nullable terminal result (Ranked outcome or Daily terminal projection).
		resultJson: text('resultJson'),
		// Daily leaderboard projections; non-null only for completed Daily runs.
		dailyEndingBankroll: integer('dailyEndingBankroll'),
		dailyRoundsCompleted: integer('dailyRoundsCompleted'),
		// mode: 'timestamp' stores/reads unix seconds (not ms). Raw SQL
		// writers (repository transitions) must bind
		// Math.trunc(Date.now() / 1000).
		expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
		createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
		updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
		settledAt: integer('settledAt', { mode: 'timestamp' }),
	},
	(table) => ({
		startRequestUnique: uniqueIndex('blackjack_run_user_start_request_idx').on(
			table.userId,
			table.startRequestId,
		),
		activeUserModeUnique: uniqueIndex('blackjack_run_active_user_mode_idx').on(
			table.activeUserId,
			table.mode,
		),
		userModePeriodUnique: uniqueIndex('blackjack_run_user_mode_period_idx').on(
			table.userId,
			table.mode,
			table.periodKey,
		),
		expiryIdx: index('blackjack_run_status_expiry_idx').on(table.status, table.expiresAt),
	}),
);

export const blackjackDaily = sqliteTable('blackjack_daily', {
	periodKey: text('periodKey').primaryKey(),
	// Server-only sensitive replay material. Never expose through public APIs or logs.
	seed: text('seed').notNull(),
	// mode: 'timestamp' stores/reads unix seconds (not ms). Raw SQL writers
	// (repository get-or-create) must bind Math.trunc(Date.now() / 1000).
	createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
});
