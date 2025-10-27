// obfuscator.js
// Lightweight Lua obfuscator: string XOR+base64, variable renaming, comment removal, light minify

const crypto = require('crypto');

function randId(len = 6) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random()*chars.length)];
  return '_' + s;
}

// Remove comments (single line --... and long bracket --[[...]] / --[=[...]=])
function stripComments(code) {
  // Remove long bracket comments first
  code = code.replace(/--\[(=*)\[(?:[\s\S]*?)\]\1\]/g, '');
  // Remove single-line comments
  code = code.replace(/--[^\n\r]*/g, '');
  return code;
}

// Extract string literals and replace with placeholders
const STRING_RE = /(['"])(?:\\.|(?!\1).)*?\1/g;

function extractStrings(code) {
  const strings = [];
  const replaced = code.replace(STRING_RE, (m) => {
    strings.push(m);
    return `__STR_PLACEHOLDER_${strings.length - 1}__`;
  });
  return { replaced, strings };
}

function encodeStringLiteral(s) {
  // s contains the raw inner string (no quotes). We'll XOR with a single-byte key then base64.
  const key = Math.floor(Math.random() * 255) + 1; // 1..255
  const buf = Buffer.from(s, 'utf8');
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key;
  return { key, b64: out.toString('base64') };
}

const LUA_KEYWORDS = new Set([
  "and","break","do","else","elseif","end","false","for","function","goto","if",
  "in","local","nil","not","or","repeat","return","then","true","until","while"
]);

// Conservative identifier renamer
function findIdentifiers(code) {
  // temporarily strip simple strings so identifiers inside them won't be picked
  const placeholders = [];
  const tmp = code.replace(STRING_RE, function(m){
    placeholders.push(m);
    return `__STR_PLACEHOLDER_SAFE_${placeholders.length-1}__`;
  });

  const ids = new Set();
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let m;
  while ((m = re.exec(tmp)) !== null) {
    const id = m[1];
    if (!LUA_KEYWORDS.has(id) && !/^[0-9]+$/.test(id)) ids.add(id);
  }
  return Array.from(ids);
}

function obfuscateLua(code) {
  // 1) Strip comments
  let c = stripComments(code);

  // 2) Extract string literals
  const { replaced, strings } = extractStrings(c);

  // 3) Encode each string literal (remove surrounding quotes and unescape simple sequences)
  const encoders = [];
  for (let i = 0; i < strings.length; i++) {
    const raw = strings[i]; // includes quotes
    let inner = raw.slice(1, -1);
    // handle simple escapes conservatively
    inner = inner.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
                 .replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const enc = encodeStringLiteral(inner);
    encoders.push(enc);
  }

  // 4) Replace placeholders with runtime decode calls
  let codeWithDecodeCalls = replaced;
  for (let i = 0; i < encoders.length; i++) {
    codeWithDecodeCalls = codeWithDecodeCalls.replace(
      new RegExp(`__STR_PLACEHOLDER_${i}__`, 'g'),
      `(__decode(${i+1}))`
    );
  }

  // 5) Identifier renaming (conservative)
  const ids = findIdentifiers(codeWithDecodeCalls);
  // sort by length desc
  ids.sort((a,b) => b.length - a.length);

  const skipRegex = /^(?:_G|io|os|math|string|table|coroutine|package|debug)$/;
  const mapping = {};
  for (const id of ids) {
    if (skipRegex.test(id)) continue;
    if (/^\d+$/.test(id)) continue;
    // avoid renaming Lua keywords
    if (LUA_KEYWORDS.has(id)) continue;
    // generate mapping
    mapping[id] = randId(6);
  }

  // replace identifiers using word boundary
  const idKeys = Object.keys(mapping);
  let renamed = codeWithDecodeCalls;
  for (const oldId of idKeys) {
    const newId = mapping[oldId];
    renamed = renamed.replace(new RegExp(`\\b${oldId}\\b`, 'g'), newId);
  }

  // 6) Light minify
  renamed = renamed.replace(/[ \t]{2,}/g, ' ');
  renamed = renamed.replace(/\r\n/g, '\n');
  renamed = renamed.replace(/\n{2,}/g, '\n');
  renamed = renamed.split('\n').map(l => l.trim()).join('\n');

  // 7) Build decoder snippet
  const S_b64 = encoders.map(e => e.b64);
  const S_key = encoders.map(e => e.key);

  const decoderLua = `
-- obfuscator runtime decoder
local __S = { ${S_b64.map(s => '"' + s.replace(/"/g, '\\"') + '"').join(', ')} }
local __K = { ${S_key.join(', ')} }
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
  local out = {}
  for j=1,#raw do
    local vb = string.byte(raw, j)
    out[#out+1] = string.char((vb ~ key) % 256)
  end
  return table.concat(out)
end
`;

  const final = decoderLua + "\n" + renamed;
  return final;
}

module.exports = { obfuscateLua };
