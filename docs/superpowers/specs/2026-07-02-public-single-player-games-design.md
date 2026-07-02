# Public Single-Player Games Design

## Goal

Make Arcturus single-player casino games playable without sign-in while preserving existing
account-backed chip balance, stats, achievements, and LLM/profile behavior for signed-in users.

## Scope

Public guest play applies to these single-player routes:

- `/games/poker`
- `/games/blackjack`
- `/games/baccarat`
- `/games/craps`

Authenticated-only behavior remains for:

- `/games/poker-mp`
- `/games/poker-mp/[code]`
- `/games/leaderboard`
- `/missions/daily`
- `/profile`

Multiplayer poker stays authenticated because seats, room identity, and server-authoritative
state depend on a stable user identity.

## Guest Mode Behavior

When `Astro.locals.user` is absent, each single-player game route renders instead of redirecting
to `/signin`.

Guest pages receive:

- A local starting chip balance, using the existing game default where available.
- A stable marker such as `data-guest-mode="true"` on the game root or balance element.
- No real `data-user-id`.
- Copy that makes the balance clearly local or guest-only where the UI exposes account balance.

Guest balance changes stay in the browser runtime only. Guests can refresh and lose progress;
that is acceptable for this scope.

## Signed-In Behavior

When a user is signed in, existing behavior is preserved:

- Routes render with account chip balance.
- Client code continues calling `/api/chips/update`.
- Stats, achievements, optimistic balance reconciliation, and rate-limit handling remain active.
- LLM profile settings keep loading from `/api/profile/llm-settings`.

## Balance Sync

`/api/chips/update` remains authenticated and unchanged. Guest clients must not call it.

Each game client should branch on the page's guest marker before attempting server chip sync:

- Guest mode: skip the sync call, keep local game balance, and avoid sync failure copy.
- Signed-in mode: run the current sync path.

Poker already tolerates missing server balance by skipping sync; its route should render a
playable guest starting balance instead of the current non-playable unavailable state.

Blackjack, baccarat, and craps currently assume authenticated sync after completed rounds. They
need explicit guest-mode guards around sync calls so guest play does not produce unauthenticated
API errors or revert to stale server balances.

## Account-Only Features

Profile-backed features should degrade without blocking gameplay:

- LLM/profile settings calls may return unauthenticated responses; clients should treat that as
  "not configured".
- Links to profile configuration can remain visible, but they may lead to sign-in.
- Mission and leaderboard progress remains signed-in only.

## Testing

Add regression coverage for public route access and guest sync behavior:

- Single-player routes return `200` without an authenticated session.
- Multiplayer poker routes still redirect unauthenticated users to `/signin`.
- At least one browser smoke path proves a guest can open a game page and reach a playable
  control state without auth.
- Focused client tests, where existing test seams make this practical, verify guest mode skips
  `/api/chips/update`.

Existing authenticated tests should continue to pass so account-backed play is not regressed.
