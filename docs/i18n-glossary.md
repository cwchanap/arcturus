# i18n Glossary

Editorial vocabulary source for the four-locale localization rollout. This file
does not generate runtime copy; player-facing strings always use complete
sentence templates from `src/lib/i18n/messages/`. Each translation PR appends
newly introduced game-specific canonical terms here before or alongside its
message dictionary so terminology stays consistent across sequential PRs.

| English     | 繁體中文 | 简体中文 | 日本語     |
| ----------- | -------- | -------- | ---------- |
| Chips       | 籌碼     | 筹码     | チップ     |
| Player      | 玩家     | 玩家     | プレイヤー |
| Dealer      | 荷官     | 荷官     | ディーラー |
| Banker      | 莊家     | 庄家     | バンカー   |
| Bet         | 下注     | 下注     | ベット     |
| Wager       | 下注額   | 下注额   | 賭け金     |
| Payout      | 派彩     | 派彩     | 払戻し     |
| Win         | 勝       | 胜       | 勝ち       |
| Loss        | 負       | 负       | 負け       |
| Push        | 和局     | 和局     | 引き分け   |
| Leaderboard | 排行榜   | 排行榜   | ランキング |
| Rank        | 名次     | 名次     | 順位       |

Conventions:

- `Arcturus` stays unchanged as a product/proper name in every locale.
- Usernames, room codes, API/provider/model names, visible card rank glyphs
  (`A`, `K`, `Q`, `J`), and payout ratios such as `3:2` stay language-neutral.
- Game display names come only from `src/lib/i18n/messages/games.ts`.
- Chip amounts always use `formatChips(value, locale)` — chips, never currency.
