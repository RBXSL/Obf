// obfuscator.js
// Heavy obfuscator for Luau (Roblox friendly). Produces ~TARGET_SIZE_BYTES output
// with complicated-looking (but inert) functions, closures, wrappers, and large unused strings.
// - XOR+base64 string encoding with bit32 fallback
// - Conservative renaming
// - Wraps user code in do...end
// - Configurable target size (default 100KB)

const crypto = require('crypto');

const DEFAULT_TARGET_SIZE = 100 * 1024; // 100 KB

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

// Basic utilities
function stripComments(code) {
  code = code.replace(/--\[(=*)\[(?:[\s\S]*?)\]\1\]/g, '');
  code = code.replace(/--[^\n\r]*/g, '');
  return code;
}

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

// Decoder (bit32 with fallback)
function buildDecoderLua(encList) {
  const b64Array = encList.map(e => `"${e.b64.replace(/"/g, '\\"')}"`).join(', ');
  const keyArray  = encList.map(e => `${e.key}`).join(', ');

  const decoder = `
-- runtime decoder (Luau-friendly) injected by obfuscator
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

local function __bxor_fallback(a, b)
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

// Create "complex" junk: nested closures, upvalue usage, table indirection, wrapper chain,
// opaque predicates, and large concatenated strings. Keep them unused but referenced enough to avoid trivial pruning.
function generateComplexJunk(targetBytes, opts = {}) {
  // Build junk until approximate size >= targetBytes
  let out = '\n-- BEGIN COMPLEX JUNK SECTION\n';
  let approx = out.length;

  // helper to append and update approx
  function append(s) { out += s; approx += s.length; }

  // Add layered wrapper functions and closures
  const wrapperCount = opts.wrapperCount ?? 12;
  for (let i = 0; i < wrapperCount && approx < targetBytes * 0.4; i++) {
    const wname = randId(10);
    const inner = randId(8);
    const param = randId(6);
    const up = randId(6);
    append(`local function ${wname}(${param})\n  local ${up} = ${param}\n  local function ${inner}()\n    -- pretend to capture upvalue\n    local _a = ${up}\n    if _a == nil then return _a end\n    return _a\n  end\n  return ${inner}\nend\n\n`);
  }

  // Add opaque predicates & conditional chains
  const opaqueCount = opts.opaqueCount ?? 20;
  for (let i = 0; i < opaqueCount && approx < targetBytes * 0.55; i++) {
    const a = randint(100000, 999999);
    const b = a + 1;
    const name = randId(8);
    append(`local function ${name}()\n  local _x = ${a}\n  local _y = ${b}\n  if (_x + 1) == (_y) then\n    return true\n  else\n    return false\n  end\nend\n\n`);
  }

  // Add table indirection and metamethod-like structures (harmless)
  const tableCount = opts.tableCount ?? 6;
  for (let t = 0; t < tableCount && approx < targetBytes * 0.75; t++) {
    const tname = randId(9);
    const tn2 = randId(7);
    append(`local ${tname} = {}\nfor i=1,${randint(3,14)} do ${tname}[i] = "${crypto.randomBytes(8).toString('hex')}" end\nlocal ${tn2} = function() return ${tname} end\nlocal _ref_${t} = ${tn2}()\n\n`);
  }

  // Add many nested no-op functions with slightly randomized bodies to defeat dedup
  const noopCount = opts.noopCount ?? 40;
  for (let n = 0; n < noopCount && approx < targetBytes * 0.85; n++) {
    const fname = randId(10);
    const p1 = randId(6), p2 = randId(6), p3 = randId(6);
    append(`local function ${fname}(${p1}, ${p2}, ${p3})\n  local _v = (${p1} or ${p2})\n  for i=1,${randint(1,5)} do _v = _v end\n  return function() return _v end\nend\n\n`);
  }

  // Add large concatenated strings to pad to target
  // We'll append many medium-sized chunks so final size is adjustable
  function addLargeStrings(neededBytes) {
    let added = 0;
    let idx = 0;
    while (approx + added < neededBytes) {
      const varName = randId(9) + idx;
      const chunkCount = 32; // 32 * ~48 -> ~1536 bytes per var
      const chunks = [];
      for (let k = 0; k < chunkCount; k++) {
        // base64 chunk sanitized
        const chunk = crypto.randomBytes(36).toString('base64').replace(/[=+/]/g, 'A').slice(0,48);
        chunks.push(`"${chunk}"`);
      }
      const s = `local ${varName} = ${chunks.join(' .. ')}\nlocal _unused_len_${idx} = #${varName}\n\n`;
      append(s);
      added += s.length;
      idx += 1;
      // safety break to avoid infinite loop
      if (idx > 400) break;
    }
    return;
  }

  // final padding to target
  addLargeStrings(targetBytes * 1.05); // overshoot slightly to ensure size

  append('-- END COMPLEX JUNK SECTION\n\n');
  return out;
}

// safe separator to avoid ambiguous tokens
function safeSeparator() { return '\n-- ;; separator\n'; }

// Main obfuscate function
function obfuscateLua(inputCode, options = {}) {
  const TARGET_SIZE_BYTES = options.targetSizeBytes ?? DEFAULT_TARGET_SIZE;

  // 1) strip comments
  let code = stripComments(inputCode);

  // 2) extract and encode strings
  const { replaced, strings } = extractStrings(code);
  const encoders = [];
  for (let i = 0; i < strings.length; i++) {
    const raw = strings[i];
    let inner = raw.slice(1, -1);
    inner = inner.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
                 .replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    encoders.push(encodeStringLiteral(inner));
  }

  // 3) replace placeholders with decoder calls (safe parentheses)
  let replacedCode = replaced;
  for (let i = 0; i < encoders.length; i++) {
    replacedCode = replacedCode.replace(new RegExp(`__STR_PLACEHOLDER_${i}__`, 'g'), `(__decode(${i+1}))`);
  }

  // 4) conservative identifier rename
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

  // 5) light minify
  renamed = renamed.replace(/[ \t]{2,}/g, ' ');
  renamed = renamed.replace(/\r\n/g, '\n');
  renamed = renamed.replace(/\n{2,}/g, '\n');
  renamed = renamed.split('\n').map(l => l.trim()).join('\n');

  // 6) build decoder and complex junk until approximate target size reached
  const decoder = buildDecoderLua(encoders);
  let junk = generateComplexJunk(TARGET_SIZE_BYTES, {
    wrapperCount: options.wrapperCount ?? 18,
    opaqueCount: options.opaqueCount ?? 40,
    tableCount: options.tableCount ?? 8,
    noopCount: options.noopCount ?? 70
  });

  // If junk isn't big enough, add more padding strings
  // simple loop: while total < target add more large strings (this may overshoot a bit)
  let assembled = decoder + safeSeparator() + junk + safeSeparator() + '-- user block wrapper\n' + 'do\n' + renamed + '\nend\n';
  // enlarge until approx size reached
  const MAX_ITER = 8;
  let iter = 0;
  while (Buffer.byteLength(assembled, 'utf8') < TARGET_SIZE_BYTES && iter < MAX_ITER) {
    // add more large string padding
    const pad = generateComplexJunk(Math.max(32 * 1024, TARGET_SIZE_BYTES - Buffer.byteLength(assembled, 'utf8')), {
      wrapperCount: 2,
      opaqueCount: 4,
      tableCount: 1,
      noopCount: 6
    });
    junk += pad;
    assembled = decoder + safeSeparator() + junk + safeSeparator() + '-- user block wrapper\n' + 'do\n' + renamed + '\nend\n';
    iter += 1;
  }

  return assembled;
}

module.exports = { obfuscateLua };
