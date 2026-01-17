#!/usr/bin/env bun
/**
 * Apply all SQL migrations in order to D1 database
 *
 * This script reads all .sql files from the drizzle directory,
 * sorts them by timestamp/number, and applies them sequentially
 * to the specified D1 database (local or remote).
 */

import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, '..', 'drizzle');
const SQL_FILE_PATTERN = /^\d+_[^.]+\.sql$/;

/**
 * Get all SQL migration files sorted by number
 */
async function getSortedMigrations(): Promise<string[]> {
	const files = await readdir(MIGRATIONS_DIR);
	const sqlFiles = files.filter((f) => SQL_FILE_PATTERN.test(f));

	// Sort by the numeric prefix (0000_, 0001_, etc.)
	return sqlFiles.sort((a: string, b: string) => {
		const numA = parseInt(a.split('_')[0], 10);
		const numB = parseInt(b.split('_')[0], 10);
		return numA - numB;
	});
}

/**
 * Execute wrangler command and return output
 */
async function executeWrangler(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const wrangler = spawn('wrangler', args, { stdio: 'pipe' });
		let stdout = '';
		let stderr = '';

		wrangler.stdout.on('data', (data) => {
			const chunk = data.toString();
			stdout += chunk;
			process.stdout.write(chunk);
		});

		wrangler.stderr.on('data', (data) => {
			const chunk = data.toString();
			stderr += chunk;
			process.stderr.write(chunk);
		});

		wrangler.on('close', (code) => {
			if (code === 0) {
				resolve(stdout);
			} else {
				reject(new Error(`Wrangler exited with code ${code}: ${stderr}`));
			}
		});

		wrangler.on('error', (err) => {
			reject(new Error(`Failed to spawn wrangler: ${err.message}`));
		});
	});
}

/**
 * Apply a single SQL migration file to D1
 */
async function applyMigration(sqlFile: string, local: boolean): Promise<void> {
	const filePath = join(MIGRATIONS_DIR, sqlFile);
	const dbName = 'arcturus';
	const localFlag = local ? '--local' : '--remote';

	console.log(`Applying migration: ${sqlFile}`);

	const args = ['d1', 'execute', dbName, localFlag, `--file=${filePath}`];
	await executeWrangler(args);
}

/**
 * Main migration function
 */
async function migrate(local = true): Promise<void> {
	console.log(`\n📦 Applying migrations to ${local ? 'LOCAL' : 'REMOTE'} database...\n`);

	const migrations = await getSortedMigrations();

	if (migrations.length === 0) {
		console.log('✅ No SQL migrations to apply.');
		return;
	}

	console.log(
		`Found ${migrations.length} migration file(s):\n${migrations.map((m) => `  - ${m}`).join('\n')}\n`,
	);

	for (const migration of migrations) {
		try {
			await applyMigration(migration, local);
		} catch (error) {
			console.error(`❌ Failed to apply migration ${migration}:`, error);
			process.exit(1);
		}
	}

	console.log(
		`\n✅ Successfully applied ${migrations.length} migration(s) to ${local ? 'local' : 'remote'} database.\n`,
	);
}

// Parse CLI arguments
const args = process.argv.slice(2);
const local = !args.includes('--remote');

// Run migrations
await migrate(local);
