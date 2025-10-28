// obfuscator.js (fixed: safe one-sided obfuscation, ensures separators)
// Usage:
// const { obfuscateLua } = require('./obfuscator');
// const out = obfuscateLua('print("hello")', { targetSizeBytes: 120*1024 });
// fs.writeFileSync('out_one_sided.lua', out, 'utf8');

const crypto = require('crypto');

const DEFAULT_TARGET = 100 * 1024;

function randint(a,b){ return Math.floor(Math.random()*(b-a+1))+a; }
function randName(len=10){
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let s = "";
  for (let i=0;i<len;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}
function randId(){ return randName(6) + '_' + randName(6); }
function randHex(len=8){ return crypto.randomBytes(len).toString('hex'); }
function toByteArray(s){ const a = []; for (let i=0;i<s.length;i++) a.push(s.charCodeAt(i)); return a; }
function xorArray(arr, key){ return arr.map(x => x ^ key); }

// --- Helpers to safely append fragments (always end with semicolon)
function ensureTerminator(fragment){
  if (!fragment) return ';';
  fragment = String(fragment);
  // Trim trailing whitespace
  fragment = fragment.replace(/\s+$/g, '');
  // If already ends with ; or newline or end-token like 'end' followed by ';', accept; else append ';'
  if (/[;{}]$/.test(fragment)) return fragment;
  // If ends with 'end' we still add semicolon (safe)
  return fragment + ';';
}

// --- Fake junk generator (nested dummy functions, assignments, loops) 
function generateJunkSegment(){
  let seg = '';
  const pieces = randint(4,10);
  for (let i=0;i<pieces;i++){
    const name = randName(randint(4,8));
    const val = randHex(randint(3,6));
    seg += `${name}="${val}";`;
  }
  // add a few small dummy functions and loops
  for (let j=0;j<randint(1,3);j++){
    const fn = randId();
    const vn = randName(6);
    const vv = randHex(6);
    seg += `function ${fn}() local ${vn}="${vv}"; for i=1,${randint(2,4)} do if false then ${vn}=${vn}..${vn} end end end;`;
  }
  return seg;
}

// --- Build one-sided Lua safely from fragments
function buildOneSidedLuaSafe(fragments, targetSize){
  // Ensure each fragment ends with semicolon:
  const safe = fragments.map(ensureTerminator);

  // Join them into one string
  let lua = safe.join('');

  // Normalize CRLF to LF, then collapse all newlines into semicolons as defensive fallback
  lua = lua.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+/g, ';');

  // Collapse repeated semicolons to a single semicolon
  lua = lua.replace(/;{2,}/g, ';');

  // Now pad with junk segments until we hit target size
  while (Buffer.byteLength(lua, 'utf8') < targetSize){
    lua += generateJunkSegment();
    lua = lua.replace(/;{2,}/g, ';'); // keep it tidy
  }

  // Trim exactly to target size (no newline left)
  if (Buffer.byteLength(lua, 'utf8') > targetSize) lua = lua.slice(0, targetSize);

  // Remove newlines if any remain and collapse semicolons
  lua = lua.replace(/\n/g, ';').replace(/;{2,}/g, ';');

  return lua;
}

// --- Core one-sided obfuscator building the loader safely
function buildOneSidedObfFromBytes(xoredBytes, key, targetSize){
  // variable name randomization
  const dataVar = randId();
  const keyVar = randId();
  const bxorFn = randId();
  const decodeFn = randId();
  const execFn = randId();
  const tmpVar = randId();

  // pieces array (we'll push fragments and then safely join)
  const parts = [];

  // data array (ensure semicolon after it)
  parts.push(`${dataVar}={${xoredBytes.join(',')}}`); // ensureTerminator will add semicolon

  // key
  parts.push(`${keyVar}=${key}`);

  // bxor fallback function
  parts.push(`local function ${bxorFn}(a,b) local r=0 for i=0,7 do local ab=math.floor(a/2^i)%2 local bb=math.floor(b/2^i)%2 if ab~=bb then r=r+2^i end end return r end`);

  // decode function (reconstruct string)
  parts.push(`local function ${decodeFn}() local _t={} for i=1,#${dataVar} do _t[i]=string.char(${bxorFn}(${dataVar}[i],${keyVar})) end local s=table.concat(_t) return s end`);

  // exec function (try load, then loadstring; if neither available, attempt to pcall nothing; swallow compile errors)
  parts.push(`local function ${execFn}(s) local f=nil if type(load)=='function' then f=load(s) end if not f and type(loadstring)=='function' then f=loadstring(s) end if not f then return end local ok,err = pcall(f) if not ok then return end end`);

  // small fake blocks to intimidate (non-functional)
  for (let i=0;i<4;i++){
    const fn = randId();
    const name = randName(6);
    parts.push(`function ${fn}() local ${name}="${randHex(6)}" for i=1,${randint(1,3)} do if false then ${name}=${name}..${name} end end end`);
  }

  // decode + exec invocation
  parts.push(`local ${tmpVar}=${decodeFn}()`);
  parts.push(`${execFn}(${tmpVar})`);

  // convert parts to one-sided lua string safely
  return buildOneSidedLuaSafe(parts, targetSize);
}

// --- Main export: obfuscateLua
function obfuscateLua(source, opts = {}){
  const target = opts.targetSizeBytes || DEFAULT_TARGET;
  const key = randint(1,255);
  const bytes = toByteArray(source);
  const xored = xorArray(bytes, key);
  const lua = buildOneSidedObfFromBytes(xored, key, target);
  return lua;
}

module.exports = { obfuscateLua };
