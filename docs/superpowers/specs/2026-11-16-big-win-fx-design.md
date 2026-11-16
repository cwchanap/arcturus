# HPA-728 — Big-win celebration sprites and SFX: design specification

**Linear:** https://linear.app/cwchanap/issue/HPA-728/assets-big-win-celebration-sprites-and-sfx  
**Downstream implementation:** https://linear.app/cwchanap/issue/HPA-729/all-games-big-win-celebration  
**Implementation plan:** [2026-11-16-big-win-fx.md](../plans/2026-11-16-big-win-fx.md)  
**Delivery:** Exactly **one PR for HPA-728**. It starts with these planning documents; add the seven generated binary assets to this same PR after the ticket's preview/approval step. HPA-729 owns runtime animation, playback, localization, and integration in a **different ticket/PR**.

## Problem and player-facing intent

A high-value virtual-chip win should have artwork and audio consistent with Arcturus's existing painted, dark-green-and-gold poker presentation. The shared runtime celebration will be built later in HPA-729. This ticket is **art/SFX only**, not a functional celebration feature.

The static assets must be usable as animated DOM images, small enough for every game's page, and compatible with mobile Safari. No text is baked into any image: HPA-729 will render translated labels as HTML in the four existing locales.

## Verified repository references (main, 2026-11-16)

- `public/images/poker/pot-chips.webp`: 128 × 128 WebP with a real alpha channel, approximately **5.4 KB**. Use its chip painting, outlines, proportions, and transparent framing as the primary particle reference.
- `public/images/poker/emblem.webp`: 128 × 128 WebP with alpha; secondary metallic ornament reference.
- `public/images/poker/card-back.webp`: 256 × 384 WebP, approximately **35 KB**.
- `public/images/poker/felt.webp`: 768 × 512 WebP, approximately **33 KB**. It appears in `src/styles/poker.css` under a dark-green overlay, with gold details (including `--poker-gold: #e4c988`).
- `src/pages/games/poker.astro` already references static assets via `/images/poker/...`. No celebration runtime exists in this ticket; HPA-729 will consume the new fixed paths.
- `package.json` uses Astro and Bun with `bun run build`, `bun run format:check`, and Playwright. No image/SFX conversion dependency should be added to the project just for this task.

There is **no Linear mockup** attached to HPA-728. Use actual browser screenshots of the current poker table and the candidate preview for the visual comparison.

## Asset contract (seven files)

| File | Purpose and appearance | Target | Budget |
| --- | --- | --- | --- |
| `public/images/fx/chip-gold.webp` | Top-down gilded casino chip, high-contrast dark bevel, true transparent background | 128 × 128 | Part of image total |
| `public/images/fx/chip-red.webp` | Matching rich-red chip with the same silhouette, radius, lighting | 128 × 128 | Part of image total |
| `public/images/fx/chip-blue.webp` | Matching sapphire-blue chip with the same silhouette, radius, lighting | 128 × 128 | Part of image total |
| `public/images/fx/sparkle.webp` | Small elegant metallic four-point glint, without a rectangular matte | 128 × 128 | Part of image total |
| `public/images/fx/big-win-ribbon.webp` | Wide Art Deco ribbon/banner, metallic gold edging, translucent outer silhouette, **no words** | ~960 px wide (suggested 960 × 240) | **All five images ≈100 KB total** |
| `public/audio/fx/coin-shower.mp3` | Light, clearly distinct chips clattering/cascading, short fade | ~1.5 s | ≤100 KB |
| `public/audio/fx/big-win-sting.mp3` | Original upbeat short casino celebration sting, no recognizable existing tune | ~2.0 s | ≤100 KB |

The filenames and paths are the **interface** HPA-729 will use. Generate original assets rather than copying stock or trademarked casino artwork.

### Art direction

- Preserve the current game's **painted Art Deco / refined casino** style: dark outlines, restrained highlights and gold bevels; avoid flat emoji, pixel art, neon effects, photo backgrounds, extra logos, numbers, lettering, or UI controls.
- Keep all chips consistent in shape, edge detail, viewpoint and illumination; only the denomination color changes. Chips must still be distinguishable when rendered at 24–48 CSS px.
- Preserve meaningful transparent padding around chips and glint so rotation does not clip; no solid matte. The ribbon must have true alpha outside its silhouette and leave a calm central region for HTML text/counter.
- The banner should scale gracefully into a phone-width overlay; HPA-729 determines the final CSS width. Do not bake `Big Win` or chip amounts into the bitmap.
- Favor aggressive WebP optimization **after** creating the high-quality source images. Shipping only final-sized WebP keeps the runtime and repository small; do not commit large source renders, PSDs, preview HTML, or a contact sheet unless specifically requested.

### Sound direction

- `coin-shower.mp3`: dry, crisp, several small metallic/chip clicks with quickly diminishing tail, no voices or ambient music.
- `big-win-sting.mp3`: celebratory 2-second original flourish with a clean ending, not a looping theme or a long reverb tail.
- Export MP3 for Safari compatibility, make the starts responsive and endings non-clicking, avoid obvious clipping/harsh peaks. A modest bitrate is sufficient at these durations.
- Sound playback, mute state and reduced-motion behavior are **HPA-729**, not HPA-728.

## Scope and handoff

**In scope:** original generated art, two generated/edited sound effects, conversion/size optimization, preview presentation, automated asset-quality checks and one-platform browser-preview evidence.

**Out of scope:** changes to `src/`, game win detection, particle engine, DOM overlays, localization, site-wide mute controls, dependencies, D1/API work, new test framework or a reusable asset pipeline. Do not implement any HPA-729 features in this PR.

HPA-729 may animate the three chip variants, glint, ribbon and sound using these stable paths. Keep their integration as separate work to honor the existing Linear blocker.

## Review and acceptance

**Preview sequencing from Linear:** Post an uncommitted sheet showing the three chip colors at native and rendered size, the sparkle, and the ribbon over the real poker look, plus playable previews of both sounds. Obtain the requested preview approval **before committing the binaries**. This is a project sequencing step, **not a human sign-off acceptance test**; technical acceptance uses the checks below.

**End-to-end acceptance (must be run by browser automation MCP, one platform is enough):**

- [ ] Exactly the five fixed image paths and two sound paths above are shipped; no runtime or gameplay code is changed and no extra build dependency is introduced.
- [ ] Automated file inspection verifies **128 × 128** chips/glint, approximately **960 px** ribbon width, valid WebP, actual alpha transparency for all five (including transparent outside pixels), and total final image payload **around 100 KB or below**. If quality makes the budget impractical, document the measured trade-off instead of silently accepting much larger art.
- [ ] Automated media inspection verifies valid MP3 decoding, approximately **1.5 s** and **2.0 s** duration respectively, and **≤100 KB each**; both sound previews play to completion without clipping or a broken tail.
- [ ] Browser MCP loads the five images and two audio resources as **served by the Astro dev/preview app**, not just from the filesystem; all succeed and decode. A user-gesture-triggered playback check covers audio.
- [ ] Browser MCP captures and inspects screenshot evidence against the existing poker table at a desktop viewport (e.g. 1280 px) and a phone viewport (e.g. 375 px). The chip particles remain legible at 24–48 px, ribbon retains readable central space and does not cover the whole phone, and no image shows a rectangular matte. No Linear mockup exists, so screenshot visual comparison is the criterion.
- [ ] `bun run build` and `bun run format:check` pass after adding the assets. PR records tested platform/browser, screenshot paths, actual file sizes/durations, and commands. **No human acceptance criterion** and no premature claim that HPA-729's in-game celebration has been tested.
