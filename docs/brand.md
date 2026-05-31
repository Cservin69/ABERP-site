# Brand assets — friboard.com

This is a living index of where each brand asset lives in the repo and what Ervin should swap in when his finals are ready.

## Current assets (placeholders / first cut)

| Asset                         | Path                                                   | Status                                                                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wordmark                      | `src/lib/brand/Wordmark.svelte`                        | Placeholder — SVG `<text>` element rendered with system font stack. Ervin to replace with final wordmark (paste SVG paths into the component, or swap to `<img src="/wordmark.svg" />` pointing at a vendored `static/wordmark.svg`). |
| Favicon (SVG)                 | `static/favicon.svg`                                   | Placeholder — gold `F` on dark-blue rounded square. Ervin to drop final mark.                                                                                                                                                         |
| Favicon (PNG fallbacks)       | `static/favicon-32x32.png`, `static/favicon-16x16.png` | Generated from `favicon.svg` via `rsvg-convert`. Regenerate after swapping the SVG: `rsvg-convert -w 32 -h 32 static/favicon.svg -o static/favicon-32x32.png` (and `-w 16 -h 16` for the smaller).                                    |
| Apple touch icon              | `static/apple-touch-icon.png`                          | 180×180 PNG. Regenerate from a 180×180 source SVG via `rsvg-convert -w 180 -h 180 …`.                                                                                                                                                 |
| Background image (rain hero)  | `src/lib/rain-effect/assets/texture-rain-bg.png`       | Codrops texture from the rain-effect demo (see `src/lib/rain-effect/CREDITS.md`). Ervin will drop in his Áben workshop render at this exact path when ready.                                                                          |
| Background image (foreground) | `src/lib/rain-effect/assets/texture-rain-fg.png`       | Codrops texture — kept as-is unless Ervin provides a paired foreground.                                                                                                                                                               |

## Brand tokens

Color palette currently inlined in `src/routes/+page.svelte` and the brand components — not yet centralized (will hoist to a CSS-vars file once the palette is locked in).

| Token          | Value     | Used for                                                       |
| -------------- | --------- | -------------------------------------------------------------- |
| `--gold-light` | `#e2c089` | Top stop of wordmark/favicon gradient                          |
| `--gold-deep`  | `#b88a4a` | Bottom stop of wordmark/favicon gradient                       |
| `--gold-base`  | `#d4a574` | CTA border + text, tagline `A —` accent                        |
| `--bg-dark`    | `#0f1320` | Page background, favicon rounded-square fill, theme-color meta |
| `--text-light` | `#f3eee5` | Body / tagline text (warm off-white)                           |

## Typography

System font stack — no font files vendored in the repo, no external CDN font loading (GDPR-friendly).

```
system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif
```

Weight 200–300 across wordmark / tagline / CTA for the minimalist editorial feel. Letter-spacing: wordmark `~0.2em` (via SVG kerning), tagline `0.05em`, CTA `0.1em`.

## Swap-in checklist for Ervin's finals

1. **Wordmark** — edit `src/lib/brand/Wordmark.svelte`. The `<text>` element can be replaced with `<path>` data exported from the final design. Keep the `<linearGradient id="friboard-gold">` block or replace with a solid fill — both work.
2. **Favicon** — drop the new mark into `static/favicon.svg`, then regenerate the PNG fallbacks (commands above). Keep the file paths the same so `src/app.html` doesn't need to change.
3. **Hero background** — vendor the Áben workshop render at `src/lib/rain-effect/assets/texture-rain-bg.png` (same name as the codrops placeholder). The WebGL rain pipeline picks it up automatically; no code change needed.

## Áben Group umbrella (future)

Friboard is the customer-facing brand. The umbrella is Áben Group — Ervin to decide later whether the landing exposes that relationship (e.g. small "an Áben Group company" footer mark) or keeps Friboard standalone. No asset commitment in this phase.
