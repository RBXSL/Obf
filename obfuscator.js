// obfuscator.js
// Robust Luau-friendly obfuscator with heavy junk/noise and parser-safe output.
// - Encodes strings with single-byte XOR then base64
// - Decoder prefers bit32.bxor but falls back to pure-Lua XOR implementation if needed
// - Conservative identifier renaming
// - Junk injection: many noop functions and huge unused strings (configurable)
// - Wraps user code in `do ... end` to prevent ambiguous leading tokens

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

// build Luau-compatible decoder using bit32.bxor with a fallback
function buildDecoderLua(encList) {
  const b64Array = encList.map(e => `"${e.b64.replace(/"/g, '\\"')}"`).join(', ');
  const keyArray  = encList.map(e => `${e.key}`).join(', ');

  // Provide fallback XOR if bit32 not available
  const decoder = `
-- runtime decoder injected by obfuscator (Luau-friendly)
local __S = { ${b64Array} }
local __K = { ${keyArray} }

-- base64 decoder (minimal)
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

-- fallback xor for environments lacking bit32
local function __bxor_fallback(a, b)
  -- a and b are 0..255
  local res = 0
  for i = 0,7 do
    local abit = math.floor(a / (2^i)) % 2
    local bbit = math.floor(b / (2^i)) % 2
    local rbit = (abit + bbit) % 2
    res = res + rbit * (2^i)
  end
  return res
end

local __have_bit32 = (type(bit32) == "table" and type(bit32.bxor) == "function")

local function __xor_byte(a, b)
  if __have_bit32 then
    return bit32.bxor(a, b)
  else
    return __bxor_fallback(a, b)
  end
end

local function __decode(i)
  local b64 = __S[i]
  local key = __K[i]
  local raw = __b64decode(b64)
  local out = {}
  for j = 1, #raw do
    local vb = string.byte(raw, j)
    local dec = __xor_byte(vb, key)
    out[#out + 1] = string.char(dec)
  end
  return table.concat(out)
end

`;
  return decoder;
}

// Generate junk/noop code: many functions and huge unused strings
function generateJunk(countFuncs = 40, largeStrings = 3, stringSize = 20000) {
  let out = '\n-- junk section (noop functions and large unused strings)\n';
  for (let i = 0; i < countFuncs; i++) {
    const name = randId(10);
    const a = randId(6), b = randId(6), c = randId(6);
    // produce slightly different noop bodies to avoid trivial dedupe
    out += `local function ${name}(${a}, ${b}, ${c})\n  local _x = ${a} or ${b}\n  local _y = ${b} or ${c}\n  if _x == _y then return _x end\n  return (_y or _x)\nend\n\n`;
  }
  for (let j = 0; j < largeStrings; j++) {
    const varName = randId(10);
    const chunks = [];
    // create many small base64-derived chunks and concat them so it looks random but is safe
    const chunkCount = Math.max(1, Math.floor(stringSize / 64));
    for (let k = 0; k < chunkCount; k++) {
      const chunk = crypto.randomBytes(48).toString('base64').replace(/[=+/]/g,'A').slice(0,64);
      chunks.push(`"${chunk}"`);
    }
    out += `local ${varName} = ${chunks.join(' .. ')}\n`;
    out += `local _unused_${j} = #${varName}\n\n`;
  }
  out += '-- end junk\n\n';
  return out;
}

// ensure safe separator between sections to avoid ambiguous tokens
function safeSeparator() {
  // a Lua semicolon is a statement separator — include it inside a comment so it is harmless
  return '\n-- ;; separator\n';
}

// main obfuscator
function obfuscateLua(code, opts = {}) {
  const junkFuncs = opts.junkFunctions ?? 80;
  const largeStrings = opts.largeStrings ?? 6;
  const stringSize = opts.stringSize ?? 60000;

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
    // put explicit parentheses to keep expression nature, but we'll wrap whole code in do..end later
    replacedCode = replacedCode.replace(new RegExp(`__STR_PLACEHOLDER_${i}__`, 'g'), `(__decode(${i+1}))`);
  }

  // 5) conservative renaming
  const ids = findIdentifiers(replacedCode);
  ids.sort((a, b) => b.length - a.length);
  const skipRegex = /^(?:_G|io|os|math|string|table|coroutine|package|debug|bit32)$/;
  const mapping = {};
  for (const id of ids) {
    if (LUA_KEYWORDS.has(id)) continue;
    if (skipRegex.test(id)) continue;
    if (/^\d+$/.test(id)) continue;
    mapping[id] = randId(6);
  }
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

  // 7) build decoder and junk and wrap in a do-end block to avoid ambiguous leading tokens
  const decoder = buildDecoderLua(encoders);
  const junk = generateJunk(junkFuncs, largeStrings, stringSize);

  // use safe separators and wrap user code in a block
  const final = decoder + safeSeparator() + junk + safeSeparator() + '\n-- user code block (wrapped)\n' +
                'do\n' + renamed + '\nend\n';

  return final;
}

module.exports = { obfuscateLua };
