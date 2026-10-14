# Pocket NBA offline cheat sheet (stream S2)

A single self-contained HTML file (inline CSS + JS, zero network requests) for the Wed Oct 14 8pm PT draft
(league 242808: 12 teams, snake, 90s, PTS 1 / REB 1.2 / AST 1.5 / STL 3 / BLK 3 / TO -1 / PF -1 / TECH -1 / DD +5 / TD +3,
slots PG SG G SF PF F C UTIL UTIL + BN5 + IL2). It is the fallback if the live draft page or Yahoo is down.

## Regenerate

```
node scripts/nba-cheatsheet.js                       # -> dist/nba-cheatsheet.html, nba-board.csv, nba-board.md
node scripts/nba-cheatsheet.js --top 300 --out /tmp/sheet
node scripts/nba-cheatsheet.js --api https://<deployed-host>      # build from /api/nba/players?profile=242808
node scripts/nba-cheatsheet.js --from-json saved-players.json     # build from a saved /api/nba/players response
node scripts/nba-cheatsheet.js --refresh-stats                    # re-pull Sleeper per-stat projections into the fixture (needs network)
node scripts/nba-cheatsheet.js --td-also-dd false                 # a triple-double pays TD only (default: it also pays DD)
```

Flags: `--profile <id>` (default 242808), `--out <dir>` (default `dist/`, git-ignored), `--top N` (default 400; the
markdown print sheet is always the top 200), `--from-json`, `--api`, `--refresh-stats`, `--td-also-dd`.
Run `node scripts/test-nba-cheatsheet.js` to verify (exit 0).

## Where the values come from

Footer of the sheet stamps `values:` plus generated-at and data as-of.

1. **profile** — JSON that carries a `profile` field (the H1 `/api/nba/players?profile=` response), or the model when
   `nba/league-profile.js` exists and the model returns `profile`. Used as-is (`hsValue`).
2. **adapter** (current default in trees without H1) — `scripts/lib/league-score.js`. The model values players on Yahoo
   High Score (pts+reb+2ast+3stl+3blk) and game logs keep only that total, so per-stat rates come from
   `scripts/fixtures/nba-cheat-stats.json` (Sleeper 2026 per-game projection snapshot). Per player
   `ratio = league score per game / HS per game`, and value, mean, sd, floor and ceiling are scaled by it.
   Players without a projection get the median ratio. Approximations: PF is estimated (0.066/min), TECH 0.02/game,
   and the DD/TD bonus is treated as a mean shift (it really makes the distribution spikier: more upside than shown).
3. Tiers are recomputed on the final values (big drop, or at most 12 players per tier).

Eligibility is derived from Sleeper positions (low confidence): PG<-PG; SG<-SG/G; G<-PG,SG; SF<-SF/F; PF<-PF/F;
F<-SF,PF; C<-C; UTIL<-anyone. Pure C is not F-eligible. Confirm real slots in the Yahoo draft room.

## Using it

- Board: sort by tapping headers, filter by slot chips, accent-insensitive search ("jokic" finds Jokić).
  Tap a row = taken by someone else; the star = my pick; tap a drafted row (with "Hide drafted" off) to restore it; Undo pops the last mark.
  State persists in `localStorage` on that device/browser (key `pocket-nba-s2-<profile>`).
- My team: 9 starter slots auto-filled (best fit by matching), open slots highlighted, bench 5, IL 2 note, best available for
  open slots. Set "My draft slot" once the order is drawn to see your next pick numbers (snake).
- By slot: top 30 available per slot. Rounds: rounds 1-16 by slot, the two best still-available players with tier.
- `nba-board.md` / `nba-board.csv`: print/paste copies of the same board (static snapshot).

## Getting it on a phone

1. `node scripts/nba-cheatsheet.js`, then AirDrop `dist/nba-cheatsheet.html` to the phone (or save to iCloud Drive / Files).
2. Open it from the Files app (Quick Look can show it, but open in Safari for working localStorage and tapping:
   Share -> "Open in Safari", or `Safari > file`). Add it to Home Screen from Safari if you like.
3. No network is needed at any point; airplane mode is fine.
4. localStorage is per browser and per file location: always open it the same way during the draft. Tapping a row in
   Quick Look is not persisted; use Safari/Chrome.

Screens checked in Chromium at 375x812 and 1280x800 from `file://`: `docs/nba-ui/s2-*.png`.
