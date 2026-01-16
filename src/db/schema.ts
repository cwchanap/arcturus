import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';

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

export const llmSettings = sqliteTable('llm_settings', {
	userId: text('userId')
		.primaryKey()
		.references(() => user.id),
	provider: text('provider').notNull().default('openai'),
	model: text('model').notNull().default('gpt-4o'),
	openaiApiKey: text('openaiApiKey'),
	geminiApiKey: text('geminiApiKey'),
	createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
	updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
});

/**
 * Game statistics per user per game type.
 * Tracks performance metrics for game-specific leaderboards.
 */
export const gameStats = sqliteTable(
	'game_stats',
	{
		userId: text('userId')
			.notNull()
			.references(() => user.id),
		gameType: text('gameType').notNull(), // 'poker' | 'blackjack' | 'baccarat'

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
			.references(() => user.id),
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
