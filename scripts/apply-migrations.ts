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
const MIGRATIONS_TABLE = '_migrations';
const DB_NAME = 'arcturus';

/**
 * Initialize the migrations tracking table
 */
async function initMigrationsTable(local: boolean): Promise<void> {
	const createTableSql = `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (
		"name" TEXT PRIMARY KEY NOT NULL,
		"appliedAt" INTEGER NOT NULL
	)`;
	const localFlag = local ? '--local' : '--remote';
	const args = ['d1', 'execute', DB_NAME, localFlag, `--command=${createTableSql}`];
	await executeWrangler(args);
}

/**
 * Get list of already applied migrations from the database
 */
async function getAppliedMigrations(local: boolean): Promise<Set<string>> {
	const querySql = `SELECT name FROM "${MIGRATIONS_TABLE}" ORDER BY appliedAt ASC`;
	const localFlag = local ? '--local' : '--remote';
	const args = ['d1', 'execute', DB_NAME, localFlag, `--command=${querySql}`];

	try {
		const output = await executeWrangler(args);
		// Parse the output to extract migration names
		// The output format is typically: name\n------\n0000_name.sql\n0001_name.sql
		const lines = output.split('\n');
		const applied = new Set<string>();
		let inDataSection = false;

		for (const line of lines) {
			if (line.trim() === 'name') {
				inDataSection = true;
				continue;
			}
			if (line.startsWith('---')) {
				continue;
			}
			if (inDataSection && line.trim()) {
				applied.add(line.trim());
			}
		}
		return applied;
	} catch (error) {
		// If table doesn't exist yet, return empty set
		const errorMsg = (error as Error).message || '';
		if (errorMsg.includes('no such table') || errorMsg.includes('SQL logic error')) {
			return new Set<string>();
		}
		throw error;
	}
}

/**
 * Record a migration as applied in the tracking table
 */
async function recordMigrationApplied(migration: string, local: boolean): Promise<void> {
	const insertSql = `INSERT INTO "${MIGRATIONS_TABLE}" (name, appliedAt) VALUES ('${migration}', ${Date.now()})`;
	const localFlag = local ? '--local' : '--remote';
	const args = ['d1', 'execute', DB_NAME, localFlag, `--command=${insertSql}`];
	await executeWrangler(args);
}

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
	const localFlag = local ? '--local' : '--remote';

	console.log(`Applying migration: ${sqlFile}`);

	const args = ['d1', 'execute', DB_NAME, localFlag, `--file=${filePath}`];
	await executeWrangler(args);
}

/**
 * Main migration function
 */
async function migrate(local = true): Promise<void> {
	console.log(`\n📦 Applying migrations to ${local ? 'LOCAL' : 'REMOTE'} database...\n`);

	// Initialize migrations tracking table
	await initMigrationsTable(local);

	// Get list of applied migrations
	const appliedMigrations = await getAppliedMigrations(local);
	console.log(`Applied migrations: ${appliedMigrations.size || 'none'}`);

	const allMigrations = await getSortedMigrations();

	if (allMigrations.length === 0) {
		console.log('✅ No SQL migrations to apply.');
		return;
	}

	// Filter out already applied migrations
	const pendingMigrations = allMigrations.filter((m) => !appliedMigrations.has(m));

	if (pendingMigrations.length === 0) {
		console.log('✅ All migrations are already applied.');
		return;
	}

	console.log(
		`Found ${pendingMigrations.length} pending migration(s) out of ${allMigrations.length} total:\n${pendingMigrations.map((m) => `  - ${m}`).join('\n')}\n`,
	);

	let appliedCount = 0;
	for (const migration of pendingMigrations) {
		try {
			await applyMigration(migration, local);
			await recordMigrationApplied(migration, local);
			appliedCount++;
		} catch (error) {
			console.error(`❌ Failed to apply migration ${migration}:`, error);
			process.exit(1);
		}
	}

	console.log(
		`\n✅ Successfully applied ${appliedCount} migration(s) to ${local ? 'local' : 'remote'} database.\n`,
	);
}

// Parse CLI arguments
const args = process.argv.slice(2);
const local = !args.includes('--remote');

// Run migrations
await migrate(local);
