/// <reference types="@cloudflare/workers-types" />

// Declare bun:test module for test files
declare module 'bun:test' {
	export function describe(name: string, fn: () => void): void;
	export function test(name: string, fn: () => void): void;
	export function beforeEach(fn: () => void): void;
	export function afterEach(fn: () => void): void;
	export const expect: {
		toBe: (value: any) => any;
		toEqual: (value: any) => any;
		toBeNull: () => any;
		toBeDefined: () => any;
		toBeTruthy: () => any;
		toBeFalsy: () => any;
		toBeGreaterThan: (value: number) => any;
		toBeLessThan: (value: number) => any;
		toContain: (value: any) => any;
		not: {
			toBe: (value: any) => any;
			toEqual: (value: any) => any;
			Contain: (value: any) => any;
		};
		toThrow: (message?: string) => any;
		toHaveLength: (length: number) => any;
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
