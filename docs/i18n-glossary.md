# i18n Glossary

Editorial vocabulary source for the four-locale localization rollout. This file
does not generate runtime copy; player-facing strings always use complete
sentence templates from `src/lib/i18n/messages/`. Each translation PR appends
newly introduced game-specific canonical terms here before or alongside its
message dictionary so terminology stays consistent across sequential PRs.

| English          | 繁體中文     | 简体中文     | 日本語             |
| ---------------- | ------------ | ------------ | ------------------ |
| Chips            | 籌碼         | 筹码         | チップ             |
| Player           | 玩家         | 玩家         | プレイヤー         |
| Dealer           | 荷官         | 荷官         | ディーラー         |
| Banker           | 莊家         | 庄家         | バンカー           |
| Bet              | 下注         | 下注         | ベット             |
| Wager            | 下注額       | 下注额       | 賭け金             |
| Payout           | 派彩         | 派彩         | 払戻し             |
| Win              | 勝           | 胜           | 勝ち               |
| Loss             | 負           | 负           | 負け               |
| Push             | 和局         | 和局         | 引き分け           |
| Leaderboard      | 排行榜       | 排行榜       | ランキング         |
| Rank             | 名次         | 名次         | 順位               |
| Mission          | 任務         | 任务         | ミッション         |
| Daily Quest      | 每日任務     | 每日任务     | デイリークエスト   |
| Weekly Goal      | 每週目標     | 每周目标     | ウィークリーゴール |
| Streak           | 連續         | 连续         | 連続（ストリーク） |
| Claim            | 領取         | 领取         | 受け取る           |
| Reroll           | 重擲         | 重掷         | 再ロール           |
| Total Wins       | 總勝利數     | 总胜利数     | 総勝利数           |
| Win Rate         | 勝率         | 胜率         | 勝率               |
| Biggest Win      | 最大單局勝利 | 最大单局胜利 | 最大勝利           |
| Net Profit       | 淨收益       | 净收益       | 収支               |
| Percentile       | 百分位       | 百分位       | パーセンタイル     |
| Practice         | 練習         | 练习         | プラクティス       |
| Ranked (attempt) | 排位         | 排位         | ランク戦           |
| Forfeit          | 放棄         | 放弃         | フォーフェイト     |
| Bankroll         | 資金         | 资金         | バンクロール       |

Conventions:

- `Arcturus` stays unchanged as a product/proper name in every locale.
- Usernames, room codes, API/provider/model names, visible card rank glyphs
  (`A`, `K`, `Q`, `J`), and payout ratios such as `3:2` stay language-neutral.
- Game display names come only from `src/lib/i18n/messages/games.ts`.
- Chip amounts always use `formatChips(value, locale)` — chips, never currency.
