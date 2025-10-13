// @ts-check

import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	output: 'server',
	adapter: cloudflare({
		platformProxy: {
			enabled: true,
		},
	}),
	server: {
		port: 2000,
	},
	vite: {
		// Temporarily disable Tailwind to test build
		// plugins: [tailwindcss()],
		ssr: {
			external: ['better-sqlite3'],
		},
		optimizeDeps: {
			exclude: ['better-sqlite3'],
		},
	},
});
