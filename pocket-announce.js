#!/usr/bin/env node
/**
 * pocket-announce.js — post or edit a Pocket announcement in Discord
 *
 * Post:
 *   DISCORD_WEBHOOK_URL=<url> node pocket-announce.js --title "..." --desc "..." --features "F1,F2" --version "1.0"
 *
 * Edit an existing message:
 *   DISCORD_WEBHOOK_URL=<url> node pocket-announce.js --edit <message_id> --title "..." --desc "..." --features "F1,F2"
 */

const POCKET_PURPLE = 0x7c3aed;
const APP_URL = process.env.APP_URL || "https://pocketff.com";
const LOGO_URL = `${APP_URL}/pocket-logo-primary.png`;

function buildEmbed({ title, description, features = [], version }) {
  const featureLines = features.join("\n");
  const descBlock = [
    description || null,
    features.length ? `\n**What's new**\n${featureLines}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const versionTag = version ? ` · v${version}` : "";

  return {
    author: { name: `Pocket${versionTag}`, url: APP_URL, icon_url: LOGO_URL },
    title,
    url: APP_URL,
    description: descBlock || null,
    color: POCKET_PURPLE,
    footer: { text: "pocket.gg  ·  SLEEPER NATIVE · VORP, NOT ADP · FREE", icon_url: LOGO_URL },
    timestamp: new Date().toISOString(),
  };
}

async function announce({ title, description, features = [], version }) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) throw new Error("Missing DISCORD_WEBHOOK_URL env var");

  const resp = await fetch(`${webhookUrl}?wait=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "Pocket",
      avatar_url: LOGO_URL,
      embeds: [buildEmbed({ title, description, features, version })],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Discord webhook failed: ${resp.status} ${text}`);
  }

  const msg = await resp.json();
  return msg.id;
}

async function edit(messageId, { title, description, features = [], version }) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) throw new Error("Missing DISCORD_WEBHOOK_URL env var");

  const resp = await fetch(`${webhookUrl}/messages/${messageId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [buildEmbed({ title, description, features, version })],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Discord edit failed: ${resp.status} ${text}`);
  }

  return messageId;
}

module.exports = { announce, edit };

// CLI entrypoint
if (require.main === module) {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }

  if (!args.title) {
    console.error(
      "Post:  node pocket-announce.js --title <title> [--desc <desc>] [--features <f1,f2>] [--version <v>]\n" +
      "Edit:  node pocket-announce.js --edit <message_id> --title <title> [--desc <desc>] [--features <f1,f2>]"
    );
    process.exit(1);
  }

  const features = args.features ? args.features.split("|").map((f) => f.trim()) : [];
  const desc = args.desc ? args.desc.replace(/\\n/g, "\n") : undefined;
  const payload = { title: args.title, description: desc, features, version: args.version };

  const action = args.edit
    ? edit(args.edit, payload).then((id) => console.log(`✓ Message ${id} updated`))
    : announce(payload).then((id) => console.log(`✓ Posted — message ID: ${id}`));

  action.catch((err) => { console.error("Error:", err.message); process.exit(1); });
}
