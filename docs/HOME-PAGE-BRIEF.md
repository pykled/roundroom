# RoundRoom Home Page — Creative Brief

Status: design brief, ready to implement. No code in this document.
Scope: the page served at bare `/` (no query params) on roundroom.pykled.com.

---

## 0. Hard constraints (read first)

1. `/` with **any** query param (`?companion=1`, `?league_id=…`, anything) keeps serving `index.html` unchanged. The home page is only served when the query string is empty. Commit `bb8bd3b` was reverted because it broke this. Do not touch `index.html`.
2. Add a `/draft` alias that serves `index.html`. All "Draft Assistant" links on the home page point to `/draft`. The PWA `start_url` stays `/?companion=1`.
3. Reuse `shared/theme.css` and `shared/nav.css` verbatim. The home page adds tokens; it does not change existing ones. The tools already ship on this system and the home page must look like the same product.
4. Fonts are already loaded on the tools: Plus Jakarta Sans (400–800) and DM Mono (400/500). Use the same Google Fonts link. No new font families.
5. Trade Calculator works signed-out. The home page may say "No account needed" for it.

---

## 1. Brand identity

**Personality (5 words):** decisive, league-literal, quiet, fast, unsentimental.

**The feeling.** It is 0:45 on the draft clock. Eleven people are scrolling a generic rankings tab. You already know the pick, because your board was built from your league's scoring, not the average league's. RoundRoom should feel like that: a dark room, one lit screen, numbers that already know your settings. Closer to a trading terminal than a sportsbook. No confetti, no helmet art, no stadium photos, no "dominate your league."

**What makes it different (this drives every headline):**
- FantasyCalc gives crowd-consensus market values. League-agnostic.
- Sleeper is the platform. It shows ADP and has no opinion.
- ESPN/Yahoo tools assume default scoring.
- RoundRoom takes one Sleeper username, reads the league's scoring, roster slots, and team count, and recomputes value over replacement against *that* league. Then it gives a verdict: best available, WIN/FAIR/LOSE, start/sit. Opinionated, not a list.

**Voice rules.** Second person. Short declaratives. No exclamation marks. Never "unleash," "dominate," "crush," "ultimate," "AI-powered." The word "your" does the selling.

**Name.** Round (draft rounds) + Room (the draft room). The logo mark is the indigo→violet "RR" tile from `icon.svg`. Use it at 28px in the nav next to the wordmark only if it does not crowd the 375px nav; otherwise wordmark only (current behavior).

---

## 2. Hero section

**Headline (H1):**
> Every pick. Every trade. Scored to your league.

Backup if it wraps badly: "Your league's numbers. Nobody else's."

**Sub-headline:**
> Link your Sleeper username once. RoundRoom reads your scoring and roster settings, then runs the draft board, trade calculator, and lineup tools on your league's numbers instead of the average one.

**CTAs (exactly two):**
- Primary (filled, brand gradient): **Link your Sleeper league** → opens the Clerk sign-up modal. After auth, land on the existing Sleeper-username step (the flow in `trade.html` / `/api/me`).
- Secondary (ghost, 1px `--border-bright`): **Try the trade calculator** → `/trade`. Microcopy under it in DM Mono, `--text-muted`: `No account needed`.

**Proof strip** directly under the CTAs, one row, DM Mono, uppercase, `--text-secondary`, separated by `·`:
`SLEEPER NATIVE · VORP, NOT ADP · FREE`

**Visual (right column on desktop).** Not a screenshot. A hand-built HTML/CSS "product frame" showing one trade verdict, because the verdict is the clearest proof of the differentiator. Contents, top to bottom:
1. Frame header, DM Mono 0.72rem: `TRADE VERDICT` on the left, `12-TEAM · HALF PPR · SF` on the right (this line is the point: it shows the numbers are league-specific).
2. Verdict chip centered: `WIN  +14.2` using the existing WIN styling (green text on `rgba(16,185,129,.12)`).
3. Two columns, labeled `YOU GIVE` / `YOU GET`. Two player rows each: position tag using the existing position colors (`--rb`, `--wr`, `--qb`, `--te`), player name in 600 weight, VORP value in DM Mono right-aligned. Use real, plausible 2026 names and values; the coding agent may pull from `data/composite_adp.json` so the frame never looks fake.
4. Frame footer, `--text-muted`, DM Mono: `Replacement level computed from your roster slots`.

Frame styling: `--bg-card` background, 1px `--border-bright`, 16px radius, max-width 460px. Behind it, one radial glow: `radial-gradient(circle at 60% 40%, rgba(99,102,241,0.18), transparent 60%)`. No tilt, no parallax, no drop shadow stack.

**Signed-in variants:** see section 5.

---

## 3. Tool showcase section

**Section eyebrow / title.**
Eyebrow (DM Mono): `THREE TOOLS · ONE LOGIN`
Title (H2): `Same league settings. Every tool.`

**Layout:** three equal cards in a 3-column grid on desktop. Not tabs (tabs hide two-thirds of the product), not sequential (three full-width rows is 1,200px of scrolling for three sentences). The grid reads as a set, which is the message.

**Card anatomy (identical for all three):**
1. Eyebrow, DM Mono uppercase, `--text-secondary`.
2. Title, 700, 1.2rem.
3. Pitch, one sentence, `--text-body`.
4. Mini-UI strip (this replaces an icon). Height ~120px, `--bg-secondary`, 1px `--border`, 8px radius. Contents differ per tool, below.
5. Text-link CTA with `→`, 600 weight, white. Whole card is clickable for the two live tools.

Hover: border `--border` → `--border-bright`, background `--bg-card` → `--bg-hover`, 120ms. Same transition the nav already uses.

**Card 1 — Draft Assistant**
- Eyebrow: `DRAFT DAY`
- Title: `Draft Assistant`
- Pitch: `Live best-available picks as your Sleeper draft runs, ranked by value over replacement for your scoring.`
- Mini-UI: three stacked player rows; the top row carries a small green tag `BEST AVAILABLE`, rows two and three dimmed.
- CTA: `Open draft board →` → `/draft`

**Card 2 — Trade Calculator**
- Eyebrow: `TRADE DESK`
- Title: `Trade Calculator`
- Pitch: `Put players on both sides and get a WIN, FAIR, or LOSE verdict built from your league's exact settings.`
- Mini-UI: the three verdict chips in a row (`WIN` green, `FAIR` gold, `LOSE` red) with the WIN chip at full opacity and the others at 50%.
- CTA: `Run a trade →` → `/trade`

**Card 3 — Lineup Optimizer (coming soon)**
- Eyebrow: `WEEKLY` followed by a 6px `--amber` dot and `COMING SOON`
- Title: `Lineup Optimizer`
- Pitch: `Your actual roster, this week's projections, and the lineup that scores the most under your rules.`
- Mini-UI: a slot list `QB · RB · RB · WR · WR · TE · FLEX` rendered at 40% opacity.
- No CTA link. Replace with a DM Mono line in `--text-muted`: `In progress · uses your synced roster`
- Card is not clickable, no hover state, no lock icon, no "notify me" (there is no email infra to back that promise). Do not hide the card: three tools is the story.

---

## 4. Social proof / credibility

**Verdict: skip testimonials and user counts.** The `users` table has a handful of rows and the `trades` table is days old. Thin numbers read worse than none to this audience.

**Substitute: a "How it's computed" strip.** Credibility through transparency, needs no data. Three short columns under the tool grid, each with a DM Mono eyebrow and two lines of body copy:

1. `REPLACEMENT LEVEL` — `Your roster slots and team count set the replacement line per position. A 12-team superflex league values QBs differently from a 10-team 1QB league, and the numbers reflect it.`
2. `YOUR SCORING, PER STAT` — `Projections are converted to points using your league's exact scoring table, not a PPR/half/standard preset.`
3. `FRESH DATA` — `Projections and injuries refresh daily during the season.` Beneath it, a live line pulled from the existing `/api/data-freshness` endpoint: `Last updated 2h ago`. This is real, available now, and signals the site is maintained.

**When to add real stats later:** when `trades` ≥ 500 or linked leagues ≥ 100, add one DM Mono line under the tools: `1,248 trades analyzed · 112 leagues linked`. Not before.

---

## 5. Sign-in integration

**Nav.** Reuse `#rr-nav` exactly: wordmark, `Draft` (→ `/draft`), `Trade`, dimmed `Lineup`, Clerk user button on the right (signed in) or `Sign In` button (signed out). The home page adds nothing to the nav.

**Signed out.** Hero as written in section 2.

**Signed in, no Sleeper username linked.**
- Headline unchanged.
- Sub-headline replaced: `One step left. Add your Sleeper username and every tool loads your league automatically.`
- Primary CTA: `Add Sleeper username` → the existing linking step. Secondary CTA unchanged.

**Signed in, Sleeper linked (the personalized "room").**
- Headline: `Welcome back, {sleeper_username}.`
- Sub-line in DM Mono: `{league name} · {team count}-TEAM · {scoring label} · {SF or 1QB}` from `/api/me/leagues`. If multiple leagues, show up to four as chips with the primary league first and `+N more`.
- Primary CTA: `Run a trade` → `/trade`. Secondary: `Open draft board` → `/draft`.
- Product frame becomes a **league card** listing their leagues with settings, same frame styling. If the API returns nothing, fall back to the trade frame.
- Tool grid and method strip below are unchanged. No news feed, no roster on the home page; that lives in the tools.

**Draft-in-progress banner (highest-value personalization, cheap).** If any linked league has a draft with status `drafting`, render a slim amber-bordered banner above the hero: `Your {league} draft is live → Open companion` linking to `/?companion=1&league_id={id}`. This is the one place the home page hands off to the query-param draft URL.

---

## 6. Visual design brief

### Palette

Keep every token in `shared/theme.css`. Add the following for the home page.

| Token | Value | Use |
|---|---|---|
| `--brand-400` | `#818cf8` | link hover, focus ring |
| `--brand-500` | `#6366f1` | primary CTA gradient start (matches icon + manifest theme) |
| `--brand-600` | `#8b5cf6` | primary CTA gradient end |
| `--brand-glow` | `rgba(99,102,241,0.18)` | hero radial glow only |
| `--text-body` | `rgba(255,255,255,0.62)` | multi-line paragraph copy (existing 45% is too low for sentences) |
| `--win` | `#10b981` | alias of `--success` for verdict UI |
| `--fair` | `#fbbf24` | alias of `--gold` |
| `--lose` | `#ef4444` | alias of `--danger` |

Existing tokens in play: `--bg-primary #000000`, `--bg-secondary #0a0a0a`, `--bg-card #111111`, `--bg-hover #181818`, `--border rgba(255,255,255,0.07)`, `--border-bright rgba(255,255,255,0.14)`, `--text-primary #ffffff`, `--text-secondary rgba(255,255,255,0.45)`, `--text-muted rgba(255,255,255,0.22)`, `--amber #f59e0b`, positions `--qb #ef4444`, `--rb #10b981`, `--wr #3b82f6`, `--te #a855f7`.

**Color discipline.** The page is monochrome black/white. Brand indigo appears in exactly four places: primary CTA fill, hero glow, logo tile, focus rings. Verdict green/gold/red and position colors appear only inside product frames and mini-UIs. That restraint is what makes the verdict colors read as data instead of decoration.

### Typography

| Role | Family | Weight | Size | Tracking | Line height |
|---|---|---|---|---|---|
| H1 headline | Plus Jakarta Sans | 800 | `clamp(2.25rem, 6vw, 4.25rem)` | -0.03em | 1.02 |
| Sub-headline | Plus Jakarta Sans | 400 | 1.125rem | 0 | 1.55 |
| H2 section title | Plus Jakarta Sans | 700 | 1.75rem | -0.02em | 1.15 |
| Card title | Plus Jakarta Sans | 700 | 1.2rem | -0.01em | 1.2 |
| Body / pitch | Plus Jakarta Sans | 400 | 0.95rem | 0 | 1.5 |
| Buttons | Plus Jakarta Sans | 600 | 0.9rem | 0 | 1 |
| Eyebrows, labels, numbers | DM Mono | 500 | 0.72rem | 0.08em, uppercase | 1 |
| Frame values | DM Mono | 500 | 0.85rem | 0 | 1 |

H1 uses `text-wrap: balance`. Sub-headline max-width 34rem.

### Layout

- Section backgrounds are full-bleed. Content is contained at **max-width 1120px** with 24px side padding (20px under 640px).
- Page order: nav → (optional draft banner) → hero → tool grid → method strip → footer.
- Hero: 2-column grid `1.1fr / 0.9fr`, 64px gap, items vertically centered, `min-height: 78vh` (not 100vh; the tool grid should peek above the fold on a 900px-tall laptop). Padding 96px top, 80px bottom.
- Tool grid: 3 columns, 20px gap.
- Method strip: 3 columns, 32px gap, top border `--border`, padding 64px vertical.
- Footer: one row. Left: `RoundRoom` wordmark and `Built for Sleeper leagues`. Right: `Draft · Trade · Lineup` text links. DM Mono, `--text-muted`. Padding 40px.

### Spacing philosophy

Generous between sections, dense inside components. The tools are dense by nature; the home page earns contrast by breathing. Section padding 96px desktop / 64px mobile. Card padding 24px. Stack gap inside cards 12px. Radii: 6px for buttons and chips (matches nav), 12px for cards, 16px for hero frames.

### Motion

Minimal. Card hover 120ms border/background. Primary CTA hover: brightness 1.08, no transform. Product frame: static. Honor `prefers-reduced-motion`. No scroll-triggered reveals, no parallax, no count-up.

### CSS variables to define (additions only)

```
--brand-400, --brand-500, --brand-600, --brand-glow
--text-body
--win, --fair, --lose
--container: 1120px
--section-pad: 96px   (64px under 768px)
--card-pad: 24px
--radius-sm: 6px  --radius-md: 12px  --radius-lg: 16px
--font-sans: 'Plus Jakarta Sans', system-ui, sans-serif
--font-mono: 'DM Mono', monospace
--nav-h: 52px
```

### Page metadata

- `<title>`: `RoundRoom — Draft, trade, and lineup tools scored to your Sleeper league`
- Meta description: the sub-headline.
- OG image: 1200×630, black, the trade verdict frame centered, wordmark top-left. Generate from `logo-1200.svg` styling; static PNG at `/og.png`.
- `theme-color` stays `#6366f1`.

---

## 7. Mobile experience (375px reference)

**Hero stacks, in this order:** headline → sub-headline → primary CTA (full width) → secondary CTA (full width) → proof strip → product frame (100% width, max 420px, centered). The frame is not hidden on mobile; it is the differentiator.

**Tool cards** go single column, full width, 16px gap, in the same order. Mini-UI strips stay but cap at three rows / ~100px.

**Method strip** goes single column, 32px gap.

**What breaks first at 375px, and the fix:**
1. Headline: "Scored" orphans on its own line. Fix: `clamp` floor of 2.25rem plus `text-wrap: balance`. Do not insert manual `<br>`.
2. Two CTAs side by side overflow. Fix: stack under 640px, primary first, each ≥44px tall.
3. Hero frame's two player columns collapse into unreadable 150px columns. Fix: under 420px, render GIVE and GET as two stacked groups with a divider, rows full width.
4. Proof strip wraps mid-fact ("VORP, NOT" / "ADP"). Fix: each fact is a `white-space: nowrap` chip in a `flex-wrap` row with 8px gap; drop the `·` separators when wrapped.
5. Nav: wordmark + three links + Sign In is tight. Fix: under 400px, reduce `.rr-link` horizontal padding to 0.5rem and hide the dimmed `Lineup` link. Keep nav height ≤52px.
6. Draft banner text truncates. Fix: league name gets `text-overflow: ellipsis`, the `Open companion` link stays visible.

Touch targets ≥44px everywhere. No hover-only affordances carry meaning.

---

## 8. Acceptance checklist for the implementing agent

- [ ] `/` with empty query serves the home page; `/?companion=1`, `/?league_id=x`, and `/?companion=1&league_id=x` serve `index.html` byte-identical to before.
- [ ] `/draft` serves `index.html`. Nav "Draft" link on the home page and on `/trade` points to `/draft`.
- [ ] Signed-out, signed-in-unlinked, and signed-in-linked hero states all render with the copy in sections 2 and 5.
- [ ] Draft-in-progress banner appears only when a linked league reports a live draft.
- [ ] Data freshness line reads from `/api/data-freshness`.
- [ ] Lineup card has no link, no hover state, and is visibly "coming soon."
- [ ] Lighthouse mobile: no layout shift from fonts (use `font-display: swap`, already in the Google Fonts URL), no horizontal scroll at 375px.
- [ ] No new font families, no images other than `/og.png`.
