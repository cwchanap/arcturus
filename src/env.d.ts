/// <reference types="@cloudflare/workers-types" />

interface Env {
	DB: D1Database;
	BETTER_AUTH_SECRET?: string;
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
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
			createdAt: Date;
			updatedAt: Date;
		} | null;
	}
}
