#!/usr/bin/env node
const GUIDES_WH =
  "https://discord.com/api/webhooks/1547380016252330148/7vF5sB1SqGf_FgVM3cA5rjn-u_ypTz8aiWwIkV-R2mPLamB5f1DhJmErhd0qFoognVKO";
const APP_URL = "https://pocketff.com";
const LOGO = `${APP_URL}/pocket-logo-primary.png`;
const COLOR = 0x7c3aed;

const GUIDES = [
  {
    title: "Draft Board — Best Available, Ranked by VORP",
    description: `The Draft Board is the core of Pocket. It sits open next to your Sleeper draft and tells you who's actually worth taking.

The difference: **VORP**, not **ADP**. ADP tells you where the crowd is drafting a player. VORP (**Value Over Replacement Player**) tells you how much that player beats the guy you could grab off the wire at the same position. That gap is where drafts get won.

**What it does**
• **Live Sleeper sync** — picks vanish from the board the moment they're made, no refreshing
• **Position filters** — QB / RB / WR / TE / K to zero in when you know what you need
• **Click any player** for projections, injury status, and depth chart position without leaving the board
• **Your league's actual settings** — scoring and roster requirements pull from Sleeper, so a TE Premium board looks different from a standard one

**How to open it**
Go to https://pocketff.com, hit **Draft Board**, and connect your league. During a live draft, use **Companion Mode** (see the next guide) to dock it beside Sleeper.

One habit that pays off: when two players feel equal, check the VORP gap before you check the name.`,
  },
  {
    title: "Companion Mode — Pocket Beside Your Sleeper Draft",
    description: `Companion Mode is how you're meant to use the Draft Board on draft night. Instead of flipping between tabs while a 30-second clock runs down, Pocket opens in a **side panel** right next to the Sleeper draft room.

Sleeper still handles the actual pick. Pocket just tells you who to take.

**One-time setup**
• Open the **Draft Board** page at https://pocketff.com
• Find the **bookmarklet** and drag it to your browser's bookmarks bar
• That's it — you never set it up again

**On draft night**
• Open your Sleeper **live draft room**
• Click the bookmarklet
• Pocket slides in alongside it, synced to that draft

**Why it matters**
• No tab switching, no lost context, no timer panic
• VORP rankings update live as picks come in
• You're reading one screen instead of reconciling two

**Heads up:** desktop only. The bookmarklet needs a real browser bookmarks bar, so phones and the Sleeper app are out. Set it up before draft day — not during.`,
  },
  {
    title: "Trade Calculator — Who Wins, and Does It Fit",
    description: `Drop players on both sides of a proposed trade and Pocket scores each side on **VORP-based valuations**, then tells you who wins and by how much.

That's the paper answer. The more useful one comes next.

**Roster Fit**
With Sleeper connected, Pocket also runs **Roster Fit** — it checks whether the players coming back actually fill a hole on *your* roster. Winning a trade by 12 points of value means nothing if you're trading your RB2 for a fourth WR you'll never start. Roster Fit catches that before you hit send.

**Also on every player**
• **Injury flags** — surfaced inline so nobody sneaks a Questionable-forever guy past you
• Value shown per player, not just per side, so you can see who's carrying the deal

**How to use it well**
• Run the trade you're about to send, then run the counter you expect back
• If the value is close but Roster Fit favors you, that's a good trade — take it
• If you win big on value but Roster Fit is flat, ask what you're actually solving`,
  },
  {
    title: "Your Team + Lineup — Roster Truth and Weekly Calls",
    description: `Two tabs that work as a pair. Both need **Sleeper connected**.

**Your Team** — the honest read on your roster
• **Tier grades** (**S / A / B / C**) on every player so you can see your real core at a glance
• **Projected points** per player and **injury status** inline
• **Positional depth** laid out visually — where you're stacked, where you're one injury from trouble

Use it for the medium-term stuff: spotting the position to attack on waivers, and mapping **bye weeks** before they catch you in Week 9.

**Lineup** — the call for this week
• **Start/sit recommendations** with **matchup-adjusted projections**
• **Lock** the players you're already starting and Pocket optimizes the rest around them

The lock feature is the part people miss. Lock your obvious studs, then let Pocket sort out the flex spot you've been staring at for twenty minutes.

**Weekly rhythm that works**
• Tuesday: check **Your Team** for depth gaps, set waiver claims
• Sunday morning: open **Lineup**, lock your certainties, take the recommendation on the rest`,
  },
  {
    title: "Research — Player Profiles That Settle Arguments",
    description: `Search any player, get the full picture. **No Sleeper connection needed** — Research works standalone, so you can use it before you've linked a league or during someone else's draft.

**What's in a profile**
• **Projections** for the season and week
• **Target share** and **snap count** — the usage numbers that predict production instead of just describing it
• **Depth chart position** — who's actually ahead of them
• **Injury history**, not just current status

**Where you'll actually use it**
• **During draft prep** — two guys next to each other on the board and no gut feeling. Target share and snap count break the tie.
• **Inline on the Draft Board** — click any player mid-draft and the profile opens without leaving the board. No tab switch, no lost place in the queue.
• **Mid-season** — vetting a trade target before you commit. Usage trends tell you whether a hot three weeks is real or noise.

The usage stats are the whole point. Projections are a guess about the future; **snaps and targets are what a coaching staff has already decided**.`,
  },
];

async function postGuide({ title, description }) {
  const resp = await fetch(`${GUIDES_WH}?wait=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "Pocket",
      avatar_url: LOGO,
      embeds: [
        {
          author: { name: "Pocket Guides", icon_url: LOGO },
          title,
          url: APP_URL,
          description,
          color: COLOR,
          footer: {
            text: "pocket.gg  ·  SLEEPER NATIVE · VORP, NOT ADP · FREE",
            icon_url: LOGO,
          },
          timestamp: new Date().toISOString(),
        },
      ],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status}: ${text}`);
  }

  const msg = await resp.json();
  return msg.id;
}

(async () => {
  const ids = [];
  for (const guide of GUIDES) {
    const id = await postGuide(guide);
    console.log(`✓ "${guide.title}" → ${id}`);
    ids.push({ title: guide.title, id });
    await new Promise((r) => setTimeout(r, 800));
  }
  console.log("\nMessage IDs:");
  ids.forEach(({ title, id }) => console.log(`  ${id}  ${title}`));
})();
