# Pocket NBA theme (basketball orange)

Lives in `shared/styles.css`, between `/* === NBA theme === */` and `/* === end NBA theme === */` (section 12). NFL pages don't change: everything is scoped under `.sport-nba` except the NFL | NBA switch (12a), which every page with `#rr-nav` shows.

## How a page opts in

```html
<body class="sport-nba">
```

That's the whole change. The class remaps the shared semantic tokens (`--accent`, `--accent-glow`, `--brand-400/500/600`, `--brand-glow`, `--shadow-focus`). The nav, `.btn-primary`, `.btn-brand`, `.btn-secondary`, `.badge`, the focus ring, tier dividers and the pressed `.nd-chip-toggle` / `.nd-views` buttons all turn orange with no other markup edits.

`.sport-nba` also works on a single block. home.html puts it on `#nba-banner` and `#nba`, so the rest of that page keeps the NFL indigo.

## Tokens (`.sport-nba`)

| Token | Value | Use |
|---|---|---|
| `--nba-50` | `#fff4ec` | lightest tint |
| `--nba-200` | `#ffd2ad` | text on orange-tinted chips |
| `--nba-300` | `#ffb27a` | hover text, eyebrow text, button hover fill |
| `--nba-400` | `#ff8a3d` | **accent**: active nav, accent text, button gradient start |
| `--nba-500` | `#f7711f` | button fill (gradient end) |
| `--nba-600` | `#db5a0c` | pressed/active fill |
| `--nba-700` | `#a8430a` | deep shade |
| `--nba-ink` | `#1c0b02` | label colour on any orange fill |
| `--nba-hardwood` | `#c8915a` | decorative court tone, tier 3 (never body text) |
| `--nba-surface` / `--nba-surface-2` | `#120c08` / `#1a110b` | warm card surfaces |
| `--nba-border` / `--nba-border-bright` | orange at 22% / 42% | card + control borders |
| `--nba-glow` / `--nba-glow-strong` | orange at 14% / 32% | hover backgrounds, soft halo shadows |
| `--nba-ring` | `0 0 0 3px` orange at 35% | focus ring for buttons |
| `--nba-line` | `#ffb27a` at 7% | court-line pattern stroke |

### Contrast (WCAG 2.x, checked in `scripts/test-nba-home.js`)

| Pair | Ratio |
|---|---|
| `--nba-400` on `#111` | 8.05:1 |
| `--nba-400` on `#0a0a0a` | 8.44:1 |
| `--nba-300` on `#111` | 10.70:1 |
| `--nba-400` on `--nba-surface-2` | 7.93:1 |
| `--nba-ink` on `--nba-500` (button) | 6.68:1 |
| `--nba-ink` on `--nba-400` | 8.15:1 |
| `--nba-ink` on `--nba-300` (hover) | 10.84:1 |
| `--nba-ink` on `--nba-600` (pressed) | 4.99:1 |

White on orange fails AA, so orange buttons always use the dark `--nba-ink` label. The position colour `--g: #fb923c` on the draft board is close to the accent. That's fine for small position pills, but don't use `--nba-400` text to mean "guard".

## Components

- **Sport switch (all pages).** `nav.js` injects `.rr-sport` after the logo, plus a `.rr-sport-menu` copy that only shows inside the open hamburger (≤768px). Pages that ship their own `#rr-sport-switch` (`.sport-switch`) get the same pill styling, and on `.sport-nba` the active option is an orange pill with an ink label.
- **Nav (`.sport-nba #rr-nav`).** Warm dark gradient bar, a small CSS basketball before the logo, and the active link in `--nba-400` with a 2px orange underline.
- **Buttons.** `.btn-primary`/`.btn-brand` under `.sport-nba` and the standalone `.nba-btn` (pill) share one orange gradient with an ink label: hover is lighter, pressed is `--nba-600`, focus uses `--nba-ring`.
- **`.nba-chip`** (mono pill, `.solid` variant), **`.nba-badge`** (position/slot badge), **`.nba-tier-1..4`** (tier ladder text colours), and orange ticks on `.rsch-tier-divider`.
- **`.nba-court`.** A faint half-court (centre circle, free-throw circle, three-point arc, half-court line) drawn in CSS gradients behind the content. Use it on one hero/panel per page at most.
- **`.nba-ball`.** A 1em CSS basketball with seams, for eyebrow icons and empty states (`aria-hidden="true"`).
- **Motion and a11y.** Buttons drop transitions and press-scale under `prefers-reduced-motion`. `prefers-contrast: more` thickens borders and removes the court lines.

## Screenshots (`docs/nba-ui/`)

| File | What |
|---|---|
| `n1-home-top-375.png`, `n1-home-top-1280.png` | Homepage first screen: NFL \| NBA pill in the nav + the "NBA is live" banner |
| `n1-home-menu-375.png` | Mobile hamburger open: Sport row (NFL \| NBA) above Sign In |
| `n1-home-nba-section-375.png`, `-1280.png` | Homepage NBA section (panel, pick-card mock, four feature tiles) |
| `n1-home-footer-375.png`, `-1280.png` | Footer with the "NBA draft board" link |
| `n1-nba-plain-375.png`, `-1280.png` | `/nba` as it ships today (no theme class) |
| `n1-nba-themed-375.png`, `-1280.png`, `n1-nba-themed-menu-375.png` | `/nba` with `sport-nba` injected by the test driver (preview of N2) |
