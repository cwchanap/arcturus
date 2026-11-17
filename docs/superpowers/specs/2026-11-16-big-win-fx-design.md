# HPA-728 — Big-win celebration assets: design specification

**Linear:** https://linear.app/cwchanap/issue/HPA-728/assets-big-win-celebration-sprites-and-sfx  
**Plan:** [2026-11-16-big-win-fx.md](../plans/2026-11-16-big-win-fx.md)  
**PR:** [#89](https://github.com/cwchanap/arcturus/pull/89), **one PR for this asset ticket**. [HPA-729](https://linear.app/cwchanap/issue/HPA-729/all-games-big-win-celebration) separately owns runtime integration and stays blocked until these assets land.

## Goal and repository references

Supply seven original, lightweight painted Art Deco effects matching the current dark-green/gold poker look. No animation/gameplay, UI/runtime code, CSS, database, APIs, dependencies, new asset pipeline or compatibility work belongs in HPA-728.

- `public/images/poker/pot-chips.webp`: 128 × 128 transparent **chip pile** (~5.4 KB), a painting reference, **not** the requested single-chip particle.
- `public/images/poker/emblem.webp`: 128 × 128 transparent ornament; `felt.webp`: 768 × 512 felt background under dark overlay; `card-back.webp`: 256 × 384. Existing poker gold is `#e4c988` in `src/styles/poker.css`.
- `src/components/PokerChip.astro` draws CSS circles, not the requested painted particles.
- `src/lib/poker/sound.ts` currently synthesizes `chips`, `allIn`, `win` and `bigWin` (default master gain 0.6). `src/lib/poker/PokerGame.ts` already plays `this.sound.play(big ? 'bigWin' : 'win')` for qualifying hands. Preserve this implementation in HPA-728; reconcile overlapping audio during HPA-729.
- Linear provides **no UI mockup**; compare temporary preview screenshots with the existing table.

## Seven-file contract

| Final path | Content | Target |
| --- | --- | --- |
| `public/images/fx/chip-gold.webp` | Top-down gold single casino chip, painted bevel, true-alpha outside silhouette | 128 × 128 WebP |
| `public/images/fx/chip-red.webp` | Matching red chip, same silhouette/rim/light/padding | 128 × 128 WebP |
| `public/images/fx/chip-blue.webp` | Matching sapphire-blue chip | 128 × 128 WebP |
| `public/images/fx/sparkle.webp` | Small metallic four-point glint with true alpha | 128 × 128 WebP |
| `public/images/fx/big-win-ribbon.webp` | Gold Art Deco ribbon with quiet central band, true-alpha outside silhouette, **no baked text** | ~960 px wide WebP, flexible ~280–320 px height |
| `public/audio/fx/coin-shower.mp3` | Clean cascading chip clicks, decaying tail | ~1.5 s, mono 44.1 kHz MP3, ≤100 KB |
| `public/audio/fx/big-win-sting.mp3` | Short original celebratory fanfare, clean ending | ~2.0 s, mono 44.1 kHz MP3, ≤100 KB |

**Five WebPs together:** target **~100 KB or less**. Only these finished assets are committed; generated masters, WAVs, screenshots, mixed preview and prompts stay outside Git.

## Art direction and mobile layout

- Painted premium casino style, dark edges and restrained gold highlights; avoid flat emoji, stock art, neon, logos, numbers, letters or solid rectangular backgrounds. Make the gold chip master once, then recolor/redraw red and blue to preserve consistent framing. Check at **24, 32 and 48 CSS px** on felt.
- **Pre-generation ribbon constraint:** the uninterrupted text-safe *central band* must cover at least **~55% of the image's width and height**. Allow ~960 × 280–320 instead of forcing 960 × 240 so the title and chip count have vertical room when scaled to a ~340 px mobile content width. Do not let ornaments cross the safe band.
- The title (translated HTML in `en`, `zh-Hant`, `zh-Hans` and `ja`) and count-up are **not baked into** the ribbon. After exporting, record the actual safe-area rectangle `(x, y, width, height)` in native pixels for HPA-729; confirm stacked overlays fit in desktop and phone previews.
- All chip/glint/ribbon outer corners should actually be transparent; allow space for rotating particle sprites. The ribbon must not occupy the entire phone viewport.

## Sound contract and handoff

- Keep chip transients intact. Measure the decoded final audio with `ffmpeg volumedetect` (or `ebur128`), then apply **fixed linear gain** with `ffmpeg -af volume=<dB>dB` as needed. Do **not** prescribe single-pass `loudnorm` for ~1.5-second transient clips or force an unreliable short-clip LUFS reading.
- As an initial headroom guide, keep individual true peaks around **≤−6 dBTP**, then render the **actual combined pair**, with shower and sting starting together (`amix=inputs=2:duration=longest:normalize=0`). Verify the composite **≤−1 dBTP**, lowering inputs if needed. The sum, not either isolated peak, determines clipping risk. Measure after MP3 encoding; verify no pops or clipped tails with a decoder.
- HPA-729's **huge** tier plays both sounds simultaneously; preserve moderate loudness alongside existing table cues. An optional real-device listening comparison against the existing poker `bigWin` cue is a quality check, **not** a substitute for measured peaks.
- **HPA-729 handoff:** suppress or route the existing `PokerGame.ts` synthesized `bigWin` where the new effect already plays, without losing sound on other winning outcomes; update `sound.ts`'s now-stale “no audio files ship” header. No source changes in HPA-728.

## Preview delivery and acceptance

The Linear issue requires preview feedback **before committing final binaries**. Create **one** plain scratch HTML preview outside the repo showing each sprite on existing felt and stacked localized HTML title/count; capture 1280 × 800 and 375 × 812 screenshots. Prepare both individual MP3s and optionally a mixed MP3 **as preview only**. Use Linear's native `prepare_attachment_upload` → raw-byte PUT → `create_attachment_from_upload` workflow to attach screenshots/audio to **HPA-728 Resources**, then place a preview summary/comment on HPA-728 and a link to it in PR #89. GitHub's Markdown comment API cannot upload binary files. The requested feedback/go-ahead on the Linear preview is a **pre-commit workflow checkpoint**, not an end-to-end test.

**Technical completion criteria (automated):**

- [ ] The exact seven fixed assets are committed to PR #89, within size budgets and with no application/dependency changes.
- [ ] One-off `webpinfo`/Pillow checks validate WebP, dimensions, alpha and transparent outer pixels; `ffprobe`/`ffmpeg`/`afinfo` validate codec, mono/sample rate, approximate durations, final decoded playback and the summed true peak.
- [ ] **Browser MCP visual end-to-end** exercises the single scratch preview (one platform sufficient): takes desktop/phone screenshots, checks small sprite readability, alpha, table-style consistency, and that the four locale title/count overlays fit within the safe band. This is the **visual screenshot acceptance** in the absence of a Linear mockup; no browser audio E2E, duplicated Astro static-file smoke, or gameplay test is needed for this asset-only change.
- [ ] Local `bun run format:check` and `bun run build` pass after adding binaries. Record the measured sizes, durations, peak, native-pixel safe box, screenshot evidence, browser/platform and command results in PR #89.

No manual approval is presented as an automated test result. HPA-729 remains its own ticket/PR.
