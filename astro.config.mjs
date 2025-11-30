// @ts-check

import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	output: 'server',
	adapter: cloudflare({
		// Using 'passthrough' because:
		// - 'compile' uses sharp which has native deps incompatible with Workers
		// - 'cloudflare' requires paid Cloudflare Image Resizing feature
		// For a casino app with minimal image needs, passthrough is sufficient.
		// Images are served as-is; optimize source assets at build time if needed.
		imageService: 'passthrough',
		platformProxy: {
			enabled: true,
		},
	}),
	server: {
		port: 2000,
	},
	vite: {
		plugins: [tailwindcss()],
		ssr: {
			external: [
				'better-sqlite3',
				'better-auth',
				'better-auth/client',
				'better-auth/adapters/drizzle',
				'drizzle-orm',
				'drizzle-orm/d1',
				'drizzle-orm/sqlite-core',
			],
			noExternal: [],
		},
		optimizeDeps: {
			exclude: ['better-sqlite3', 'better-auth', 'drizzle-orm'],
		},
	},
});
