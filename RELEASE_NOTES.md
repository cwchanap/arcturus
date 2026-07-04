# Release Notes

## Unreleased

### Poker

- **Guest rebuy button no longer shown to authenticated users.** The rebuy button previously appeared for any busted player (chips === 0) but was a no-op for signed-in players since their chip balance lives on the server. It is now gated on guest mode; authenticated zero-balance players see "Game Over" and must top up via missions or other server-side flows.
- **`pendingChipSyncs` localStorage key now derives from the hashed user ID** (commit `239ed0e`). Authenticated users who had unsynced chip deltas queued in `localStorage` under the old key at deploy time will have those keys orphaned. This is harmless: the server chip balance remains authoritative and the queue is only a best-effort retry buffer. No migration action is required; orphaned keys can be ignored (they are never read by the new code path).
