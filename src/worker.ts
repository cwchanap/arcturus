// Custom Cloudflare Worker entry (Astro 6 / @astrojs/cloudflare v13).
// The adapter's handle() owns the Astro app; this entry adds the cron
// scheduled() handler and re-exports the Durable Object class so wrangler
// can resolve the MULTIPLAYER_POKER_ROOMS binding.

import { handle } from '@astrojs/cloudflare/handler';
import { runRetentionCleanup, runScheduledJobs, type ScheduledJobDeps } from './server/cleanup';
import { MultiplayerPokerRoom } from './server/mp/multiplayer-poker-room';
import { runBlackjackRunExpiration } from './server/blackjack-run/expiration';
import { createBlackjackRunRepository } from './server/blackjack-run/repository';
import { createBlackjackRunService } from './server/blackjack-run/service';

type WorkerEnv = Cloudflare.Env;

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

export { MultiplayerPokerRoom };

export default {
	async fetch(request, env: WorkerEnv, context) {
		return handle(request, env, context);
	},
	// Cron Trigger handler — runs the retention cleanup then expires
	// Blackjack runs. Each job has an independent error boundary in
	// runScheduledJobs.
	async scheduled(_controller: ScheduledController, env: WorkerEnv, _ctx: ExecutionContext) {
		await runScheduledJobs({ DB: env.DB }, scheduledJobDeps);
	},
} satisfies ExportedHandler<WorkerEnv>;
