import { sql } from 'drizzle-orm';

type MigrationContext = {
	run: (query: ReturnType<typeof sql>) => Promise<unknown> | unknown;
};

export async function up(db: MigrationContext) {
	await db.run(sql`
		CREATE TABLE IF NOT EXISTS "mission" (
			"missionId" text NOT NULL,
			"userId" text NOT NULL,
			"completedDate" integer,
			PRIMARY KEY("userId", "missionId"),
			FOREIGN KEY ("userId") REFERENCES "user"("id") ON UPDATE no action ON DELETE no action
		);
	`);

	await db.run(sql`ALTER TABLE "user" ADD COLUMN "chipBalance" integer DEFAULT 10000 NOT NULL;`);
}

export async function down(db: MigrationContext) {
	await db.run(sql`DROP TABLE IF EXISTS "mission";`);
	await db.run(sql`ALTER TABLE "user" DROP COLUMN "chipBalance";`);
}
