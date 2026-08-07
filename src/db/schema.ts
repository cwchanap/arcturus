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
		// mode: 'timestamp' stores/reads unix seconds (not ms). Raw SQL
		// writers (repository transitions, scheduled expiration) must bind
		// Math.trunc(Date.now() / 1000).
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
	// mode: 'timestamp' stores/reads unix seconds (not ms). Raw SQL writers
	// (repository terminal/expiration transitions) must bind
	// Math.trunc(Date.now() / 1000).
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
		// mode: 'timestamp' stores/reads unix seconds (not ms). Raw SQL
		// writers (repository stats upsert) must bind
		// Math.trunc(Date.now() / 1000).
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
		// mode: 'timestamp' stores/reads unix seconds (not ms). Raw SQL
		// writers (repository reward reservation) must bind
		// Math.trunc(Date.now() / 1000).
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
		// Plain integer (not mode: 'timestamp') but stores unix seconds
		// (not ms). Raw SQL writers (rate-limit upsert/continuation) must
		// bind Math.trunc(Date.now() / 1000).
		windowStart: integer('windowStart').notNull(),
		count: integer('count').notNull(),
		expiresAt: integer('expiresAt').notNull(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.userId, table.operation, table.windowStart] }),
		expiryIdx: index('ranked_rate_limit_expiry_idx').on(table.expiresAt),
	}),
);

export const dailyChallenge = sqliteTable(
	'daily_challenge',
	{
		id: text('id').primaryKey(),
		challengeKind: text('challengeKind').notNull(),
		periodKey: text('periodKey').notNull(),
		challengeRulesetVersion: text('challengeRulesetVersion').notNull(),
		gameRulesetVersion: text('gameRulesetVersion').notNull(),
		scoreVersion: text('scoreVersion').notNull(),
		configJson: text('configJson').notNull(),
		configHash: text('configHash').notNull(),
		// Server-only sensitive replay material. Never expose through public APIs or logs.
		rankedSeed: text('rankedSeed').notNull(),
		rankedSeedCommitment: text('rankedSeedCommitment').notNull(),
		practiceSeed: text('practiceSeed').notNull(),
		startsAt: integer('startsAt', { mode: 'timestamp' }).notNull(),
		rankedEntryClosesAt: integer('rankedEntryClosesAt', { mode: 'timestamp' }).notNull(),
		endsAt: integer('endsAt', { mode: 'timestamp' }).notNull(),
		// mode: 'timestamp' stores/reads unix seconds (not ms). Raw SQL
		// writers (challenge provisioning scheduler) must bind
		// Math.trunc(Date.now() / 1000).
		createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
	},
	(table) => ({
		periodUnique: uniqueIndex('daily_challenge_kind_period_idx').on(
			table.challengeKind,
			table.periodKey,
		),
		endsAtIdx: index('daily_challenge_ends_at_idx').on(table.endsAt),
	}),
);

export const dailyChallengeAttempt = sqliteTable(
	'daily_challenge_attempt',
	{
		id: text('id').primaryKey(),
		challengeId: text('challengeId')
			.notNull()
			.references(() => dailyChallenge.id, { onDelete: 'cascade' }),
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		startRequestId: text('startRequestId').notNull(),
		startPayloadHash: text('startPayloadHash').notNull(),
		status: text('status').notNull(),
		actionLogJson: text('actionLogJson').notNull(),
		actionLogHash: text('actionLogHash').notNull(),
		// Persisted transition projections for efficient responses and write guards.
		// The canonical command log remains the replay source of truth.
		nextCommandSequence: integer('nextCommandSequence').notNull().default(0),
		availableBankroll: integer('availableBankroll').notNull(),
		roundsCompleted: integer('roundsCompleted').notNull().default(0),
		expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
		createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
		updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
		// mode: 'timestamp' stores/reads unix seconds (not ms). Raw SQL
		// writers (repository transition/expiration) must bind
		// Math.trunc(Date.now() / 1000).
		settledAt: integer('settledAt', { mode: 'timestamp' }),
	},
	(table) => ({
		challengeUserUnique: uniqueIndex('daily_challenge_attempt_challenge_user_idx').on(
			table.challengeId,
			table.userId,
		),
		userStartRequestUnique: uniqueIndex('daily_challenge_attempt_user_start_request_idx').on(
			table.userId,
			table.startRequestId,
		),
		statusExpiryIdx: index('daily_challenge_attempt_status_expiry_idx').on(
			table.status,
			table.expiresAt,
		),
		userCreatedIdx: index('daily_challenge_attempt_user_created_idx').on(
			table.userId,
			table.createdAt,
		),
	}),
);

export const dailyChallengeResult = sqliteTable(
	'daily_challenge_result',
	{
		// Opaque correlation to an attempt row; intentionally NOT a foreign key
		// so old command logs can be reaped without deleting compact scores.
		attemptId: text('attemptId').notNull().unique(),
		challengeId: text('challengeId')
			.notNull()
			.references(() => dailyChallenge.id, { onDelete: 'cascade' }),
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		endingBankroll: integer('endingBankroll').notNull(),
		roundsCompleted: integer('roundsCompleted').notNull(),
		eligible: integer('eligible', { mode: 'boolean' }).notNull(),
		terminalReason: text('terminalReason').notNull(),
		durationSeconds: integer('durationSeconds').notNull(),
		scoreVersion: text('scoreVersion').notNull(),
		configHash: text('configHash').notNull(),
		rankedSeedCommitment: text('rankedSeedCommitment').notNull(),
		actionLogHash: text('actionLogHash').notNull(),
		receiptHash: text('receiptHash').notNull(),
		createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
		// mode: 'timestamp' stores/reads unix seconds (not ms). Raw SQL
		// writers (repository terminal transition) must bind
		// Math.trunc(Date.now() / 1000).
		settledAt: integer('settledAt', { mode: 'timestamp' }).notNull(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.challengeId, table.userId] }),
		// NOTE: spec §11.3 specifies endingBankroll DESC, roundsCompleted DESC.
		// drizzle-orm 0.44.5 does not expose .desc() on index column builders in
		// the table config callback (table.col.desc is not a function), so the
		// index is declared with ascending columns. Direction is a performance
		// detail, not a constraint: SQLite can scan a btree in either direction,
		// and the leaderboard competition-rank SQL applies
		// `ORDER BY endingBankroll DESC, roundsCompleted DESC` at query time.
		leaderboardIdx: index('daily_challenge_result_leaderboard_idx').on(
			table.challengeId,
			table.eligible,
			table.endingBankroll,
			table.roundsCompleted,
			table.settledAt,
			table.userId,
		),
		userSettledIdx: index('daily_challenge_result_user_settled_idx').on(
			table.userId,
			table.settledAt,
		),
	}),
);
