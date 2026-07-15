/**
 * Setup Local Cloudflare D1 Database for Development
 * This script initializes a local D1 database and applies ALL migrations
 * in order (not just the initial schema), so tables added in later
 * migrations (e.g. roulette_round) are created on a fresh setup.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';

const MIGRATIONS_DIR = './drizzle';

// Keep Wrangler logs inside the project so sandboxed environments can write them.
const PROJECT_LOG_PATH = resolve('.wrangler/logs');
process.env.WRANGLER_LOG_PATH = process.env.WRANGLER_LOG_PATH ?? PROJECT_LOG_PATH;

function exec(command: string) {
	try {
		execSync(command, { stdio: 'inherit', env: process.env });
	} catch (_error) {
		console.error(`\n❌ Error executing command: ${command}`);
		process.exit(1);
	}
}

function main() {
	console.log('🎰 Arcturus Casino - Local Database Setup');
	console.log('==========================================\n');

	// Check if migrations directory exists
	if (!existsSync(MIGRATIONS_DIR)) {
		console.error('❌ Error: Migrations directory not found');
		console.error('   Run: bun run db:generate first\n');
		process.exit(1);
	}

	console.log('✅ Migrations directory found\n');

	// Apply all migrations to local database via the migration runner,
	// which tracks applied migrations and applies pending ones in order.
	console.log('🔄 Applying all migrations to local database...\n');

	exec(`bun scripts/apply-migrations.ts`);

	console.log('\n✅ Local database setup complete!\n');
	console.log('📊 Database location: .wrangler/state/v3/d1/miniflare-D1DatabaseObject/\n');
	console.log('🎮 Next steps:');
	console.log('   1. Start dev server: bun run dev');
	console.log('   2. Visit: http://localhost:2000\n');
	console.log('💡 Useful commands:');
	console.log(
		'   • Query local DB: wrangler d1 execute arcturus --local --command="SELECT * FROM user"',
	);
	console.log('   • Reset local DB: rm -rf .wrangler/state && bun run setup:db');
	console.log('   • Open Drizzle Studio: bun run db:studio\n');
}

main();
