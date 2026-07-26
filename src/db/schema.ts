import {
	sqliteTable,
	text,
	integer,
	primaryKey,
	index,
	uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const user = sqliteTable('user', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	email: text('email').notNull().unique(),
	emailVerified: integer('emailVerified', { mode: 'boolean' }).notNull(),
	image: text('image'),
	chipBalance: integer('chipBalance').notNull().default(10000),
	heldChips: integer('heldChips').notNull().default(0),
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

export const chipSyncReceipt = sqliteTable(
	'chip_sync_receipt',
	{
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		syncId: text('syncId').notNull(),
		gameType: text('gameType').notNull(),
		previousBalance: integer('previousBalance').notNull(),
		balance: integer('balance').notNull(),
		delta: integer('delta').notNull(),
		statsDelta: integer('statsDelta'),
		outcome: text('outcome'),
		handCount: integer('handCount'),
		winsIncrement: integer('winsIncrement'),
		lossesIncrement: integer('lossesIncrement'),
		biggestWinCandidate: integer('biggestWinCandidate'),
		overallRank: integer('overallRank'),
		achievementPayload: text('achievementPayload'),
		createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.userId, table.syncId] }),
		userCreatedIdx: index('chip_sync_receipt_user_created_idx').on(table.userId, table.createdAt),
		createdIdx: index('chip_sync_receipt_created_idx').on(table.createdAt),
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

/**
 * Multiplayer room membership.
 * Enforces a user can only be in a single MP room at a time (userId is primary key).
 */
export const mpMembership = sqliteTable('mp_membership', {
	userId: text('userId')
		.primaryKey()
		.references(() => user.id, { onDelete: 'cascade' }),
	roomCode: text('roomCode').notNull(),
	joinedAt: integer('joinedAt', { mode: 'timestamp' }).notNull(),
});

export const rouletteRound = sqliteTable(
	'roulette_round',
	{
		syncId: text('syncId').notNull(),
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		winningNumber: integer('winningNumber').notNull(),
		betsJson: text('betsJson').notNull(),
		totalBet: integer('totalBet').notNull(),
		totalPayout: integer('totalPayout').notNull(),
		netDelta: integer('netDelta').notNull(),
		previousBalance: integer('previousBalance').notNull(),
		newBalance: integer('newBalance').notNull(),
		// mode: 'timestamp' stores/reads unix seconds (not ms). Raw SQL writers
		// (spin endpoint) must bind Math.trunc(Date.now() / 1000).
		createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.userId, table.syncId] }),
		createdIdx: index('roulette_round_created_idx').on(table.createdAt),
	}),
);

export const rankedSession = sqliteTable(
	'ranked_session',
	{
		id: text('id').primaryKey(),
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		startRequestId: text('startRequestId').notNull(),
		startPayloadHash: text('startPayloadHash').notNull(),
		activeUserId: text('activeUserId').references(() => user.id, { onDelete: 'cascade' }),
		gameType: text('gameType').notNull(),
		rulesetVersion: text('rulesetVersion').notNull(),
		configJson: text('configJson').notNull(),
		configHash: text('configHash').notNull(),
		// Server-only sensitive replay material. Never expose through public APIs or logs.
		seed: text('seed').notNull(),
		seedCommitment: text('seedCommitment').notNull(),
		actionLogJson: text('actionLogJson').notNull(),
		actionLogHash: text('actionLogHash').notNull(),
		nextSequence: integer('nextSequence').notNull().default(0),
		initialWager: integer('initialWager').notNull(),
		committedWager: integer('committedWager').notNull(),
		status: text('status').notNull(),
		expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
		createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
		updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
		settledAt: integer('settledAt', { mode: 'timestamp' }),
	},
	(table) => ({
		startRequestUnique: uniqueIndex('ranked_session_user_start_request_idx').on(
			table.userId,
			table.startRequestId,
		),
		activeUserUnique: uniqueIndex('ranked_session_active_user_idx').on(table.activeUserId),
		expiryIdx: index('ranked_session_status_expiry_idx').on(table.status, table.expiresAt),
		userCreatedIdx: index('ranked_session_user_created_idx').on(table.userId, table.createdAt),
	}),
);

export const rankedResult = sqliteTable('ranked_result', {
	sessionId: text('sessionId')
		.primaryKey()
		.references(() => rankedSession.id, { onDelete: 'cascade' }),
	userId: text('userId')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	gameType: text('gameType').notNull(),
	rulesetVersion: text('rulesetVersion').notNull(),
	seedCommitment: text('seedCommitment').notNull(),
	configHash: text('configHash').notNull(),
	actionLogHash: text('actionLogHash').notNull(),
	outcomeJson: text('outcomeJson').notNull(),
	initialWager: integer('initialWager').notNull(),
	committedWager: integer('committedWager').notNull(),
	payout: integer('payout').notNull(),
	gameNetDelta: integer('gameNetDelta').notNull(),
	rewardDelta: integer('rewardDelta').notNull(),
	balanceAfter: integer('balanceAfter').notNull(),
	statsEffectsJson: text('statsEffectsJson').notNull(),
	achievementEffectsJson: text('achievementEffectsJson').notNull(),
	rewardEffectsJson: text('rewardEffectsJson').notNull(),
	receiptHash: text('receiptHash').notNull(),
	settledAt: integer('settledAt', { mode: 'timestamp' }).notNull(),
});

export const rankedGameStats = sqliteTable(
	'ranked_game_stats',
	{
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		gameType: text('gameType').notNull(),
		sessionsPlayed: integer('sessionsPlayed').notNull().default(0),
		totalWins: integer('totalWins').notNull().default(0),
		totalLosses: integer('totalLosses').notNull().default(0),
		totalPushes: integer('totalPushes').notNull().default(0),
		totalForfeits: integer('totalForfeits').notNull().default(0),
		netProfit: integer('netProfit').notNull().default(0),
		biggestWin: integer('biggestWin').notNull().default(0),
		updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
	},
	(table) => ({ pk: primaryKey({ columns: [table.userId, table.gameType] }) }),
);

export const rankedRewardGrant = sqliteTable(
	'ranked_reward_grant',
	{
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		rewardId: text('rewardId').notNull(),
		sourceSessionId: text('sourceSessionId')
			.notNull()
			.references(() => rankedSession.id, { onDelete: 'cascade' }),
		achievementId: text('achievementId').notNull(),
		chipAmount: integer('chipAmount').notNull(),
		grantedAt: integer('grantedAt', { mode: 'timestamp' }).notNull(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.userId, table.rewardId] }),
		sourceSessionIdx: index('ranked_reward_grant_source_session_idx').on(table.sourceSessionId),
	}),
);

export const rankedRateLimit = sqliteTable(
	'ranked_rate_limit',
	{
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		operation: text('operation').notNull(),
		windowStart: integer('windowStart').notNull(),
		count: integer('count').notNull(),
		expiresAt: integer('expiresAt').notNull(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.userId, table.operation, table.windowStart] }),
		expiryIdx: index('ranked_rate_limit_expiry_idx').on(table.expiresAt),
	}),
);
