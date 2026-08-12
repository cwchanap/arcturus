CREATE TABLE wallet_settlement (
  userId TEXT NOT NULL,
  settlementId TEXT NOT NULL,
  attemptId TEXT NOT NULL,
  balance INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY (userId, settlementId),
  FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX wallet_settlement_created_idx ON wallet_settlement(createdAt);
--> statement-breakpoint
DROP TABLE IF EXISTS chip_sync_receipt;
--> statement-breakpoint
DROP TABLE IF EXISTS roulette_round;
