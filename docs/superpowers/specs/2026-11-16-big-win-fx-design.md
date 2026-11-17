# HPA-728 — Big-win celebration assets: design specification

**Linear:** https://linear.app/cwchanap/issue/HPA-728/assets-big-win-celebration-sprites-and-sfx  
**Implementation plan:** [2026-11-16-big-win-fx.md](../plans/2026-11-16-big-win-fx.md)  
**Delivery:** One PR, [#89](https://github.com/cwchanap/arcturus/pull/89), for the assets; [HPA-729](https://linear.app/cwchanap/issue/HPA-729/all-games-big-win-celebration) is the separate, blocked runtime implementation.

## Goal and existing references

Supply small, original, painted Art Deco effects for a rare casino win, matching the existing dark-green/gold poker presentation. **This PR ships only images and audio**—no animations, UI integration, gameplay, mute handling, database/API work, dependencies, or asset pipeline.

- `public/images/poker/pot-chips.webp`: 128 × 128 transparent painted **chip pile**, ~5.4 KB; visual treatment reference, not a single-chip sprite to duplicate.
- `public/images/poker/emblem.webp`: 128 × 128 transparent metallic decoration.
- `public/images/poker/felt.webp`: 768 × 512 background (~33 KB) used by `src/styles/poker.css` (gold `#e4c988`). `public/images/poker/card-back.webp`: 256 × 384 (~35 KB).
- `src/components/PokerChip.astro` uses CSS circles; the ticket explicitly calls for painted sprites instead.
- `src/lib/poker/sound.ts` currently synthesizes `chips`, `allIn`, and `bigWin` through Web Audio (master gain defaults to 0.6), and its header says no audio files ship. `src/lib/poker/PokerGame.ts` already calls `this.sound.play(big ? 'bigWin' : 'win')` after qualifying wins, including ≥20 big blinds or a strong hand. These cues are **not modified in HPA-728**; the runtime overlap must be reconciled in HPA-729.

No UI mockup is attached to Linear; use the existing table and screenshots as the visual reference.

## Seven-file contract

| Final path | Visual/audio specification | Format and budget |
| --- | --- | --- |
| `public/images/fx/chip-gold.webp` | Top-down gilded single chip with painted bevel and transparent padding | 128 × 128 WebP |
| `public/images/fx/chip-red.webp` | Same rim, viewpoint, size and lighting; rich red | 128 × 128 WebP |
| `public/images/fx/chip-blue.webp` | Same rim, viewpoint, size and lighting; sapphire blue | 128 × 128 WebP |
| `public/images/fx/sparkle.webp` | Restrained metallic four-point glint; no matte rectangle | 128 × 128 WebP |
| `public/images/fx/big-win-ribbon.webp` | Art Deco metallic ribbon, **transparent outside its silhouette**, quiet central text region, **no baked text** | ~960 px wide; suggested 960 × 240 WebP |
| `public/audio/fx/coin-shower.mp3` | Clear, diminishing cascade of chip clicks; ~1.5 s | MP3, ≤100 KB |
| `public/audio/fx/big-win-sting.mp3` | Original short celebratory flourish; ~2.0 s | MP3, ≤100 KB |

**All five WebPs together:** target ~100 KB or less, keeping real alpha and edge quality. Preserve fixed paths as HPA-729's public asset interface. Do not ship master source renders, prompts, WAVs or previews in the repository.

## Art direction

- Painted casino look: dark outlines, restrained gold highlights, coherent lighting and silhouettes. Avoid flat emoji, neon, text, numbers, logos, stock assets and rectangular backgrounds.
- Generate one gold master, recolor/repaint red and blue from the same shape so particles read as a set. Inspect chips at 24–48 CSS px on dark felt.
- Keep transparent outer pixels on chips, sparkle **and ribbon**; no opaque/translucent rectangle outside the actual ribbon shape. Leave sufficient padding for spinning, and a central region for `Big Win` plus the count-up rendered later in HTML for four locales.
- **Measure and record the ribbon's text-safe rectangle** in native pixel coordinates `(x, y, width, height)` after final export; check that English, Traditional Chinese, Simplified Chinese and Japanese overlays fit in the scratch preview. Do not guess a safe-area box before the art exists.
- The ribbon must fit a phone-width overlay without obscuring the entire screen.

## Sound and layering contract

- Export **mono, 44.1 kHz MP3s**. A pragmatic initial mastering target is around **−20 LUFS integrated** and **≤−6 dBTP per isolated clip**; apply one `ffmpeg loudnorm` pass, measure, and turn down as needed. Avoid pumping away the chip transients.
- The HPA-729 **huge** tier plays both files **simultaneously** (shower plus sting). Measure and audition the **combined** pair: aim for composite true peak **≤−1 dBTP** and no harshness; an isolated per-file peak cap alone does **not** guarantee the sum will not clip. Include a listen/A–B against the existing synthesized poker `bigWin` cue at representative volume.
- Clips should start promptly, end cleanly, contain no voices or borrowed melodies, and remain tasteful next to the existing poker sounds. Use `ffprobe`/`ffmpeg` and macOS `afinfo`/`afplay` for metadata, decoder and listening checks.
- **HPA-729 handoff:** avoid duplicate effects when the existing `PokerGame.ts` `bigWin` sound and the new celebration are triggered by the same hand. Suppress/route the overlapping synth cue where appropriate without silently removing feedback for non-celebration outcomes; update `sound.ts`'s now-stale no-file header while implementing runtime playback.

## Preview workflow and automated completion

The Linear issue requests **preview approval before committing binary assets**. Assemble one temporary preview outside Git with desktop (1280 × 800) and phone (375 × 812) screenshots showing each sprite on poker felt, a ribbon with temporary localized HTML text, and individual/layered audio playback. Post a **PR #89 Conversation comment** containing screenshots and accessible audio attachments/links. An explicit approval reply on **that preview comment** is the pre-commit go-ahead; if there is no reply or attachment path, keep the PR in planning/preview state rather than silently committing unapproved binaries. This is a sequencing checkpoint, **not a human testing/acceptance criterion**.

**Automated acceptance (one platform; run through browser MCP for the visual E2E):**

- [ ] Seven final files exist at their fixed paths with no application code or new dependencies, and the combined WebPs and individual MP3s meet the stated budgets.
- [ ] `webpinfo`/Pillow confirms the four 128 × 128 sprites, ~960px ribbon, WebP encoding, actual transparency (including outer pixels), plus consistent chip framing; measurements are recorded.
- [ ] `ffprobe`/`afinfo` confirms two valid 44.1-kHz mono MP3s near 1.5 s and 2.0 s; `ffmpeg` measures isolated and **layered** peaks, and playback/decode checks pass.
- [ ] **Browser MCP** exercises the **single scratch preview** at desktop/phone viewport sizes; screenshot evidence is visually checked against the current table for legibility, transparency, ribbon fit and text-safe region. The preview also exercises individual/layered playback controls. No separate Astro-asset HTTP smoke or full gameplay E2E is required for this static-asset ticket.
- [ ] `bun run format:check` and `bun run build` pass after final files are added (run locally while the PR remains draft); record screenshots, audio measurements, checks and environment in the PR. No manual verification is an acceptance check.

HPA-729 separately owns thresholds, animation, translated runtime text, mute state, and integration with games.
