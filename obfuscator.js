// obfuscator.js
// Executor-only obfuscator (hidden payload + loadstring).
// Fixed bootstrap: globals for chunks, portable xor_byte, no '~' or '&'.
// Use only in executors that allow loadstring/load (NOT Roblox Studio).

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

const STRING_RE = /(['"])(?:\\.|(?!\1).)*?\1/g;
const LUA_KEYWORDS = new Set([
  "and","break","do","else","elseif","end","false","for","function","goto","if",
  "in","local","nil","not","or","repeat","return","then","true","until","while"
]);

function stripComments(code) {
  return code.replace(/--\[(=*)\[(?:[\s\S]*?)\]\1\]/g, '').replace(/--[^\n\r]*/g, '');
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

function renameIdentifiers(code) {
  const ids = findIdentifiers(code);
  ids.sort((a,b)=>b.length-a.length);
  const skipRegex = /^(?:_G|io|os|math|string|table|coroutine|package|debug|bit32)$/;
  const mapping = {};
  for (const id of ids) {
    if (LUA_KEYWORDS.has(id)) continue;
    if (skipRegex.test(id)) continue;
    if (/^\d+$/.test(id)) continue;
    mapping[id] = randId(6);
  }
  let out = code;
  for (const oldId of Object.keys(mapping)) out = out.replace(new RegExp(`\\b${oldId}\\b`, 'g'), mapping[oldId]);
  return out;
}

function generateJunkApprox(targetBytes) {
  let out = '\n-- JUNK START\n';
  let approx = out.length;
  const append = s => { out += s; approx += s.length; };

  let i = 0;
  while (approx < targetBytes * 0.55 && i < 400) {
    const f = randId(10);
    const a = randId(6), b = randId(6), c = randId(6);
    append(`local function ${f}(${a},${b},${c}) local _x=(${a} or ${b}) local _y=(${b} or ${c}) if _x==_y then return _x end local _t = function() return _y end return _t() end\n`);
    if (i % 4 === 0) {
      const t = randId(8);
      append(`local ${t}={}\nfor i=1,${randint(2,12)} do ${t}[i]="${crypto.randomBytes(6).toString('hex')}" end\n`);
    }
    i++;
  }

  while (approx < targetBytes * 0.85) {
    const name = randId(9);
    const parts = [];
    for (let k=0;k<8;k++) parts.push('"' + crypto.randomBytes(16).toString('base64').replace(/[=+/]/g,'A').slice(0,24) + '"');
    append(`local ${name} = ${parts.join(' .. ')}\nlocal _unused_len_${name} = #${name}\n`);
    approx += 800;
  }

  append('-- JUNK END\n\n');
  return out;
}

function xorAndBase64Encode(str, key) {
  const buf = Buffer.from(str, 'utf8');
  const out = Buffer.alloc(buf.length);
  for (let i=0;i<buf.length;i++) out[i] = buf[i] ^ key;
  return out.toString('base64');
}

// Build bootstrap: define global chunk containers (_G["name"] = "..."), then assemble, decode, xor, run via loadstring
function buildExecutorBootstrap(base64Payload, keyByte, opts) {
  const chunkSize = opts.chunkSize || 800;
  const chunks = [];
  for (let i = 0; i < base64Payload.length; i += chunkSize) chunks.push(base64Payload.slice(i, i + chunkSize));

  // create variable (global) names
  const varNames = chunks.map(()=>randId(10));

  // start building bootstrap
  let out = '-- BOOTSTRAP START\n';

  // assign global chunk variables (use _G["name"] to create global)
  for (let i=0;i<varNames.length;i++) {
    const v = varNames[i];
    const chunk = chunks[i];
    // split chunk into safe literal pieces
    const pieces = [];
    for (let j=0;j<chunk.length;j+=200) pieces.push('"' + chunk.slice(j, j+200).replace(/"/g,'\\"') + '"');
    out += `_G["${v}"] = ${pieces.join(' .. ')}\n`;
  }

  // create order table (list of names in sequence)
  const orderName = randId(8);
  out += `local ${orderName} = { ${varNames.map(n => '"' + n + '"').join(', ')} }\n`;

  // randomize helper names
  const fn_b64 = randId(9);
  const fn_xor = randId(9);
  const fn_run = randId(9);
  const keyName = randId(6);

  // base64 decoder (compact) + portable xor_byte (bit32 or fallback)
  out += `
local ${keyName} = ${keyByte}

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

local function __bxor_fallback(a,b)
  local res = 0
  for i=0,7 do
    local ab = math.floor(a / (2^i)) % 2
    local bb = math.floor(b / (2^i)) % 2
    if ab ~= bb then res = res + 2^i end
  end
  return res
end

local function ${fn_xor}(s, k)
  local have_bit32 = (type(bit32) == 'table' and type(bit32.bxor) == 'function')
  local out = {}
  for i=1,#s do
    local b = string.byte(s, i)
    local x
    if have_bit32 then
      x = bit32.bxor(b, k)
    else
      x = __bxor_fallback(b, k)
    end
    out[#out+1] = string.char(x)
  end
  return table.concat(out)
end

-- assemble payload from global chunk variables in order
local _payload_parts = {}
for i=1,#${orderName} do
  local vname = ${orderName}[i]
  local val = _G[vname]
  if val == nil then val = "" end
  _payload_parts[#_payload_parts + 1] = val
end
local _b64 = table.concat(_payload_parts)
local _decoded = ${fn_b64}(_b64)
local _plain = ${fn_xor}(_decoded, ${keyName})

local _loader = loadstring or load
if _loader then
  local f = _loader(_plain)
  if type(f) == 'function' then
    pcall(f)
  end
end

-- BOOTSTRAP END
`;

  return out;
}

function obfuscateLua(inputCode, options = {}) {
  const target = options.targetSizeBytes || DEFAULT_TARGET_SIZE;
  const chunkSize = options.chunkSize || 800;

  // 1) prepare user code
  let code = stripComments(inputCode);
  code = 'do\n' + code + '\nend\n';

  // 2) small payload header (embedded inside hidden payload) to provide internal utilities (kept minimal)
  const payloadHeader = `
-- hidden payload header
local function __internal_b64(s)
  local b='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  s = string.gsub(s, '[^'..b..'=]','')
  s = s:gsub('.', function(x)
    if x == '=' then return '' end
    local r,f='', (string.find(b,x)-1)
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

local function __internal_xor(s,k)
  local t = {}
  for i=1,#s do
    local b = string.byte(s,i)
    -- prefer bit32 if available
    if type(bit32) == 'table' and type(bit32.bxor) == 'function' then
      t[#t+1] = string.char(bit32.bxor(b, k))
    else
      -- fallback
      local res = 0
      for ii = 0,7 do
        local ab = math.floor(b / (2^ii)) % 2
        local bb = math.floor(k / (2^ii)) % 2
        if ab ~= bb then res = res + 2^ii end
      end
      t[#t+1] = string.char(res)
    end
  end
  return table.concat(t)
end
`;

  // 3) full hidden payload = header + user code
  const fullHidden = payloadHeader + '\n' + code;

  // 4) XOR+base64 encode hidden payload
  const key = randint(1,255);
  const b64Payload = xorAndBase64Encode(fullHidden, key);

  // 5) outer junk (visible) to bloat file
  let outerJunk = generateJunkApprox(target * 0.6);
  if (outerJunk.length > target) outerJunk = outerJunk.slice(0, Math.floor(target * 0.6));

  // 6) bootstrap that reconstructs hidden payload and runs via loadstring
  const bootstrap = buildExecutorBootstrap(b64Payload, key, { chunkSize });

  // 7) assemble final and pad to target
  let final = '-- OBFUSCATED (executor-only)\n' + outerJunk + '\n' + bootstrap;
  let iter = 0;
  while (Buffer.byteLength(final, 'utf8') < target && iter < 6) {
    final += '\n' + generateJunkApprox(Math.max(4*1024, target - Buffer.byteLength(final, 'utf8')));
    iter++;
  }
  // safety trim (keep bootstrap present)
  if (Buffer.byteLength(final, 'utf8') > target * 3) {
    const splitPoint = final.indexOf('-- BOOTSTRAP START');
    if (splitPoint > 0) final = final.slice(0, splitPoint) + final.slice(splitPoint);
  }

  return final;
}

module.exports = { obfuscateLua };
