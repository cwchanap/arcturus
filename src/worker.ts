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
import { Arcturus as ArcturusDO } from './server/mp/arcturus';
import { reconcileMultiplayerMembership } from './server/mp/membership';
import { createRankedCoordinator } from './server/ranked/coordinator';
import { runRankedExpiration, runRankedRateLimitCleanup } from './server/ranked/expiration';
import { createRankedRepository } from './server/ranked/repository';

interface AstroManifest {
	[key: string]: unknown;
}

type WorkerEnv = ScheduledJobEnv;

const scheduledJobDeps: ScheduledJobDeps = {
	async rankedExpiration(db, namespace, nowSeconds) {
		const coordinator = createRankedCoordinator({
			repository: createRankedRepository(db),
			getAdapter: getRankedAdapter,
			reconcileMembership: reconcileMultiplayerMembership,
			membershipDb: db,
			membershipNamespace: namespace,
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
		});
	},
	rankedRateCleanup: runRankedRateLimitCleanup,
	retentionCleanup: runRetentionCleanup,
	nowSeconds: () => Math.trunc(Date.now() / 1000),
	warn(message) {
		console.warn(message);
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
	return { default: { fetch, scheduled }, Arcturus: ArcturusDO };
}
