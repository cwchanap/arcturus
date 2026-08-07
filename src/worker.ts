// Custom Cloudflare Worker entry point for Astro.
// Mirrors @astrojs/cloudflare/entrypoints/server.js and additionally re-exports
// Durable Object classes so wrangler can resolve them via bindings.

import { App } from 'astro/app';
import { handle } from '@astrojs/cloudflare/handler';
import { getRankedAdapter } from './lib/ranked/registry';
import {
	runRetentionCleanup,
	runScheduledJobs,
	type ScheduledJobDeps,
	type ScheduledJobEnv,
} from './server/cleanup';
import { createDailyChallengeCoordinator } from './server/daily-challenge/coordinator';
import {
	runDailyChallengeExpiration,
	runDailyChallengeRetention,
} from './server/daily-challenge/expiration';
import { createDailyChallengeRepository } from './server/daily-challenge/repository';
import { MultiplayerPokerRoom } from './server/mp/multiplayer-poker-room';
import { createRankedCoordinator } from './server/ranked/coordinator';
import { runRankedExpiration, runRankedRateLimitCleanup } from './server/ranked/expiration';
import { createRankedRepository } from './server/ranked/repository';

interface AstroManifest {
	[key: string]: unknown;
}

type WorkerEnv = ScheduledJobEnv;

const scheduledJobDeps: ScheduledJobDeps = {
	async rankedExpiration(db, nowSeconds) {
		const coordinator = createRankedCoordinator({
			repository: createRankedRepository(db),
			getAdapter: getRankedAdapter,
			now: () => new Date(),
			randomBytes(length) {
				return crypto.getRandomValues(new Uint8Array(length));
			},
		});
		await runRankedExpiration(db, {
			expire: (sessionId) => coordinator.expire(sessionId),
			nowSeconds: () => nowSeconds,
			log(entry) {
				console.warn('[RANKED]', entry);
			},
			warn(message, error) {
				console.warn(message, error);
			},
		});
	},
	rankedRateCleanup: runRankedRateLimitCleanup,
	retentionCleanup: runRetentionCleanup,
	async dailyChallengeExpiration(db, nowSeconds) {
		const repository = createDailyChallengeRepository(db);
		const coordinator = createDailyChallengeCoordinator({
			repository,
			// Use the scheduled job's authoritative clock, not wall-clock time, so
			// expiration decisions are consistent with the cursor that selected the rows.
			now: () => new Date(nowSeconds * 1000),
			randomBytes(length) {
				return crypto.getRandomValues(new Uint8Array(length));
			},
			log(entry) {
				console.warn('[DAILY_CHALLENGE]', entry);
			},
			// Expiration only calls coordinator.expire(), which never touches the rate
			// limiters. Throw on any invocation so an accidental scheduled-path call
			// fails loudly at runtime instead of silently masking a bug.
			async consumeStartRateLimit() {
				throw new Error('Daily Challenge expiration must not consume start rate limits');
			},
			async consumeCommandRateLimit() {
				throw new Error('Daily Challenge expiration must not consume command rate limits');
			},
			async consumeResumeRateLimit() {
				throw new Error('Daily Challenge expiration must not consume resume rate limits');
			},
		});
		await runDailyChallengeExpiration(
			repository,
			(attemptId) => coordinator.expire(attemptId),
			nowSeconds,
		);
	},
	async dailyChallengeRetention(db, nowSeconds) {
		await runDailyChallengeRetention(createDailyChallengeRepository(db), nowSeconds);
	},
	nowSeconds: () => Math.trunc(Date.now() / 1000),
	warn(message, error) {
		console.warn(message, error);
	},
};

export function createExports(manifest: AstroManifest) {
	const app = new App(manifest as ConstructorParameters<typeof App>[0]);
	const fetch = async (
		request: Request,
		env: WorkerEnv,
		context: ExecutionContext,
	): Promise<Response> => {
		return await handle(
			manifest as Parameters<typeof handle>[0],
			app,
			request,
			env as Parameters<typeof handle>[3],
			context,
		);
	};
	// Cron Trigger handler — expires ranked sessions, reaps ranked rate
	// buckets, then runs the existing retention cleanup. Each job has an
	// independent error boundary in runScheduledJobs.
	const scheduled = async (
		_controller: ScheduledController,
		env: WorkerEnv,
		_ctx: ExecutionContext,
	): Promise<void> => {
		await runScheduledJobs(env, scheduledJobDeps);
	};
	return { default: { fetch, scheduled }, MultiplayerPokerRoom };
}
