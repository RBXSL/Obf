# main.py
import os
import re
import base64
import random
import string
import asyncio
from datetime import datetime, timedelta

import discord
from discord import app_commands
from discord.ext import commands, tasks
from aiohttp import web

# -------------------------
# Config
# -------------------------
DISCORD_TOKEN = os.environ.get("DISCORD_TOKEN")
if not DISCORD_TOKEN:
    raise RuntimeError("DISCORD_TOKEN environment variable not set")

ACTIVATION_TTL = timedelta(minutes=10)  # how long /obf activation lasts for a user
MAX_INLINE_REPLY = 1800  # characters. If output > this, send as file.

# -------------------------
# Activation store
# -------------------------
# activated_users: dict[user_id -> expiry_datetime]
activated_users = {}

def activate_user(user_id: int):
    activated_users[user_id] = datetime.utcnow() + ACTIVATION_TTL

def is_user_activated(user_id: int) -> bool:
    exp = activated_users.get(user_id)
    if not exp:
        return False
    if exp < datetime.utcnow():
        activated_users.pop(user_id, None)
        return False
    return True

def remove_activation(user_id: int):
    activated_users.pop(user_id, None)

# Periodic cleanup (just in case)
async def cleanup_expired():
    now = datetime.utcnow()
    for uid, exp in list(activated_users.items()):
        if exp < now:
            activated_users.pop(uid, None)

# -------------------------
# Lua obfuscation utilities
# -------------------------

LUA_KEYWORDS = {
    "and","break","do","else","elseif","end","false","for","function","goto","if",
    "in","local","nil","not","or","repeat","return","then","true","until","while"
}

# Helper: random identifier generator
def rand_ident(n=8):
    return "_" + "".join(random.choice(string.ascii_letters) for _ in range(n))

# Strip comments (single-line --... and long --[[...]] with nesting not supported)
def strip_comments(code: str) -> str:
    # Remove long-bracket comments first: --[[ ... ]] or --[=[ ... ]=]
    code = re.sub(r'--\[(=*)\[(?:.|\n)*?\]\1\]', '', code)
    # Remove single-line comments
    code = re.sub(r'--[^\n\r]*', '', code)
    return code

# Extract string literals and replace with placeholders
STRING_RE = re.compile(r"(['\"])(?:\\.|(?!\1).)*\1", re.DOTALL)

def extract_strings(code: str):
    strings = []
    def repl(m):
        s = m.group(0)
        strings.append(s)
        return f"__STR_PLACEHOLDER_{len(strings)-1}__"
    out = STRING_RE.sub(repl, code)
    return out, strings

# Re-insert decoding placeholders. We'll encode each string with XOR+base64 and create runtime decoder.
def encode_strings(strings):
    enc = []
    for raw in strings:
        # raw includes surrounding quotes. remove them and decode simple escapes conservatively.
        inner = raw[1:-1]
        # replace common escapes so we encode exact bytes
        inner = inner.encode('utf-8').decode('unicode_escape')
        key = random.randint(1, 255)
        b = inner.encode('utf-8')
        xb = bytes([c ^ key for c in b])
        b64 = base64.b64encode(xb).decode('ascii')
        enc.append((key, b64))
    return enc

# Build Lua decoder snippet (prepended)
def build_decoder_lua(enc_list):
    # enc_list: list of tuples (key, b64)
    b64_array = ", ".join(f'"{b64}"' for (_, b64) in enc_list)
    key_array = ", ".join(str(key) for (key, _) in enc_list)

    decoder = f"""
-- obfuscator runtime decoder
local __S = {{ {b64_array} }}
local __K = {{ {key_array} }}

local function __b64decode(s)
  local b='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  s = string.gsub(s, '[^'..b..'=]', '')
  return (s:gsub('.', function(x)
    if (x == '=') then return '' end
    local r,f='', (string.find(b, x)-1)
    for i=6,0,-1 do r = r .. (math.floor(f/2^i) % 2) end
    return r
  end):gsub('%d%d%d?%d?%d?%d?%d?%d', function(x)
    local c=0
    for i=1,8 do c = c*2 + (x:sub(i,i)=='1' and 1 or 0) end
    return string.char(c)
  end))
end

local function __decode(i)
  local b64 = __S[i]
  local key = __K[i]
  local raw = __b64decode(b64)
  local out = {{}}
  for j=1,#raw do
    local vb = string.byte(raw, j)
    out[#out+1] = string.char((vb ~ key) % 256)
  end
  return table.concat(out)
end

"""
    return decoder

# Find identifiers and map to new names (conservative)
IDENT_RE = re.compile(r'\b([A-Za-z_][A-Za-z0-9_]*)\b')

def rename_identifiers(code_without_strings: str):
    # find identifiers
    ids = set(m.group(1) for m in IDENT_RE.finditer(code_without_strings))
    # filter out keywords and common globals
    skip_patterns = re.compile(r'^(_G$|io$|os$|math$|string$|table$|coroutine$)$')
    candidates = [i for i in ids if i not in LUA_KEYWORDS and not skip_patterns.match(i) and not i.isdigit()]
    # sort by length desc to avoid partial replacements
    candidates.sort(key=lambda s: -len(s))
    mapping = {}
    for name in candidates:
        mapping[name] = rand_ident(6)
    # apply replacements (word boundaries)
    def repl(m):
        s = m.group(1)
        return mapping.get(s, s)
    new_code = re.sub(r'\b([A-Za-z_][A-Za-z0-9_]*)\b', repl, code_without_strings)
    return new_code, mapping

# Minify lightly
def minify(code: str) -> str:
    # collapse multiple spaces
    code = re.sub(r'[ \t]+', ' ', code)
    # remove extra blank lines
    code = re.sub(r'\n{2,}', '\n', code)
    # trim leading/trailing spaces on lines
    code = "\n".join(line.strip() for line in code.splitlines())
    return code

def obfuscate_lua(input_code: str) -> str:
    # 1) remove comments
    no_comments = strip_comments(input_code)

    # 2) extract strings and encode them
    with_placeholders, strings = extract_strings(no_comments)
    enc_list = encode_strings(strings)

    # replace placeholders with runtime decoder calls: (__decode(i))
    replaced = with_placeholders
    for i in range(len(strings)):
        replaced = replaced.replace(f"__STR_PLACEHOLDER_{i}__", f"(__decode({i+1}))")

    # 3) rename identifiers (operate on code with placeholders)
    renamed_code, mapping = rename_identifiers(replaced)

    # 4) minify
    final = minify(renamed_code)

    # 5) prepend decoder
    decoder = build_decoder_lua(enc_list)
    return decoder + "\n" + final

# -------------------------
# Discord bot setup
# -------------------------
intents = discord.Intents.default()
intents.message_content = True
intents.guilds = True
intents.direct_messages = True

bot = commands.Bot(command_prefix="!", intents=intents)

# Registering slash command via app_commands
class Obf(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    @app_commands.command(name="obf", description="Activate you to obfuscate a .lua file by mentioning the bot with the attachment")
    async def obf(self, interaction: discord.Interaction):
        # Activate this user
        activate_user(interaction.user.id)
        await interaction.response.send_message(
            "Activated for obfuscation. Now send a message that **mentions me** and includes your `.lua` attachment in the same message. Activation lasts "
            f"{ACTIVATION_TTL.total_seconds()//60:.0f} minutes.", ephemeral=True
        )

# Add Cog and sync commands on ready
@bot.event
async def on_ready():
    await bot.add_cog(Obf(bot))
    try:
        # sync app commands globally (can be set to guild-specific for faster update during dev)
        await bot.tree.sync()
        print("Slash commands synced.")
    except Exception as e:
        print("Failed to sync commands:", e)
    print(f"Bot ready: {bot.user} (id: {bot.user.id})")

# Handle incoming messages that mention bot + have .lua attachment, and user must be activated
@bot.event
async def on_message(message: discord.Message):
    # ignore bots and DMs without attachments
    if message.author.bot:
        return

    # only process messages that mention the bot
    if not message.mentions or bot.user not in message.mentions:
        await bot.process_commands(message)
        return

    # check for attachments
    if not message.attachments:
        await bot.process_commands(message)
        return

    # check activation
    if not is_user_activated(message.author.id):
        # optionally inform user privately
        try:
            await message.reply("You need to use `/obf` first to activate. Use `/obf` (ephemeral confirmation) then send a message that mentions me and attaches the .lua file.")
        except Exception:
            pass
        await bot.process_commands(message)
        return

    # find the first .lua attachment
    lua_att = None
    for att in message.attachments:
        fname = att.filename.lower()
        if fname.endswith(".lua") or ('.lua' in fname and fname.split('.')[-1] == 'lua'):
            lua_att = att
            break

    if not lua_att:
        await message.reply("No .lua attachment found. Please attach a `.lua` file in the same message that mentions me.")
        await bot.process_commands(message)
        return

    # download file content
    try:
        raw = await lua_att.read()
        code_text = raw.decode('utf-8', errors='replace')
    except Exception as e:
        await message.reply(f"Failed to download attachment: {e}")
        await bot.process_commands(message)
        return

    # obfuscate (run in executor to avoid blocking event loop if large)
    loop = asyncio.get_running_loop()
    try:
        obf_text = await loop.run_in_executor(None, obfuscate_lua, code_text)
    except Exception as e:
        await message.reply(f"Obfuscation failed: {e}")
        await bot.process_commands(message)
        return

    # send back result (file if large)
    if len(obf_text) > MAX_INLINE_REPLY:
        # send as file
        try:
            await message.reply(content="Obfuscated file:", file=discord.File(fp=discord.utils.io.BytesIO(obf_text.encode('utf-8')), filename="obf.lua"))
        except Exception:
            # fallback to uploading via send
            await message.channel.send(file=discord.File(fp=discord.utils.io.BytesIO(obf_text.encode('utf-8')), filename="obf.lua"))
    else:
        # paste inline in codeblock
        safe_block = "```lua\n" + obf_text + "\n```"
        await message.reply(safe_block)

    # remove activation (optional) so user must call /obf again for next file
    remove_activation(message.author.id)

    await bot.process_commands(message)

# -------------------------
# Small aiohttp server for health checks (useful for Render + UptimeRobot)
# -------------------------
async def handle_health(request):
    return web.Response(text="ok")

async def start_webserver():
    app = web.Application()
    app.add_routes([web.get("/health", handle_health)])
    runner = web.AppRunner(app)
    await runner.setup()
    port = int(os.environ.get("PORT", 3000))
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()
    print(f"Health server running on port {port}")

# -------------------------
# Entry point
# -------------------------
async def main():
    # start webserver
    await start_webserver()

    # background cleanup task
    async def periodic_cleanup():
        while True:
            try:
                await cleanup_expired()
            except Exception:
                pass
            await asyncio.sleep(60)

    bot.loop.create_task(periodic_cleanup())

    # start bot
    await bot.start(DISCORD_TOKEN)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Shutting down")
