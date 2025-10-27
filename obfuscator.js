// obfuscator.js
// Roblox Studio-friendly obfuscator
// - No HttpService:Base64Decode
// - Internal base64 decoder + xor fallback
// - No loadstring (runs in Studio and most executors)
// - Decoder present in file (obfuscated names + split pieces) but harder to read
// - Targets ~100KB output (configurable)

// NOTE: Full "perfect hiding" (decoder invisible) is impossible for Studio because Studio
// disallows loadstring/load. If you run only in executors that provide loadstring, let me
// know and I can produce a loadstring-hidden variant.

const crypto = require('crypto');

const TARGET_SIZE_BYTES_DEFAULT = 100 * 1024; // 100 KB

function randId(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return '_' + s;
}
function randint(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const LUA_KEYWORDS = new Set([
  "and","break","do","else","elseif","end","false","for","function","goto","if",
  "in","local","nil","not","or","repeat","return","then","true","until","while"
]);

// ---- helpers ----
const STRING_RE = /(['"])(?:\\.|(?!\1).)*?\1/g;

function stripComments(code) {
  code = code.replace(/--\[(=*)\[(?:[\s\S]*?)\]\1\]/g, '');
  code = code.replace(/--[^\n\r]*/g, '');
  return code;
}

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

function replacePlaceholders(code, encoders) {
  let replaced = code;
  for (let i = 0; i < encoders.length; i++) {
    replaced = replaced.replace(new RegExp(`__STR_PLACEHOLDER_${i}__`, 'g'), `(__decS(${i+1}))`);
  }
  return replaced;
}

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

// generate structural junk (complex-looking but inert)
function generateJunkApprox(targetBytes) {
  let out = '\n-- junk start\n';
  let approx = out.length;
  const append = (s) => { out += s; approx += s.length; };

  let i = 0;
  while (approx < targetBytes * 0.65 && i < 300) {
    const f = randId(10);
    const a = randId(6), b = randId(6), c = randId(6);
    append(`local function ${f}(${a},${b},${c}) local _x = ${a} or ${b} local _y = ${b} or ${c} if (_x == _y) then return _x end local _r = function() return _y end return _r() end\n`);
    if (i % 3 === 0) {
      const t = randId(8);
      append(`local ${t}={}\nfor i=1,${randint(2,12)} do ${t}[i]="${crypto.randomBytes(6).toString('hex')}" end\n`);
    }
    i++;
  }

  // padding with concatenated random chunks if needed
  while (approx < targetBytes * 0.9) {
    const name = randId(8);
    const parts = [];
    for (let k = 0; k < 12; k++) {
      parts.push('"' + crypto.randomBytes(18).toString('base64').replace(/[=+/]/g, 'A').slice(0,24) + '"');
    }
    append(`local ${name} = ${parts.join(' .. ')}\nlocal _unused_${name} = #${name}\n`);
    approx += 1000;
  }

  append('-- junk end\n\n');
  return out;
}

// Build an inline (but obfuscated) decoder section that does NOT use HttpService.
// Names are intentionally mangled to make manual reading harder.
function buildInlineDecoder(encoders) {
  // encoders: [{key, b64}, ...]
  // We'll build arrays __S and __K and small base64 decoder + xor fallback.
  const sArray = encoders.map(e => `"${e.b64.replace(/"/g, '\\"')}"`).join(', ');
  const kArray = encoders.map(e => `${e.key}`).join(', ');

  // Obfuscate function and variable names by randomizing them:
  const name_s = randId(8);
  const name_k = randId(8);
  const fn_b64 = randId(8);
  const fn_xor = randId(8);
  const fn_bxor_fb = randId(8);
  const fn_dec = randId(8);

  // Inline base64 decoder (compact)
  const decoder = `
local ${name_s} = { ${sArray} }
local ${name_k} = { ${kArray} }

local function ${fn_b64}(s)
  local b='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  s = string.gsub(s, '[^'..b..'=]','')
  s = s:gsub('.', function(x)
    if x == '=' then return '' end
    local r,f='', (string.find(b, x)-1)
    for i=6,0,-1 do r = r .. (math.floor(f/2^i) % 2) end
    return r
  end)
  local out = {}
  for chunk in s:gmatch('%d%d%d?%d?%d?%d?%d?%d') do
    local c = 0
    for i=1,8 do c = c*2 + (chunk:sub(i,i) == '1' and 1 or 0) end
    out[#out+1] = string.char(c)
  end
  return table.concat(out)
end

local function ${fn_bxor_fb}(a,b)
  local r = 0
  for i = 0,7 do
    local ab = math.floor(a / (2^i)) % 2
    local bb = math.floor(b / (2^i)) % 2
    local rb = (ab + bb) % 2
    r = r + rb * (2^i)
  end
  return r
end

local __have_bit32 = (type(bit32) == 'table' and type(bit32.bxor) == 'function')
local function ${fn_xor}(a,b)
  if __have_bit32 then return bit32.bxor(a,b) else return ${fn_bxor_fb}(a,b) end
end

local function ${fn_dec}(i)
  local b64 = ${name_s}[i]
  local key = ${name_k}[i]
  local raw = ${fn_b64}(b64)
  local out = {}
  for j = 1, #raw do
    local v = string.byte(raw, j)
    out[#out + 1] = string.char(${fn_xor}(v, key))
  end
  return table.concat(out)
end

-- expose as short name to be used by replaced code:
local __decS = ${fn_dec}
`;

  return decoder;
}

// Assemble final output with size control
function obfuscateLua(input, options = {}) {
  const target = options.targetSizeBytes || TARGET_SIZE_BYTES_DEFAULT;

  // 1) strip comments
  let code = stripComments(input);

  // 2) extract strings
  const { replaced, strings } = extractStrings(code);

  // 3) encode strings
  const encoders = [];
  for (let i = 0; i < strings.length; i++) {
    let inner = strings[i].slice(1, -1);
    inner = inner.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
                 .replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    encoders.push(encodeStringLiteral(inner));
  }

  // 4) replace placeholders with __decS calls
  let replacedCode = replacePlaceholders(replaced, encoders);

  // 5) conservative identifier renaming
  const ids = findIdentifiers(replacedCode);
  ids.sort((a,b) => b.length - a.length);
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

  // 6) light minify
  renamed = renamed.replace(/[ \t]{2,}/g, ' ');
  renamed = renamed.replace(/\r\n/g, '\n');
  renamed = renamed.replace(/\n{2,}/g, '\n');
  renamed = renamed.split('\n').map(l => l.trim()).join('\n');

  // 7) build parts: decoder (inline, obfuscated names), junk, user code (wrapped)
  const decoderInline = buildInlineDecoder(encoders);
  const junk = generateJunkApprox(target);
  const userBlock = 'do\n' + renamed + '\nend\n';

  // Assemble and trim/pad to target by adjusting junk amount
  let assembled = decoderInline + '\n' + junk + '\n' + userBlock;

  // If too small, pad with extra junk strings; if too large, trim junk tail
  const MAX_ITERS = 6;
  let it = 0;
  while (Buffer.byteLength(assembled, 'utf8') < target && it < MAX_ITERS) {
    const add = generateJunkApprox(Math.max(8 * 1024, target - Buffer.byteLength(assembled, 'utf8')));
    assembled = decoderInline + '\n' + add + '\n' + junk + '\n' + userBlock;
    it++;
  }

  // Final safety: if overshot massively, trim the junk area (try to keep decoder+user intact)
  if (Buffer.byteLength(assembled, 'utf8') > target * 3) {
    // reduce junk by half
    const smallerJunk = generateJunkApprox(Math.floor(target * 0.5));
    assembled = decoderInline + '\n' + smallerJunk + '\n' + userBlock;
  }

  return assembled;
}

module.exports = { obfuscateLua };
