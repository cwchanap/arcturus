/// <reference types="@cloudflare/workers-types" />

// Declare bun:test module for test files
declare module 'bun:test' {
	export function describe(name: string, fn: () => void | Promise<void>): void;
	export function test(name: string, fn: () => void | Promise<void>): void;
	export function beforeEach(fn: () => void | Promise<void>): void;
	export function afterEach(fn: () => void | Promise<void>): void;
	export function expect<T>(actual: T): {
		toBe: (value: T) => void;
		toEqual: (value: unknown) => void;
		toBeNull: () => void;
		toBeDefined: () => void;
		toBeTruthy: () => void;
		toBeFalsy: () => void;
		toBeGreaterThan: (value: number) => void;
		toBeLessThan: (value: number) => void;
		toContain: (value: unknown) => void;
		not: {
			toBe: (value: unknown) => void;
			toEqual: (value: unknown) => void;
			toContain: (value: unknown) => void;
		};
		toThrow: (message?: string | RegExp | Error) => void;
		toHaveLength: (length: number) => void;
	};
}

interface Env {
	DB: D1Database;
	BETTER_AUTH_SECRET?: string;
}

declare namespace App {
	interface Locals {
		runtime: {
			env: Env;
			cf: CfProperties;
			ctx: ExecutionContext;
		};
		session?: {
			user: {
				id: string;
				name: string;
				email: string;
				emailVerified: boolean;
				image?: string | null;
				chipBalance: number;
				createdAt: Date;
				updatedAt: Date;
			};
			session: {
				id: string;
				userId: string;
				expiresAt: Date;
				token: string;
				ipAddress?: string | null;
				userAgent?: string | null;
				createdAt: Date;
				updatedAt: Date;
			};
		} | null;
		user?: {
			id: string;
			name: string;
			email: string;
			emailVerified: boolean;
			image?: string | null;
			chipBalance: number;
			createdAt: Date;
			updatedAt: Date;
		} | null;
	}
}
