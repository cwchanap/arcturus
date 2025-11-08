import { sql } from 'drizzle-orm';

type MigrationContext = {
	run: (query: ReturnType<typeof sql>) => Promise<unknown> | unknown;
};

export async function up(db: MigrationContext) {
	await db.run(sql`
    CREATE TABLE IF NOT EXISTS "account" (
      "id" text PRIMARY KEY NOT NULL,
      "accountId" text NOT NULL,
      "providerId" text NOT NULL,
      "userId" text NOT NULL,
      "accessToken" text,
      "refreshToken" text,
      "idToken" text,
      "accessTokenExpiresAt" integer,
      "refreshTokenExpiresAt" integer,
      "scope" text,
      "password" text,
      "createdAt" integer NOT NULL,
      "updatedAt" integer NOT NULL,
      FOREIGN KEY ("userId") REFERENCES "user"("id") ON UPDATE no action ON DELETE no action
    );
  `);

	await db.run(sql`
    CREATE TABLE IF NOT EXISTS "session" (
      "id" text PRIMARY KEY NOT NULL,
      "expiresAt" integer NOT NULL,
      "token" text NOT NULL,
      "createdAt" integer NOT NULL,
      "updatedAt" integer NOT NULL,
      "ipAddress" text,
      "userAgent" text,
      "userId" text NOT NULL,
      FOREIGN KEY ("userId") REFERENCES "user"("id") ON UPDATE no action ON DELETE no action
    );
  `);

	await db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "session_token_unique" ON "session" ("token");
  `);

	await db.run(sql`
    CREATE TABLE IF NOT EXISTS "user" (
      "id" text PRIMARY KEY NOT NULL,
      "name" text NOT NULL,
      "email" text NOT NULL,
      "emailVerified" integer NOT NULL,
      "image" text,
      "createdAt" integer NOT NULL,
      "updatedAt" integer NOT NULL
    );
  `);

	await db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "user_email_unique" ON "user" ("email");
  `);

	await db.run(sql`
    CREATE TABLE IF NOT EXISTS "verification" (
      "id" text PRIMARY KEY NOT NULL,
      "identifier" text NOT NULL,
      "value" text NOT NULL,
      "expiresAt" integer NOT NULL,
      "createdAt" integer,
      "updatedAt" integer
    );
  `);
}

export async function down(db: MigrationContext) {
	await db.run(sql`DROP TABLE IF EXISTS "verification";`);
	await db.run(sql`DROP INDEX IF EXISTS "user_email_unique";`);
	await db.run(sql`DROP TABLE IF EXISTS "user";`);
	await db.run(sql`DROP INDEX IF EXISTS "session_token_unique";`);
	await db.run(sql`DROP TABLE IF EXISTS "session";`);
	await db.run(sql`DROP TABLE IF EXISTS "account";`);
}
