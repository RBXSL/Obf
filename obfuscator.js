// obfuscator.js
// Roblox-friendly obfuscator: ~100KB output, hidden decoder, complex junk

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

const LUA_KEYWORDS = new Set([
  "and","break","do","else","elseif","end","false","for","function","goto","if",
  "in","local","nil","not","or","repeat","return","then","true","until","while"
]);

// strip comments
function stripComments(code) {
  code = code.replace(/--\[(=*)\[(?:[\s\S]*?)\]\1\]/g, '');
  code = code.replace(/--[^\n\r]*/g, '');
  return code;
}

// extract string literals
const STRING_RE = /(['"])(?:\\.|(?!\1).)*?\1/g;
function extractStrings(code) {
  const strings = [];
  const replaced = code.replace(STRING_RE, (m) => {
    strings.push(m);
    return `__STR_PLACEHOLDER_${strings.length - 1}__`;
  });
  return { replaced, strings };
}

// XOR + base64 encoding
function encodeStringLiteral(inner) {
  const key = randint(1, 255);
  const buf = Buffer.from(inner, 'utf8');
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key;
  return { key, b64: out.toString('base64') };
}

// replace string placeholders with decoder calls
function replacePlaceholders(code, encoders) {
  let replacedCode = code;
  for (let i = 0; i < encoders.length; i++) {
    replacedCode = replacedCode.replace(new RegExp(`__STR_PLACEHOLDER_${i}__`, 'g'), `(__decode(${i+1}))`);
  }
  return replacedCode;
}

// conservative renaming
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

// generate complex junk (nested closures, opaque predicates, tables)
function generateJunk(targetBytes) {
  let out = '\n-- junk section\n';
  let approx = out.length;
  function append(s){ out += s; approx += s.length; }

  let idx = 0;
  while (approx < targetBytes * 0.7) {
    const fname = randId(10);
    const p1 = randId(6), p2 = randId(6), p3 = randId(6);
    append(`local function ${fname}(${p1},${p2},${p3}) local _x=(${p1} or ${p2}) local _y=(${p2} or ${p3}) if _x==_y then return _x end return (_y or _x) end\n`);
    const tname = randId(8);
    append(`local ${tname}={}; for i=1,${randint(2,10)} do ${tname}[i]="${crypto.randomBytes(6).toString('hex')}" end\n`);
    idx++;
    if (idx > 200) break; // safety
  }
  return out;
}

// wrap user code + decoder in a runtime-evaluated string
function wrapWithHiddenDecoder(userCode, encoders) {
  // 1. build the decoder + user code Lua snippet
  let decoderLua = `
local __S={${encoders.map(e=>`"${e.b64}"`).join(',')}} 
local __K={${encoders.map(e=>e.key).join(',')}} 
local function __b64decode(s)local b='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/' s=string.gsub(s,'[^'..b..'=]','') return (s:gsub('.',function(x) if x=='=' then return'' end local r,f='',(string.find(b,x)-1) for i=6,0,-1 do r=r..(math.floor(f/2^i)%2) end return r end):gsub('%d%d%d?%d?%d?%d?%d?%d',function(x)local c=0 for i=1,8 do c=c*2+(x:sub(i,i)=='1' and 1 or 0) end return string.char(c) end)) end
local function __bxor_fallback(a,b)local r=0 for i=0,7 do local ab=math.floor(a/2^i)%2 local bb=math.floor(b/2^i)%2 local rb=(ab+bb)%2 r=r+rb*2^i end return r end
local __have_bit32=(type(bit32)=='table' and type(bit32.bxor)=='function')
local function __xor_byte(a,b) if __have_bit32 then return bit32.bxor(a,b) else return __bxor_fallback(a,b) end end
local function __decode(i)local b64=__S[i] local key=__K[i] local raw=__b64decode(b64) local out={} for j=1,#raw do out[#out+1]=string.char(__xor_byte(string.byte(raw,j),key)) end return table.concat(out) end
` + userCode;

  // 2. encode it as base64 + XOR
  const key = randint(1,255);
  const buf = Buffer.from(decoderLua, 'utf8');
  const encBuf = Buffer.alloc(buf.length);
  for (let i=0;i<buf.length;i++) encBuf[i] = buf[i] ^ key;
  const b64 = encBuf.toString('base64');

  // 3. build runtime evaluator
  const hidden = `local payload="${b64}" local key=${key} local raw=game.HttpService:Base64Decode(payload) local out={} for i=1,#raw do out[i]=string.char(bit32.bxor(string.byte(raw,i),key)) end local code=table.concat(out) loadstring(code)()`;

  return hidden;
}

// Main obfuscate function
function obfuscateLua(inputCode, options={}) {
  const TARGET_SIZE_BYTES = options.targetSizeBytes || 100*1024;

  // strip comments
  let code = stripComments(inputCode);

  // extract strings
  const { replaced, strings } = extractStrings(code);
  const encoders = strings.map(s=>{
    let inner = s.slice(1,-1);
    inner = inner.replace(/\\n/g,'\n').replace(/\\r/g,'\r').replace(/\\t/g,'\t').replace(/\\'/g,"'").replace(/\\"/g,'"').replace(/\\\\/g,'\\');
    return encodeStringLiteral(inner);
  });

  // replace placeholders
  let replacedCode = replacePlaceholders(replaced, encoders);

  // rename identifiers
  const ids = findIdentifiers(replacedCode);
  const mapping={};
  ids.forEach(id=>{
    if(!LUA_KEYWORDS.has(id)) mapping[id]=randId(6);
  });
  let renamed = replacedCode;
  for(const oldId of Object.keys(mapping)){
    renamed = renamed.replace(new RegExp(`\\b${oldId}\\b`,'g'),mapping[oldId]);
  }

  renamed = renamed.split('\n').map(l=>l.trim()).join('\n');

  // generate junk
  const junk = generateJunk(TARGET_SIZE_BYTES);

  // wrap user code in do-end
  const userBlock = `do\n${renamed}\nend\n`;

  // wrap with hidden decoder
  const final = wrapWithHiddenDecoder(junk + '\n' + userBlock, encoders);

  return final;
}

module.exports={obfuscateLua};
