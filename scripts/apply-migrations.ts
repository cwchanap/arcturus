#!/usr/bin/env bun
/**
 * Apply all SQL migrations in order to D1 database
 *
 * This script reads all .sql files from the drizzle directory,
 * sorts them by timestamp/number, and applies them sequentially
 * to the specified D1 database (local or remote).
 */

import { readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, '..', 'drizzle');
const SQL_FILE_PATTERN = /^\d+_[a-z0-9_-]+\.sql$/i;
const MIGRATIONS_TABLE = '_migrations';
const DB_NAME = 'arcturus';

function parseWranglerJson<T>(output: string): { results?: T[]; success?: boolean } {
	const parsed = JSON.parse(output) as
		| { results?: T[]; success?: boolean }
		| Array<{
				results?: T[];
				success?: boolean;
		  }>;
	if (Array.isArray(parsed)) {
		return parsed[0] ?? {};
	}
	return parsed;
}

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
 * Get list of tables that exist in the database
 */
async function getExistingTables(local: boolean): Promise<Set<string>> {
	const querySql = `SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB '_*' ORDER BY name`;
	const localFlag = local ? '--local' : '--remote';
	const args = ['d1', 'execute', DB_NAME, localFlag, `--command=${querySql}`, '--json'];

	try {
		const output = await executeWrangler(args);
		const result = parseWranglerJson<{ name: string }>(output);
		const tables = new Set<string>();
		if (result.results) {
			for (const row of result.results) {
				tables.add(row.name);
			}
		}
		return tables;
	} catch (error) {
		console.warn('Warning: Could not query existing tables:', (error as Error).message);
		return new Set<string>();
	}
}

/**
 * Parse SQL file to extract database objects it creates
 * Returns sets of table names, indexes, and columns that would be created
 */
function parseMigrationSql(sqlContent: string): {
	tables: Set<string>;
	indexes: Set<string>;
	columns: Array<{ table: string; column: string }>;
} {
	const tables = new Set<string>();
	const indexes = new Set<string>();
	const columns: Array<{ table: string; column: string }> = [];

	// Match CREATE TABLE statements (handles both "table" and `table` quoting styles)
	const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi;
	let match;
	while ((match = createTableRegex.exec(sqlContent)) !== null) {
		tables.add(match[1]);
	}

	// Match CREATE INDEX statements
	const createIndexRegex =
		/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi;
	while ((match = createIndexRegex.exec(sqlContent)) !== null) {
		indexes.add(match[1]);
	}

	// Match ALTER TABLE ADD COLUMN statements
	const alterColumnRegex =
		/ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi;
	while ((match = alterColumnRegex.exec(sqlContent)) !== null) {
		columns.push({ table: match[1], column: match[2] });
	}

	return { tables, indexes, columns };
}

/**
 * Get list of columns that exist in a specific table
 */
async function getTableColumns(local: boolean, tableName: string): Promise<Set<string>> {
	const querySql = `PRAGMA table_info("${tableName}")`;
	const localFlag = local ? '--local' : '--remote';
	const args = ['d1', 'execute', DB_NAME, localFlag, `--command=${querySql}`, '--json'];

	try {
		const output = await executeWrangler(args);
		const result = parseWranglerJson<{ name: string }>(output);
		const columns = new Set<string>();
		if (result.results) {
			for (const row of result.results) {
				columns.add(row.name);
			}
		}
		return columns;
	} catch (error) {
		console.warn(
			`Warning: Could not query columns for table ${tableName}:`,
			(error as Error).message,
		);
		return new Set<string>();
	}
}

/**
 * Get list of indexes that exist in the database
 */
async function getExistingIndexes(local: boolean): Promise<Set<string>> {
	const querySql = `SELECT name FROM sqlite_master WHERE type='index' AND name NOT GLOB '_*' ORDER BY name`;
	const localFlag = local ? '--local' : '--remote';
	const args = ['d1', 'execute', DB_NAME, localFlag, `--command=${querySql}`, '--json'];

	try {
		const output = await executeWrangler(args);
		const result = parseWranglerJson<{ name: string }>(output);
		const indexes = new Set<string>();
		if (result.results) {
			for (const row of result.results) {
				indexes.add(row.name);
			}
		}
		return indexes;
	} catch (error) {
		console.warn('Warning: Could not query existing indexes:', (error as Error).message);
		return new Set<string>();
	}
}

/**
 * Check if a migration's database objects already exist
 * This is used for backfilling migration tracking on existing databases
 * Parses the actual SQL file to determine what objects it creates
 */
async function isMigrationApplied(
	migrationFile: string,
	existingTables: Set<string>,
	local: boolean,
): Promise<boolean> {
	// Read and parse the SQL file to determine what it creates
	const filePath = join(MIGRATIONS_DIR, migrationFile);
	let sqlContent: string;
	try {
		sqlContent = await readFile(filePath, 'utf-8');
	} catch {
		// If file doesn't exist or can't be read, assume not applied
		console.warn(`Warning: Could not read migration file ${migrationFile}`);
		return false;
	}

	const { tables, indexes, columns } = parseMigrationSql(sqlContent);

	// If migration creates no tables, indexes, or columns, we can't determine status
	// In this case, rely on the _migrations table tracking
	if (tables.size === 0 && indexes.size === 0 && columns.length === 0) {
		return false;
	}

	// Check if all tables created by this migration exist
	for (const table of tables) {
		if (!existingTables.has(table)) {
			return false;
		}
	}

	// Check if all indexes created by this migration exist
	if (indexes.size > 0) {
		const existingIndexes = await getExistingIndexes(local);
		for (const index of indexes) {
			if (!existingIndexes.has(index)) {
				return false;
			}
		}
	}

	// Check if all columns added by this migration exist
	for (const { table, column } of columns) {
		const tableColumns = await getTableColumns(local, table);
		if (!tableColumns.has(column)) {
			return false;
		}
	}

	// All objects exist, migration is applied
	return true;
}

/**
 * Get list of already applied migrations from the database
 */
async function getAppliedMigrations(local: boolean): Promise<Set<string>> {
	const querySql = `SELECT name FROM "${MIGRATIONS_TABLE}" ORDER BY appliedAt ASC`;
	const localFlag = local ? '--local' : '--remote';
	const args = ['d1', 'execute', DB_NAME, localFlag, `--command=${querySql}`, '--json'];

	try {
		const output = await executeWrangler(args);
		// Parse JSON output from wrangler
		const result = parseWranglerJson<{ name: string }>(output);
		const applied = new Set<string>();
		if (result.results) {
			for (const row of result.results) {
				applied.add(row.name);
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
async function recordMigrationApplied(
	migration: string,
	local: boolean,
	appliedAt: number = Date.now(),
): Promise<void> {
	if (!SQL_FILE_PATTERN.test(migration)) {
		throw new Error(`Invalid migration name: ${migration}`);
	}
	const escapedMigration = migration.replaceAll("'", "''");
	const insertSql = `INSERT INTO "${MIGRATIONS_TABLE}" (name, appliedAt) VALUES ('${escapedMigration}', ${appliedAt})`;
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

const WRANGLER_TIMEOUT_MS = Number(process.env.WRANGLER_TIMEOUT_MS) || 60_000;

/**
 * Execute wrangler command and return output
 */
async function executeWrangler(
	args: string[],
	timeoutMs: number = WRANGLER_TIMEOUT_MS,
): Promise<string> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const wrangler = spawn('wrangler', args, { stdio: 'pipe' });
		let stdout = '';
		let stderr = '';

		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				wrangler.kill();
				reject(new Error(`Wrangler timed out after ${timeoutMs}ms. Args: ${args.join(' ')}`));
			}
		}, timeoutMs);

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
			clearTimeout(timer);
			if (settled) return;
			settled = true;
			if (code === 0) {
				resolve(stdout);
			} else {
				reject(new Error(`Wrangler exited with code ${code}: ${stderr}`));
			}
		});

		wrangler.on('error', (err) => {
			clearTimeout(timer);
			if (settled) return;
			settled = true;
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

	const args = ['d1', 'execute', DB_NAME, localFlag, `--file=${filePath}`, '--json'];
	try {
		await executeWrangler(args);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (
			/duplicate column name|already exists|table .* already exists|index .* already exists/i.test(
				message,
			)
		) {
			console.warn(
				`⚠ Migration ${sqlFile} hit "already exists" error: ${message}\n` +
					`  This may indicate a partially-applied migration. Review the schema manually.`,
			);
			throw error;
		}
		throw error;
	}
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

	// Get existing tables for backfill detection
	const existingTables = await getExistingTables(local);

	const allMigrations = await getSortedMigrations();

	// Backfill: If _migrations table is empty but tables exist, mark relevant migrations as applied
	// This handles the case where the database was migrated before this tracking system was added
	if (appliedMigrations.size === 0 && existingTables.size > 0) {
		console.log('🔍 Detected existing database - backfilling migration tracking...');
		let backfillCount = 0;
		for (const migration of allMigrations) {
			if (await isMigrationApplied(migration, existingTables, local)) {
				try {
					await recordMigrationApplied(migration, local);
					appliedMigrations.add(migration);
					backfillCount++;
					console.log(`  ✓ Backfilled migration: ${migration}`);
				} catch (error) {
					console.warn(`  ⚠ Failed to backfill ${migration}:`, (error as Error).message);
				}
			}
		}
		if (backfillCount > 0) {
			console.log(`✅ Backfilled ${backfillCount} migration(s)\n`);
		} else {
			console.log('ℹ No migrations to backfill\n');
		}
	}

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
			const appliedAt = Date.now();
			// Apply migration
			await applyMigration(migration, local);

			// Record migration as applied
			// Note: Cloudflare D1 via wrangler CLI doesn't support multi-statement transactions.
			// If recording fails after a successful migration apply, the migration is in the database
			// but not tracked. In this case, you'll need to manually add it to the _migrations table.
			try {
				await recordMigrationApplied(migration, local, appliedAt);
			} catch (recordError) {
				// Migration was applied but we couldn't record it
				console.error('');
				console.error('⚠️  WARNING: Migration was applied but tracking record failed!');
				console.error(`⚠️  Migration: ${migration}`);
				console.error(`⚠️  Error recording: ${(recordError as Error).message}`);
				console.error('');
				console.error('📋 MANUAL RECOVERY REQUIRED:');
				console.error(`   Run this command to manually mark the migration as applied:`);
				console.error(
					`   wrangler d1 execute ${DB_NAME} ${local ? '--local' : '--remote'} --command="INSERT INTO ${MIGRATIONS_TABLE} (name, appliedAt) VALUES ('${migration}', ${appliedAt})"`,
				);
				console.error('');
				process.exit(1);
			}
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
