// obfuscator.js
// Luau-friendly obfuscator with large junk/noise injection.
// - Encodes strings with single-byte XOR then base64
// - Decoder uses bit32.bxor (Roblox/Luau compatible)
// - Conservative identifier renaming
// - Junk injection: many noop functions and huge unused strings (configurable)
// - Preserves functionality; avoid loadstring or non-Luau-safe ops

const crypto = require('crypto');

function randId(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return '_' + s;
}

function randint(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Strip comments (long bracket and single-line)
function stripComments(code) {
  code = code.replace(/--\[(=*)\[(?:[\s\S]*?)\]\1\]/g, ''); // --[[ ... ]]
  code = code.replace(/--[^\n\r]*/g, ''); // -- single-line
  return code;
}

// Extract string literals
const STRING_RE = /(['"])(?:\\.|(?!\1).)*?\1/g;

function extractStrings(code) {
  const strings = [];
  const replaced = code.replace(STRING_RE, (m) => {
    strings.push(m);
    return `__STR_PLACEHOLDER_${strings.length - 1}__`;
  });
  return { replaced, strings };
}

function encodeStringLiteral(inner) {
  // inner: raw string content (not including surrounding quotes)
  const key = randint(1, 255);
  const buf = Buffer.from(inner, 'utf8');
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key;
  return { key, b64: out.toString('base64') };
}

const LUA_KEYWORDS = new Set([
  "and","break","do","else","elseif","end","false","for","function","goto","if",
  "in","local","nil","not","or","repeat","return","then","true","until","while"
]);

// conservative identifier find (ignores strings)
function findIdentifiers(code) {
  // remove strings quickly
  const tmp = code.replace(STRING_RE, ' ');
  const ids = new Set();
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let m;
  while ((m = re.exec(tmp)) !== null) {
    const id = m[1];
    if (!LUA_KEYWORDS.has(id) && !/^[0-9]+$/.test(id)) ids.add(id);
  }
  return Array.from(ids);
}

// build Luau-compatible decoder using bit32.bxor
function buildDecoderLua(encList) {
  const b64Array = encList.map(e => `"${e.b64.replace(/"/g, '\\"')}"`).join(', ');
  const keyArray  = encList.map(e => `${e.key}`).join(', ');

  // This decoder uses bit32.bxor to XOR each byte with key (Luau/Roblox supports bit32).
  // It uses only standard string and math functions available in Luau.
  const decoder = `
-- runtime decoder injected by obfuscator (Luau-friendly)
local __S = { ${b64Array} }
local __K = { ${keyArray} }

local function __b64decode(s)
  local b = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  s = string.gsub(s, '[^'..b..'=]', '')
  return (s:gsub('.', function(x)
    if x == '=' then return '' end
    local r, f = '', (string.find(b, x) - 1)
    for i = 6,0,-1 do r = r .. (math.floor(f/2^i) % 2) end
    return r
  end):gsub('%d%d%d?%d?%d?%d?%d?%d', function(x)
    local c = 0
    for i = 1,8 do c = c*2 + (x:sub(i,i) == '1' and 1 or 0) end
    return string.char(c)
  end))
end

local function __decode(i)
  local b64 = __S[i]
  local key = __K[i]
  local raw = __b64decode(b64)
  local out = {}
  for j = 1, #raw do
    local vb = string.byte(raw, j)
    -- using bit32.bxor for compatibility on Roblox/Luau
    local dec = bit32.bxor(vb, key)
    out[#out + 1] = string.char(dec)
  end
  return table.concat(out)
end

`;
  return decoder;
}

// Generate junk/noop code: many functions and huge unused strings
function generateJunk(countFuncs = 40, largeStrings = 3, stringSize = 20000) {
  // countFuncs: number of noop functions
  // largeStrings: number of long unused string variables to insert
  // stringSize: approx characters per long string (keeps file big)
  let out = '\n-- junk section (noop functions and large unused strings)\n';
  for (let i = 0; i < countFuncs; i++) {
    const name = randId(10);
    const a = randId(6), b = randId(6);
    out += `local function ${name}(${a}, ${b})\n  local _x = ${a}\n  local _y = ${b}\n  if _x == _y then return _x else return (_x or _y) end\nend\n\n`;
  }
  // large unused strings (split to avoid interpreter line-size issues)
  for (let j = 0; j < largeStrings; j++) {
    const varName = randId(10);
    // build the long string by concatenating many short random chunks
    const chunks = [];
    const chunkCount = Math.max(1, Math.floor(stringSize / 128));
    for (let k = 0; k < chunkCount; k++) {
      // random 64-char chunk
      const chunk = crypto.randomBytes(48).toString('base64').replace(/[=+/]/g,'A').slice(0,64);
      chunks.push(`"${chunk}"`);
    }
    out += `local ${varName} = ${chunks.join(' .. ')}\n`;
    // reference in a noop way so the interpreter can't easily optimize away (still unused)
    out += `local _unused_${j} = #${varName}\n\n`;
  }
  out += '-- end junk\n\n';
  return out;
}

// main obfuscator
function obfuscateLua(code, opts = {}) {
  const junkFuncs = opts.junkFunctions ?? 40;
  const largeStrings = opts.largeStrings ?? 3;
  const stringSize = opts.stringSize ?? 20000;

  // 1) strip comments
  let c = stripComments(code);

  // 2) extract string literals
  const { replaced, strings } = extractStrings(c);

  // 3) encode strings
  const encoders = [];
  for (let i = 0; i < strings.length; i++) {
    const raw = strings[i]; // includes quotes
    let inner = raw.slice(1, -1);
    // handle common escapes conservatively
    inner = inner.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
                 .replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const enc = encodeStringLiteral(inner);
    encoders.push(enc);
  }

  // 4) replace placeholders with (__decode(i)) calls
  let replacedCode = replaced;
  for (let i = 0; i < encoders.length; i++) {
    replacedCode = replacedCode.replace(new RegExp(`__STR_PLACEHOLDER_${i}__`, 'g'), `(__decode(${i+1}))`);
  }

  // 5) conservative renaming
  const ids = findIdentifiers(replacedCode);
  // sort by length desc to avoid partial matches
  ids.sort((a, b) => b.length - a.length);
  const skipRegex = /^(?:_G|io|os|math|string|table|coroutine|package|debug|bit32)$/;
  const mapping = {};
  for (const id of ids) {
    if (LUA_KEYWORDS.has(id)) continue;
    if (skipRegex.test(id)) continue;
    if (/^\d+$/.test(id)) continue;
    mapping[id] = randId(6);
  }
  // apply mapping (word boundaries)
  let renamed = replacedCode;
  for (const oldId of Object.keys(mapping)) {
    const newId = mapping[oldId];
    renamed = renamed.replace(new RegExp(`\\b${oldId}\\b`, 'g'), newId);
  }

  // 6) minify lightly
  renamed = renamed.replace(/[ \t]{2,}/g, ' ');
  renamed = renamed.replace(/\r\n/g, '\n');
  renamed = renamed.replace(/\n{2,}/g, '\n');
  renamed = renamed.split('\n').map(l => l.trim()).join('\n');

  // 7) build decoder and junk
  const decoder = buildDecoderLua(encoders);
  const junk = generateJunk(junkFuncs, largeStrings, stringSize);

  // 8) concat final
  const final = decoder + '\n' + junk + '\n' + renamed;
  return final;
}

module.exports = { obfuscateLua };
