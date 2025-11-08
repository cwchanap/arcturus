import { sql } from 'drizzle-orm';

type MigrationContext = {
	run: (query: ReturnType<typeof sql>) => Promise<unknown> | unknown;
};

export async function up(db: MigrationContext) {
	await db.run(sql`
    CREATE TABLE IF NOT EXISTS "llm_settings" (
      "userId" text PRIMARY KEY NOT NULL,
      "provider" text DEFAULT 'openai' NOT NULL,
      "model" text DEFAULT 'gpt-4o' NOT NULL,
      "openaiApiKey" text,
      "geminiApiKey" text,
      "createdAt" integer NOT NULL,
      "updatedAt" integer NOT NULL,
      FOREIGN KEY ("userId") REFERENCES "user"("id") ON UPDATE no action ON DELETE no action
    );
  `);
}

export async function down(db: MigrationContext) {
	await db.run(sql`DROP TABLE IF EXISTS "llm_settings";`);
}
