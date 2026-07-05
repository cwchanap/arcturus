# Release Notes

## Unreleased

### Guest Play (Public Single-Player Games)

- **All single-player games (poker, blackjack, baccarat, craps) now render for unauthenticated visitors.** Guests get a default `$1,000` bankroll persisted to `localStorage` under a per-game, per-user key (`{gameKey}-bankroll:{clientUserId}`). No server account or chip sync occurs in guest mode; the LLM advisor/AI-rival features are disabled and their settings controls are gated off. Sign-in is still required for multiplayer poker and for persisting chips to a server account.
- **Client-side user identifiers are opaque.** Guests render as `anonymous`; authenticated users render a non-reversible FNV-1a hash surrogate (`u_<base36>`) into `data-user-id` attributes and `localStorage` keys. The raw account id is never exposed in the DOM. This is a keying primitive, not a security boundary (32-bit hash; revisit at scale).

### Poker

- **Per-opponent AI difficulty controls.** Player 2 and Player 3 each have a difficulty select (Easy / Medium / Hard / Expert) wired through `aiDifficulty` profiles, board-texture classification, a closed-form visible-equity estimate, and stack-aware bet sizing. The non-LLM AI no longer uses a single global personality; difficulty changes both preflop ranges and postflop aggression/bluff frequency. Settings persist per game and are validated on load.
- **Guest rebuy button no longer shown to authenticated users.** The rebuy button previously appeared for any busted player (chips === 0) but was a no-op for signed-in players since their chip balance lives on the server. It is now gated on guest mode; authenticated zero-balance players see "Game Over" and must top up via missions or other server-side flows.
- **`pendingChipSyncs` localStorage key now derives from the hashed user ID** (commit `239ed0e`). Authenticated users who had unsynced chip deltas queued in `localStorage` under the old key at deploy time will have those keys orphaned. This is harmless: the server chip balance remains authoritative and the queue is only a best-effort retry buffer. No migration action is required; orphaned keys can be ignored (they are never read by the new code path).
