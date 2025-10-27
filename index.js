// index.js
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');
const { Client, IntentsBitField, Partials } = require('discord.js');
const { obfuscateLua } = require('./obfuscator');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN env var");
  process.exit(1);
}

// Bot config
const MAX_INLINE = 1900; // characters; Discord codeblock limit safety
const PORT = process.env.PORT || 3000;

// Create discord client
const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
    IntentsBitField.Flags.DirectMessages
  ],
  partials: [Partials.Channel]
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// Simple text command: !obf with code block or .lua attachment in same message
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    const content = message.content || '';

    // Trigger only when message starts with !obf
    if (!content.trim().startsWith('!obf')) return;

    // Prefer attachments
    if (message.attachments.size > 0) {
      const att = message.attachments.first();
      // fetch file by URL (Node 18+ provides global fetch)
      try {
        const res = await fetch(att.url);
        const txt = await res.text();
        const ob = obfuscateLua(txt);
        await sendObfuscatedResult(message, ob);
        return;
      } catch (e) {
        console.error('Attachment fetch error', e);
        await message.reply('Failed to fetch attachment: ' + String(e).slice(0,200));
        return;
      }
    }

    // parse code block: ```lua\n...\n```
    const m = content.match(/```(?:lua)?\n([\s\S]*?)```/);
    if (m) {
      const code = m[1];
      const ob = obfuscateLua(code);
      await sendObfuscatedResult(message, ob);
      return;
    }

    // fallback: message body may be raw code (short)
    if (content.trim().length > 5) {
      // strip the command header
      const after = content.replace(/^!obf\s*/i, '');
      if (after.trim().length > 0) {
        const ob = obfuscateLua(after);
        await sendObfuscatedResult(message, ob);
        return;
      }
    }

    await message.reply('Usage: send `!obf` plus either a `.lua` attachment in the same message or include Lua in triple backticks (```lua\n...\n```).');

  } catch (err) {
    console.error('messageCreate error', err);
    try { await message.reply('Obfuscation error: ' + String(err).slice(0,200)); } catch {}
  }
});

async function sendObfuscatedResult(message, ob) {
  try {
    if (Buffer.byteLength(ob, 'utf8') > MAX_INLINE) {
      // send as file
      const buffer = Buffer.from(ob, 'utf8');
      await message.reply({ content: 'Obfuscated result (file):', files: [{ attachment: buffer, name: 'obf.lua' }] });
    } else {
      await message.reply('```lua\n' + ob + '\n```');
    }
  } catch (e) {
    console.error('sendObfuscatedResult error', e);
    try { await message.reply('Failed to send result: ' + String(e).slice(0,200)); } catch {}
  }
}

// Simple express server for /health and /api/obfuscate
const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

app.get('/health', (req, res) => res.send('ok'));

app.post('/api/obfuscate', (req, res) => {
  const { code } = req.body || {};
  if (!code || typeof code !== 'string') return res.status(400).json({ error: 'missing code (string)' });
  try {
    const ob = obfuscateLua(code);
    res.json({ result: ob });
  } catch (e) {
    console.error('api obfuscate error', e);
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

// Start Discord bot
client.login(DISCORD_TOKEN).catch(err => {
  console.error('Failed to login:', err);
  process.exit(1);
});
