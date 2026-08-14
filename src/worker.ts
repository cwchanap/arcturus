// Custom Cloudflare Worker entry point for Astro.
// Mirrors @astrojs/cloudflare/entrypoints/server.js and additionally re-exports
// Durable Object classes so wrangler can resolve them via bindings.

import { App } from 'astro/app';
import { handle } from '@astrojs/cloudflare/handler';
import {
	runRetentionCleanup,
	runScheduledJobs,
	type ScheduledJobDeps,
	type ScheduledJobEnv,
} from './server/cleanup';
import { MultiplayerPokerRoom } from './server/mp/multiplayer-poker-room';
import { runBlackjackRunExpiration } from './server/blackjack-run/expiration';
import { createBlackjackRunRepository } from './server/blackjack-run/repository';
import { createBlackjackRunService } from './server/blackjack-run/service';

interface AstroManifest {
	[key: string]: unknown;
}

type WorkerEnv = ScheduledJobEnv;

const scheduledJobDeps: ScheduledJobDeps = {
	retentionCleanup: runRetentionCleanup,
	async blackjackRunExpiration(db, nowSeconds) {
		const service = createBlackjackRunService({
			repository: createBlackjackRunRepository(db),
			db,
			// Use the scheduled job's authoritative clock so expiration
			// decisions are consistent with the cursor that selected the rows.
			now: () => nowSeconds,
			randomBytes(length) {
				return crypto.getRandomValues(new Uint8Array(length));
			},
		});
		await runBlackjackRunExpiration(db, {
			expire: (runId) => service.expire(runId),
			nowSeconds: () => nowSeconds,
			log(event, runId) {
				console.warn('[BLACKJACK_RUN]', { event, runId });
			},
			warn(message, error) {
				console.warn(message, error);
			},
		});
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
	// Cron Trigger handler — runs the retention cleanup then expires
	// Blackjack runs. Each job has an independent error boundary in
	// runScheduledJobs.
	const scheduled = async (
		_controller: ScheduledController,
		env: WorkerEnv,
		_ctx: ExecutionContext,
	): Promise<void> => {
		await runScheduledJobs(env, scheduledJobDeps);
	};
	return { default: { fetch, scheduled }, MultiplayerPokerRoom };
}
