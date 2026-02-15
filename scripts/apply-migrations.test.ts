/**
 * Migration Script Unit Tests
 *
 * Tests for migration parsing and backfill detection logic.
 */

import { describe, expect, test } from 'bun:test';
import { parseMigrationSql } from './apply-migrations';

describe('parseMigrationSql', () => {
	test('extracts table names from CREATE TABLE statements', () => {
		const sql = `
			CREATE TABLE "user" (
				"id" text PRIMARY KEY NOT NULL,
				"email" text NOT NULL
			);
			CREATE TABLE game_stats (
				userId text NOT NULL,
				totalWins integer DEFAULT 0
			);
		`;
		const result = parseMigrationSql(sql);
		expect(result.tables.has('user')).toBe(true);
		expect(result.tables.has('game_stats')).toBe(true);
		expect(result.tables.size).toBe(2);
	});

	test('ignores transient __new_* tables from SQLite migrations', () => {
		const sql = `
			CREATE TABLE __new_game_stats (
				userId text NOT NULL,
				totalWins integer DEFAULT 0
			);
			INSERT INTO __new_game_stats SELECT * FROM game_stats;
			DROP TABLE game_stats;
			ALTER TABLE __new_game_stats RENAME TO game_stats;
		`;
		const result = parseMigrationSql(sql);
		expect(result.tables.has('__new_game_stats')).toBe(false);
		expect(result.tables.has('game_stats')).toBe(true);
		expect(result.tables.size).toBe(1);
	});

	test('ignores transient __old_* tables', () => {
		const sql = `
			CREATE TABLE __old_user_backup (
				id text PRIMARY KEY
			);
			CREATE TABLE permanent_table (
				value text
			);
		`;
		const result = parseMigrationSql(sql);
		expect(result.tables.has('__old_user_backup')).toBe(false);
		expect(result.tables.has('permanent_table')).toBe(true);
		expect(result.tables.size).toBe(1);
	});

	test('ignores sqlite_* internal tables', () => {
		const sql = `
			CREATE TABLE sqlite_sequence (
				name TEXT,
				seq INTEGER
			);
			CREATE TABLE actual_table (
				id text PRIMARY KEY
			);
		`;
		const result = parseMigrationSql(sql);
		expect(result.tables.has('sqlite_sequence')).toBe(false);
		expect(result.tables.has('actual_table')).toBe(true);
		expect(result.tables.size).toBe(1);
	});

	test('handles mixed transient and persistent tables from migration 0004', () => {
		const sql = `
			PRAGMA foreign_keys=OFF;
			CREATE TABLE \`__new_game_stats\` (
				\`userId\` text NOT NULL,
				\`gameType\` text NOT NULL,
				PRIMARY KEY(\`userId\`, \`gameType\`)
			);
			INSERT INTO \`__new_game_stats\`("userId", "gameType") SELECT "userId", "gameType" FROM \`game_stats\`;
			DROP TABLE \`game_stats\`;
			ALTER TABLE \`__new_game_stats\` RENAME TO \`game_stats\`;
			CREATE TABLE \`__new_user_achievement\` (
				\`userId\` text NOT NULL,
				\`achievementId\` text NOT NULL
			);
			INSERT INTO \`__new_user_achievement\` SELECT * FROM \`user_achievement\`;
			DROP TABLE \`user_achievement\`;
			ALTER TABLE \`__new_user_achievement\` RENAME TO \`user_achievement\`;
		`;
		const result = parseMigrationSql(sql);
		// Should only have the final persistent tables, not the __new_* temp tables
		expect(result.tables.has('__new_game_stats')).toBe(false);
		expect(result.tables.has('__new_user_achievement')).toBe(false);
		// The backfill detector will check for these tables
		expect(result.tables.has('game_stats')).toBe(true);
		expect(result.tables.has('user_achievement')).toBe(true);
		expect(result.tables.size).toBe(2);
	});

	test('extracts index names from CREATE INDEX statements', () => {
		const sql = `
			CREATE INDEX user_email_idx ON user (email);
			CREATE UNIQUE INDEX user_name_idx ON user (name);
			CREATE INDEX IF NOT EXISTS "game_stats_idx" ON game_stats (userId);
		`;
		const result = parseMigrationSql(sql);
		expect(result.indexes.has('user_email_idx')).toBe(true);
		expect(result.indexes.has('user_name_idx')).toBe(true);
		expect(result.indexes.has('game_stats_idx')).toBe(true);
		expect(result.indexes.size).toBe(3);
	});

	test('extracts columns from ALTER TABLE ADD COLUMN statements', () => {
		const sql = `
			ALTER TABLE user ADD COLUMN chipBalance integer DEFAULT 0;
			ALTER TABLE "game_stats" ADD COLUMN "newField" text;
		`;
		const result = parseMigrationSql(sql);
		expect(result.columns).toContainEqual({ table: 'user', column: 'chipBalance' });
		expect(result.columns).toContainEqual({ table: 'game_stats', column: 'newField' });
		expect(result.columns.length).toBe(2);
	});

	test('handles empty SQL', () => {
		const result = parseMigrationSql('');
		expect(result.tables.size).toBe(0);
		expect(result.indexes.size).toBe(0);
		expect(result.columns.length).toBe(0);
	});

	test('handles SQL with comments only', () => {
		const sql = `
			-- This is a comment
			/* Multi-line
			   comment */
		`;
		const result = parseMigrationSql(sql);
		expect(result.tables.size).toBe(0);
		expect(result.indexes.size).toBe(0);
		expect(result.columns.length).toBe(0);
	});
});
