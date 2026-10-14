# Pocket NBA design system (`nba-ui`) — the contract

Every `/nba` page (Board, Research, Lineup, Trade, Waivers) builds on this. If a
page needs something that is not here, add it to `nba/pages/nba-ui.css` +
this doc + the style guide, not to the page's inline `<style>`.

- CSS: `nba/pages/nba-ui.css` (tokens + components; every rule scoped under `.nba-ui` / `.sport-nba`)
- JS: `nba/pages/nba-ui.js` → `window.NbaUI` (browser) / `require('./nba/pages/nba-ui.js')` (node)
- Living style guide: `/nba/pages/styleguide.html` (not linked from nav)
- Tests: `node scripts/test-nba-ui-kit.js` (in `npm test`)
- Image evidence: `scripts/nba-headshot-probe.py` → `docs/nba-ui/u0-headshot-probe.json`

## 0. Why the old NBA pages looked worse than NFL (from side-by-side screenshots)

| NFL (`/research`, `/lineup`) | Old NBA (`/nba`, `/nba/lineup`) | Rule in this system |
|---|---|---|
| Neutral black/graphite surfaces | Muddy brown `#120c08` everywhere | Graphite surfaces (`--nu-s1..3`); orange only as a signal |
| A face on every player row | Text only | `NbaUI.avatar()` on every player, every page |
| One hierarchy: list → detail, big mono stat tiles | 4–5 stacked boxes, all with the same orange border, all equal weight | Max ONE `.nu-card--focus` per view; other cards are hairline graphite |
| Dense table, mono numerals, aligned columns | Paragraphs of explanatory copy above the fold | Copy goes into a sheet ("How it works"); the page leads with data |
| Calm nav | Nav + chips + glows all orange | Orange = active tab, primary button, the key number, focus ring. Nothing else. |

## 1. Page setup (copy this)

```html
<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#1a110b">  <!-- test-nba-copy.js requires this value -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preconnect" href="https://sleepercdn.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=DM+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/shared/styles.css">
<link rel="stylesheet" href="/nba/pages/nba-ui.css">
<script src="/nba/pages/nba-ui.js"></script>          <!-- NOT defer -->
<script defer src="/shared/nav.js"></script>
</head>
<body class="sport-nba nba-ui">
<div data-nu-nav></div>
<script>NbaUI.mountNav({ active: 'lineup' });</script>  <!-- board|research|lineup|trade|waivers -->
<main class="nu-shell" id="app"> … </main>
<script defer src="/nba/pages/yahoo-chip.js"></script>  <!-- renders into [data-nba-yahoo-chip] in the nav -->
</body></html>
```

Notes
- `mountNav` must run before the deferred `/shared/nav.js` (it does when it is an inline script in `<body>`): nav.js then adds the hamburger menu copy of the sport switch and wires the hamburger. Umami events: `nfl-nav-switch` / `nba-nav-switch` (same as nav.js), `nba-nav-<tab>`, `nba-tabbar-<tab>`.
- The 5 tabs are in the top bar on ≥769px and in a **bottom tab bar** (`.nu-tabbar`) on ≤768px. `body.nu-has-tabbar` pads the page bottom; sticky action bars and toasts sit above the tab bar automatically.

## 2. Tokens (on `.nba-ui`)

| Group | Tokens |
|---|---|
| Orange | `--nba-50 200 300 400 500 600 700`, `--nba-ink` (text on orange), `--nba-hardwood` (decor only) |
| Surfaces | `--nu-bg #08090b` page · `--nu-s1 #0f1114` card · `--nu-s2 #15181c` raised/input/tile · `--nu-s3 #1c2026` sheet/pressed |
| Lines | `--nu-line` hairline · `--nu-line-2` control border · `--nu-line-3` hover border |
| Text | `--nu-text #f4f5f7` · `--nu-text-2 #aab0ba` meta · `--nu-text-3 #8a919c` hints/axis · `--nu-text-dis` disabled only |
| Accent | `--nu-accent` (=400) · `--nu-accent-2` (=300, hover/eyebrow) · `--nu-accent-ink` · `--nu-accent-soft` fill · `--nu-accent-line` border · `--nu-glow` · `--nu-ring` (focus) |
| Semantic | `--nu-good/-soft`, `--nu-bad/-soft`, `--nu-warn/-soft`, `--nu-info/-soft` |
| Positions | `--nu-pos-g` (PG/SG/G amber) · `--nu-pos-f` (SF/PF/F sky) · `--nu-pos-c` (C violet) · `--nu-pos-u` (UTIL) |
| Type | `--nu-font` Plus Jakarta Sans · `--nu-mono` DM Mono |
| Type scale | `--nu-fs-display` 28→40 · `-title` 22 · `-h3` 17 · `-body` 14 · `-sm` 13 · `-xs` 12 · `-micro` 11 (mono caps) · `-stat` 28 · `-hero-num` 48 |
| Space | `--nu-1..12` = 4 8 12 16 20 24 32 40 48 px · `--nu-gutter` 16→32 · `--nu-max` 1200 |
| Radius | `--nu-r-xs 6 · sm 8 · md 12 · lg 16 · xl 22 · pill` |
| Depth | `--nu-shadow-1` card · `-2` raised · `-3` sheet/toast/action bar |
| Touch | `--nu-tap 44px` · `--nu-nav-h` · `--nu-tabbar-h` · `--nu-safe-b` |
| Motion | `--nu-ease` · `--nu-ease-spring` (sheets) · `--nu-dur-1/2/3` 120/200/320ms |

Contrast (checked by the test, WCAG): every text token ≥ 4.5:1 on every surface it is allowed on; `--nu-text-3` is the floor for hints (≥4.5:1 on `--nu-s3`). UI strokes (focus ring, active border, pos/tier pill text) ≥ 3:1.

## 3. Type rules

- Page title: `.nu-page-head__title` (display, 800, -0.035em). One per page.
- Section/card title: `.nu-card__title` (17/700) or `.nu-title` (22/750) for sheets/detail.
- Labels, column heads, eyebrows: **DM Mono caps 11px** (`.nu-label`, `.nu-eyebrow` [orange], `.nu-section__title`, `th`).
- Every number a user compares (scores, ranks, %, VORP): `.nu-num` / `.nu-col-num` / `.nu-stat__value` → DM Mono tabular.
- Body copy max 62ch. Explanations > 2 lines go in a sheet behind an "How it works" ghost button.

## 4. Components (class → when → snippet)

### Type utilities
`.nu-display` (page-title scale) · `.nu-title` (22) · `.nu-h3` (17) · `.nu-body` (14, secondary colour, 1.55) · `.nu-meta` (13) · `.nu-hint` (12, tertiary) · `.nu-label` / `.nu-eyebrow` (mono caps) · `.nu-num` (mono tabular).

### Layout
- `.nu-shell` page container (`--narrow` 880px). `.nu-stack` (`--sm`, `--lg`) vertical rhythm. `.nu-row-flex` + `.nu-spacer` clusters.
- `.nu-split` list + detail (≥1024: list | 420px detail; `--detail`: 440px detail | content). `.nu-sticky-col` keeps the detail in view.
- `.nu-grid` auto-fit cards; `.nu-cols-2` / `.nu-cols-3` / `.nu-cols-4` fixed columns ≥768px.

### Page header (court motif lives here only)
`NbaUI.pageHeader({ eyebrow, title, sub, actions, court })`
```html
<header class="nu-page-head nu-page-head--court">
  <div class="nu-page-head__text"><div class="nu-eyebrow">Halimsanity 26-27 · Yahoo High Score</div>
  <h1 class="nu-page-head__title">Week 1 lineup</h1><p class="nu-page-head__sub">…</p></div>
  <div class="nu-page-head__actions"><button class="nu-btn nu-btn--ghost nu-btn--sm">How it works</button></div>
</header>
```

### Cards + sections
- `.nu-card` default (graphite, hairline). `--raised` (s2, nested emphasis), `--inset` (well), `--flush` (no padding: wraps lists/tables), `--interactive` (whole card clickable), **`--focus` = the ONE thing to look at** (your pick, the recommended lineup, the trade verdict).
- `.nu-card__head` > `.nu-card__title` + actions. `.nu-section` > `.nu-section__head` > `.nu-section__title` (mono caps).
- `.nu-kv` definition list (`<dl class="nu-kv"><dt>Floor</dt><dd>39.3</dd>…`).

### Buttons
`.nu-btn` (secondary, default) · `--primary` (orange, ONE per view region) · `--ghost` · `--danger` · `--yahoo` (+ `<span class="nu-y">Y!</span>`) · sizes `--sm` (36px visual, 44px hit) `--lg` (52) · `--block` · `--icon` (square; needs `aria-label`). Loading: `aria-busy="true"`. Disabled: `disabled`. Count bubble: `<span class="nu-count">3</span>` inside a button.
```html
<button class="nu-btn nu-btn--primary">Draft Jokić</button>
<button class="nu-btn nu-btn--icon" aria-label="League settings">${NbaUI.icon.settings}</button>
```

### Forms
`.nu-field` > `label` + `.nu-input` / `.nu-select` (16px font: no iOS zoom; 44px). Search: `<label class="nu-search">${NbaUI.icon.search}<input class="nu-input" type="search" placeholder="Search players"></label>`. Invalid: `aria-invalid="true"` + `.nu-error`. Switch: `<button class="nu-switch" role="switch" aria-checked="false" aria-label="…">`.

### Filters, tabs, segmented
- Filter chips: `.nu-chip-row` (`--scroll` = one swipeable line on mobile, wraps ≥768) > `button.nu-chip[aria-pressed]` (+ `.nu-chip__n` count). Read-only tag: `.nu-tag`.
- Tabs (switch panels): `<div class="nu-tabs" role="tablist"><button class="nu-tab" role="tab" aria-selected="true" aria-controls="p1" data-value="board">…` → `NbaUI.tabs(el, { onChange })` (arrow keys, Home/End).
- Segmented (mode/view switch inside a page): `<div class="nu-seg" role="group" aria-label="View"><button data-value="list" aria-pressed="true">List</button>…` → `NbaUI.segmented(el, { onChange, multi })`. `--accent` = orange selected; `--block` = full width.

### Players
- `NbaUI.avatar(player, { size: 'xs'|'sm'|'md'|'lg'|'xl'|'hero', teamBadge, injuryDot, square, eager, noImage })` → `.nu-avatar` (24/32/40/56/96/128px). Initials on a team-tinted disc underneath, headshot fades in on top, source chain on error (see §6).
- `NbaUI.playerCell(player, { size, meta, teamBadge, injuryDot, href, lg })` → `.nu-player` > avatar + `.nu-player__name` + `.nu-player__meta` (default meta = pos pills · team · injury; separate custom meta items with `<span class="nu-sep"></span>`). `lg` = detail header (xl avatar, 22px name).
- `NbaUI.teamLogo(abbr, { size: 'sm'|'md'|'lg'|'xl' })` → `.nu-team-logo` (16/24/40/64; abbr text fallback).

### Pills + badges
| Helper | Output | Notes |
|---|---|---|
| `posPill('PG')` / `posPill(['PG','SG'])` | `.nu-pos[data-pos]` (/ `.nu-pos-group`) | UTIL renders "UTL" |
| `tierBadge(1..n)` | `.nu-tier[data-tier]` | T1 solid orange, T2 orange outline, T3 hardwood, T4+ neutral |
| `injuryBadge(str, { outForSeason })` | `.nu-inj[data-status=out\|q\|gtd\|dtd\|prob]` | maps model strings DTD/GTD/Out/OUT/Q/IR; OFS |
| `valueBadge('value'\|'fair'\|'reach', strong)` | `.nu-value[data-label]` | from the model's `label` / `strong` |
| `delta(x, dp)` | `.nu-delta.is-up/.is-down` "▲ 2.3" | aria-label "up 2.3" |
| — | `.nu-rank` (`.is-top`) | mono rank column |
| — | `.nu-tier-rule` | `<div class="nu-tier-rule"><b>Tier 2</b></div>` divider in lists |

### Numbers + charts
- `statTile({ label, value, sub, delta, tone: 'accent'|'hero', dp })` → `.nu-stat` in `.nu-stats` (`--2`, `--3`, auto-fit default). `.nu-stat--bare` = no box.
- `rangeBand({ min, max, lo, hi, mark, labels: ['Floor 39','Ceil 85'] })` → floor–ceiling band with a mean marker.
- `meter(frac, 'good'|'bad')` → `.nu-meter`. Split bar (win prob): `<div class="nu-meter nu-meter--split"><span style="width:63%;background:var(--nu-good)"></span><span style="width:37%;background:var(--nu-bad)"></span></div>`.
- `sparkline(values, { w, h, tone: 'good'|'bad'|'muted', area, dot, label })` → inline SVG `.nu-spark`. Pure math: `sparkPoints(values, w, h, pad)`.
- `histogram(values, { bins, w, h, range: [min,max], mark, highlightFrom, labels, label })` → `.nu-hist`. Pure math: `binCounts(values, bins, range)`.
- `NbaUI.fmt`: `score(x, dp=1)` "62.9"/"—", `rank(n)` "#3", `ordinal(n)` "3rd", `pct(x)` "63%", `signed(x)` "+2.3", `delta(x)` → `{text, dir, cls}`, `initials(name)`.

### Data
- **Table** (desktop-dense): `.nu-table-wrap` > `table.nu-table` (`--compact`). `th` mono caps, sticky. Sortable: `<th aria-sort="descending"><button>Value</button></th>`. Cells: `.nu-col-name` (player cell, takes remaining width), `.nu-col-num` (right, mono), `.nu-col-opt` (hidden <768px). Rows: `.is-clickable`, `.is-selected` (orange inset bar), `.is-gone` (drafted: dim + strike).
- **List** (mobile-first): `.nu-list` (`--plain`) > `.nu-row` (a/button/div, 60px; `--compact` 48px) > `.nu-player` + `.nu-row__end` > `.nu-row__num` (`<b>75.0</b><small>value</small>`). `.nu-slot` = fixed 44px slot column (lineup). States `.is-selected`, `.is-clickable`.

### Feedback
- `callout(tone, html)` → `.nu-callout--info|warn|error|success` (default orange = tip). One line ideally.
- `emptyState({ title, body, action })` → `.nu-empty` with the ball glyph.
- `skeleton(n, { kind: 'row'|'tile'|'card' })` → shimmer placeholders, same geometry as the real rows (no layout jump). Render immediately, replace on data.
- `toast(msg, { tone: 'good'|'bad', timeout, action: { label, onClick } })` → polite live region, max 3, above tab/action bar.
- `statusChip(state, label, href)` → `.nu-status-chip[data-state=connected|syncing|error|off]` for the nav slot `#nu-nav-status` (yahoo-chip.js also renders there).

### Sheet (bottom sheet ≤768, centered modal ≥769)
```html
<div class="nu-sheet" id="about" role="dialog" aria-modal="true" aria-labelledby="about-t" hidden>
  <div class="nu-sheet__grab" aria-hidden="true"></div>
  <div class="nu-sheet__head"><h2 class="nu-sheet__title" id="about-t">How it works</h2>
    <button class="nu-btn nu-btn--ghost nu-btn--icon nu-btn--sm" data-nu-close aria-label="Close">${NbaUI.icon.close}</button></div>
  <div class="nu-sheet__body">…</div>
  <div class="nu-sheet__foot"><button class="nu-btn" data-nu-close>Cancel</button><button class="nu-btn nu-btn--primary">Save</button></div>
</div>
```
`NbaUI.sheet.open('about', { onClose, initialFocus: 'input' })`, `NbaUI.sheet.close()`, `NbaUI.sheet.isOpen()`. Focus trap, ESC, backdrop tap, `[data-nu-close]`, focus returns to opener, scroll lock, background `inert`. `.nu-sheet--wide` = 880px modal (player detail on desktop).

### Sticky action bar (tool pages)
```html
<div class="nu-actionbar"><div class="nu-actionbar__info"><b>Give 2 · Get 1</b><span>+4.2 weekly value</span></div>
  <button class="nu-btn nu-btn--primary">Evaluate</button></div>
```
Last child of `.nu-shell`; `position: sticky` bottom, above the tab bar on mobile. Add `nu-has-actionbar` to `<body>` so toasts clear it.

### Misc
`.nu-ball` (ball glyph; logo, empty states), `.nu-kbd`, `.nu-divider`, `.nu-sr` (visually hidden), `.nu-truncate`, `.nu-accent/.nu-good/.nu-bad/.nu-muted` text colours, `.nu-rise` + `NbaUI.stagger(container)` (one entrance per page load, ≤12 items staggered 28ms), `NbaUI.icon.{board,research,lineup,trade,waivers,search,close,info,alert,check,chevron,filter,settings,star}`, `NbaUI.esc()` (ALWAYS escape interpolated text).

Lower-level helpers (exported for pages + tests): `headshotSrcs(player, { size })` → the ordered URL list the avatar uses; `teamLogoSrcs(abbr)`; `injuryKey(str)` → `out|q|gtd|dtd|prob|null`; `navHtml({ active })` → `{ nav, tabbar }` markup; `activeFromPath(pathname)` → tab key; `hydrateImages(scope)` → re-checks `img[data-srcs]` that finished before the listeners existed (call after injecting HTML from a cache).

## 5. Layout templates for the 5 pages

**A. List/table page — Draft Board, Waivers**
```
nav · page head (eyebrow league · title · sub ≤1 line · actions: How it works / League)
[ .nu-card--focus  "Your pick now": playerCell lg + statTiles + primary button ]   ← the ONE focus card
chip filters (.nu-chip-row--scroll) + search          | (≥1024 right col: roster / needs card)
.nu-table (desktop)  /  .nu-list (≤767)                |  .nu-sticky-col
skeleton(12) while loading; emptyState() on no results
```
Board ≤768: sticky `.nu-actionbar` "Draft <name>" + "My team" sheet. Tier dividers `.nu-tier-rule`.

**B. Detail/research page — Research (with headshots)**
```
.nu-split--detail:  left = search + chips + .nu-list of players (avatar md, pos, team, value)
                    right (sticky) = .nu-card: playerCell lg (avatar hero, teamBadge) ·
                    .nu-stats (Value, Ceiling, Floor, Games, VORP, Rank) · rangeBand · histogram ·
                    sparkline of hsByWeek · notes · actions
≤1023: list only; tapping a row opens the detail in .nu-sheet (bottom sheet) — never navigate away.
```

**C. Tool page with sticky action bar — Lineup, Trade**
```
page head · controls row (week stepper .nu-seg / select / Yahoo connect)
Lineup: .nu-cols-2 summary [ total .nu-stat--hero + rangeBand | win prob meter--split ]
        .nu-list of slots (.nu-slot posPill · playerCell · .nu-row__num) · bench list
Trade:  .nu-cols-2 [ Give list | Get list ] each .nu-card--flush > .nu-list + "Add player" row
        verdict = .nu-card--focus with statTiles + delta
.nu-actionbar (Apply / Evaluate) — bottom of shell, sticky
```

**D. Mobile patterns (≤768)**
- Bottom tab bar = navigation. Never put primary actions in the top bar on mobile.
- Primary action = `.nu-actionbar` or `.nu-btn--block` at the end of the focus card (thumb zone).
- Secondary forms (League settings, add player, player detail) = `.nu-sheet`.
- Filters = one scrolling `.nu-chip-row--scroll` line, not wrapped rows.
- Tables: drop `.nu-col-opt` columns or switch to `.nu-list`.

## 6. Player images (measured 2026-10-13)

Probe: `python3 scripts/nba-headshot-probe.py` (39 players: 10 stars, 10 role (rank 91-100), 5 deep (rank 401-405), 8 2026 rookies, 6 Yahoo-only). Raw: `docs/nba-ui/u0-headshot-probe.json`.

| Source | URL | Hit | Format |
|---|---|---|---|
| Sleeper thumb | `https://sleepercdn.com/content/nba/players/thumb/{sleeperId}.jpg` | **32/32** players that have a Sleeper id (all stars, role, rookies incl. Peterson, Dybantsa, Boozer, Flagg); 0/7 Yahoo-only (no Sleeper id) | image/jpeg 250×168, 34–55 KB, `cache-control: public, max-age=2678400` |
| Sleeper full | `https://sleepercdn.com/content/nba/players/{sleeperId}.jpg` | 32/32 | jpeg 300×201, 47–77 KB |
| ESPN full | `https://a.espncdn.com/i/headshots/nba/players/full/{espnId}.png` | **39/39** once espnId is known (32 via ESPN team rosters, 7 via ESPN search — incl. all 6 Yahoo-only + Maxi Kleber) | image/png 600×436 transparent cut-out, 140–280 KB |
| ESPN resized | `https://a.espncdn.com/combiner/i?img=/i/headshots/nba/players/full/{espnId}.png&w=192&h=140` | same | png, ~28 KB |
| Team logo (Sleeper) | `https://sleepercdn.com/images/team_logos/nba/{abbr lower}.png` | 30/30 | png |
| Team logo (ESPN) | `https://a.espncdn.com/i/teamlogos/nba/500/{slug}.png` | 28/30 with raw abbr; NOP → `no`, UTA → `utah` (mapped in `teamLogoSrcs`) | png |

No placeholder silhouettes detected (no identical image bytes across different players).

**Chain in `NbaUI.avatar`:** Sleeper (`id`/`sleeperId` numeric) → ESPN resized (`espnId`) → Yahoo (`headshot`, https URL) → initials (always rendered underneath). Today, with the current API, 654/771 board players (85%) get a face (all Sleeper-id players); the 117 Yahoo-only players fall back to initials until `espnId` lands. With the API needs below: 39/39 = 100% in the sample.

### API needs (relay to R0 — U0 does not edit nba/model or server.js)
1. **`espnId` on every player in `/api/nba/players`** (string of digits), and on every player object the trade/lineup/waivers routes return. Sleeper's NBA feed has `espn_id: null` for all 654 active players (checked `api.sleeper.app/v1/players/nba`), so build the map from ESPN: `GET https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams` → 30 × `GET …/teams/{id}/roster` (`athletes[].id`, `fullName`), match on normalised name (strip accents, Jr/Sr/II/III, non-letters) + team; for misses use `GET https://site.web.api.espn.com/apis/common/v3/search?query={name}&type=player&sport=basketball&league=nba&limit=1` and accept only an exact normalised-name match. Cache daily with the rest of the model data.
2. **`headshot`** (optional, https URL) for Yahoo-only players from the Yahoo player resource (`headshot.url` / `image_url`) when the Yahoo snapshot is refreshed.
3. **`sleeperId`** stays numeric-string or null; Yahoo-only ids keep the `y<pid>` form (the avatar treats non-numeric ids as "no Sleeper image").
4. **CSP** (server.js `img-src`): add `https://a.espncdn.com` (ESPN headshots + team-logo fallback) and, for (2), `https://s.yimg.com`. Today the policy is `img-src 'self' data: https://sleepercdn.com https://img.clerk.com`, so ESPN images are blocked in production and the chain falls through to initials (no broken-image icons — the fallback handles the CSP error event too).

## 7. Accessibility rules
- Targets ≥ 44×44 (`--nu-tap`); 36px visual buttons/chips get a 44px hit area via `::after`.
- Focus: `:focus-visible` → `--nu-ring` (2px page-colour gap + 2px orange). Never remove without replacement.
- Colour is never the only signal: deltas carry ▲/▼, injuries carry text, tiers carry "T1".
- Images: avatar is `role="img"` with the player name; the `<img>` is `alt=""` (decorative duplicate).
- Sheets: `role="dialog" aria-modal="true" aria-labelledby`; focus trap + ESC + return focus (built in).
- Tabs: `role=tablist/tab`, `aria-selected`, `aria-controls`; segmented: `aria-pressed`; switches: `role=switch aria-checked`.
- Live updates: `toast()` (polite); errors via `callout('error')` (role=alert).
- Motion: `prefers-reduced-motion` kills shimmer, transitions and press-scale; `prefers-contrast: more` raises lines + secondary text; `forced-colors` keeps borders.
- Inputs are 16px (no iOS zoom). No horizontal page scroll at 375px.

## 8. Do / don't
- **Do** put a face next to every player name. **Don't** render bare player text rows.
- **Do** one `.nu-card--focus` + one `.nu-btn--primary` per view. **Don't** orange-border every card.
- **Do** lead with data; move explanations into a sheet. **Don't** put paragraph copy above the first data.
- **Do** mono tabular numerals for anything compared. **Don't** mix fonts in a numeric column.
- **Do** show `skeleton()` within the first frame. **Don't** show "Loading…" text alone.
- **Do** use the court motif only in `.nu-page-head--court`. **Don't** add court lines/glows to cards.
- **Do** escape with `NbaUI.esc`. **Don't** concatenate API strings into HTML raw.
- **Don't** add page-inline CSS for anything in this doc; **don't** re-skin `.nu-*` classes per page.
