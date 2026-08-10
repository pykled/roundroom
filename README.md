# NFL Fantasy Draft Assistant 2026

A sleek, single-file live draft assistant for Sleeper leagues.

## Usage

Open `index.html` in a browser — no server needed, no build step.

1. Enter your Sleeper username (default: `pykle`)
2. Select your 2026 league
3. Hit **Start Draft Assistant**

## Features

- **Live draft sync** — polls Sleeper every 5s, marks drafted players automatically
- **Tiered player board** — ADP gaps + stdev used to compute tier breaks
- **4 draft strategies** — BPA, Zero RB, Hero RB, Robust RB
- **Survival probability** — chance a player survives to your next snake-draft pick
- **Target/Avoid system** — persisted in localStorage
- **Scarcity bars** — how many of each position remain in the top 80 ADP
- **Roster auto-fill** — your picks auto-populate your roster view
- **Pick log** — scrollable history of all picks

## Data Sources

- ADP: `fantasyfootballcalculator.com` (no auth, CORS-safe)
- Live picks + player DB: `api.sleeper.app` (no auth, CORS-safe)
