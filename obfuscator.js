// obfuscator.js
// One-sided, loadstring-friendly obfuscator WITHOUT XOR.
// Encoding = add(keyA) -> rotate-left(keyB) -> permute(by seed keyC).
// Decoder in Lua is split among many small, randomized helpers to hide the exact method.
//
// Usage:
// const { obfuscateLua } = require('./obfuscator');
// const out = obfuscateLua('print("hello")', { targetSizeBytes: 120*1024, debug: true });
// fs.writeFileSync('out_obf.lua', out, 'utf8');

const crypto = require('crypto');

const DEFAULT_TARGET = 100 * 1024;

function randint(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
function randChars(len = 8) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function randId() { return randChars(5) + "_" + randChars(5); }
function randHex(len = 8) { return crypto.randomBytes(len).toString('hex'); }
function toByteArray(s) { const arr = []; for (let i = 0; i < s.length; i++) arr.push(s.charCodeAt(i)); return arr; }

// --- encode steps (JS side) ---
// step 1: add keyA (0..255)
// step 2: rotate-left by keyB (1..7) on 8-bit value
// step 3: permute array indices with a PRNG seeded by keyC
function rotl8(v, n) {
  return ((v << n) | (v >>> (8 - n))) & 0xFF;
}
function rotr8(v, n) {
  return ((v >>> n) | (v << (8 - n))) & 0xFF;
}

// simple deterministic PRNG using seed (32-bit)
function xorshift32(seed) {
  let x = seed >>> 0;
  return function() {
    x ^= x << 13; x = x >>> 0;
    x ^= x >>> 17; x = x >>> 0;
    x ^= x << 5; x = x >>> 0;
    return x >>> 0;
  };
}

function permuteArray(arr, seed) {
  const prng = xorshift32(seed);
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const r = prng() % (i + 1);
    const tmp = out[i];
    out[i] = out[r];
    out[r] = tmp;
  }
  return out;
}

// inverse permutation: given permuted array and same seed, compute original order
function inversePermutationIndices(length, seed) {
  // recreate the swaps and invert
  const prng = xorshift32(seed);
  const idxs = new Array(length);
  for (let i = 0; i < length; i++) idxs[i] = i;
  // forward swaps
  const swaps = [];
  for (let i = length - 1; i > 0; i--) {
    const r = prng() % (i + 1);
    swaps.push([i, r]);
    const tmp = idxs[i];
    idxs[i] = idxs[r];
    idxs[r] = tmp;
  }
  // apply swaps to base indices to find mapping
  const perm = idxs.slice();
  // now compute inverse: inv[perm[i]] = i
  const inv = new Array(length);
  for (let i = 0; i < length; i++) inv[perm[i]] = i;
  return inv;
}

// encode source -> array of numbers
function encodeSourceToArray(source, keyA, keyB, keyC) {
  const bytes = toByteArray(source);
  const step1 = bytes.map(b => (b + keyA) & 0xFF);
  const step2 = step1.map(b => rotl8(b, keyB));
  // permute
  const permuted = permuteArray(step2, keyC);
  return permuted;
}

// --- one-sided safe assembly (same approach as before) ---
function ensureTerminator(fragment) {
  if (!fragment) return ';';
  fragment = String(fragment);
  fragment = fragment.replace(/\s+$/g, '');
  if (/[;}]$/.test(fragment)) return fragment;
  return fragment + ';';
}
function randHexStr(len) { return crypto.randomBytes(len).toString('hex'); }
function generateJunkSegment() {
  let seg = '';
  const assignments = randint(4, 10);
  for (let i = 0; i < assignments; i++) {
    const name = randChars(randint(3, 7));
    const val = randHexStr(randint(3, 6));
    seg += `${name}="${val}";`;
  }
  for (let j = 0; j < randint(1, 3); j++) {
    const fn = randId();
    const vn = randChars(6);
    const vv = randHexStr(6);
    seg += `function ${fn}() local ${vn}="${vv}"; for i=1,${randint(1,4)} do if false then ${vn}=${vn}..${vn} end end end;`;
  }
  return seg;
}
function buildOneSidedLuaSafe(fragments, targetSize) {
  const safe = fragments.map(ensureTerminator);
  let lua = safe.join('');
  lua = lua.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+/g, ';');
  lua = lua.replace(/;{2,}/g, ';');
  while (Buffer.byteLength(lua, 'utf8') < targetSize) {
    lua += generateJunkSegment();
    lua = lua.replace(/;{2,}/g, ';');
  }
  if (Buffer.byteLength(lua, 'utf8') > targetSize) lua = lua.slice(0, targetSize);
  lua = lua.replace(/\n/g, ';').replace(/;{2,}/g, ';');
  return lua;
}

// --- Build the obfuscated file text (Lua loader + data) ---
// We deliberately split the Lua decoder into many tiny helpers with randomized names to hide the method.
function buildObfFileFromEncoded(encodedArr, keyA, keyB, keyC, options) {
  const target = (options && options.targetSizeBytes) || DEFAULT_TARGET;
  const debug = !!(options && options.debug);

  const dataVar = randId();
  const kAvar = randId();
  const kBvar = randId();
  const kCvar = randId();

  // random helper names (many of them to split decoder)
  const helpers = [];
  for (let i = 0; i < 8; i++) helpers.push(randId());
  const [h_seed_to_prng, h_len, h_invperm, h_rotr, h_subA, h_build_str, h_exec, h_noop] = helpers;

  const parts = [];

  // data array
  parts.push(`${dataVar}={${encodedArr.join(',')}}`);
  // keys
  parts.push(`${kAvar}=${keyA}`);
  parts.push(`${kBvar}=${keyB}`);
  parts.push(`${kCvar}=${keyC}`);

  // helper: simple xorshift-like seed to deterministic numbers (used only to rebuild inverse permutation)
  // We'll implement a tiny arithmetic PRNG in Lua so the permutation isn't obvious
  parts.push(`local function ${h_seed_to_prng}(s) local x=s%4294967296; return function() x=((x~(x<<13))~(x>>17))~(x<<5); x=x%4294967296; return x end end`);

  // helper: length of data
  parts.push(`local function ${h_len}(t) return #t end`);

  // helper: inverse-permutation reconstruction (recreate same swaps as JS)
  // this code uses arithmetic ops and small helpers to avoid revealing a simple permute call
  parts.push(
    `local function ${h_invperm}(len, seed) local pr=${h_seed_to_prng}(seed); local idx={} for i=1,len do idx[i]=i-1 end local swaps={} for i=len-1,1,-1 do local r=(pr()% (i+1)); swaps[#swaps+1]={i,r}; local tmp=idx[i+1]; idx[i+1]=idx[r+1]; idx[r+1]=tmp end local perm={} for i=1,len do perm[i]=idx[i]+1 end local inv={} for i=1,len do inv[perm[i]]=i end return inv end`
  );

  // helper: rotate-right 8-bit (implemented with arithmetic, no bit32)
  parts.push(
    `local function ${h_rotr}(v,n) n=n%8; local a=math.floor(v/ (2^n)); local b=(v* (2^(8-n)))%256; return (a + b)%256 end`
  );

  // helper: subtract keyA (mod 256) in obfuscated arithmetic
  parts.push(
    `local function ${h_subA}(x,k) local r=x - (k%256); if r<0 then r=r+256 end return r end`
  );

  // helper: build string from byte table
  parts.push(
    `local function ${h_build_str}(tbl) local out={} for i=1,#tbl do out[#out+1]=string.char(tbl[i]) end return table.concat(out) end`
  );

  // exec helper (try load/loadstring)
  if (debug) {
    parts.push(
      `local function ${h_exec}(s) local f,err=nil,nil if type(load)=='function' then f,err=load(s) elseif type(loadstring)=='function' then f,err=loadstring(s) end if not f then error("compile failed: "..tostring(err).." | preview: "..string.sub(s,1,200)) end local ok,err2=pcall(f) if not ok then error("runtime error: "..tostring(err2)) end end`
    );
  } else {
    parts.push(`local function ${h_exec}(s) local f=nil if type(load)=='function' then f=load(s) elseif type(loadstring)=='function' then f=loadstring(s) end if not f then return end pcall(f) end`);
  }

  // extra noop helper to add noise
  parts.push(`local function ${h_noop}() local x=${randint(1,99999)} return x end`);

  // Now the main decode orchestrator — split across many tiny statements to hide full algorithm
  // 1) get len, build inverse permutation, unpermute bytes into tmp table
  parts.push(`local __len=${h_len}(${dataVar})`);

  parts.push(
    // build inverse permutation array
    `local __inv = ${h_invperm}(__len, ${kCvar})`
  );

  // create unpermuted array
  parts.push(`local __raw = {} for i=1,__len do __raw[__inv[i]] = ${dataVar}[i] end`);

  // apply rotate-right and subtract keyA in scattered statements (split operations)
  // We'll create a temp table and apply transformations in a loop (but split into multiple function calls for obfuscation)
  parts.push(`local __tmp = {} for i=1,__len do __tmp[i] = __raw[i] end`);
  parts.push(`for i=1,__len do __tmp[i] = ${h_rotr}(__tmp[i], ${kBvar}) end`);
  parts.push(`for i=1,__len do __tmp[i] = ${h_subA}(__tmp[i], ${kAvar}) end`);

  // build final string
  parts.push(`local __out = ${h_build_str}(__tmp)`);

  // run
  parts.push(`${h_exec}(__out)`);

  // add a few noisy dummy functions and junk to make reverse reading annoying
  for (let i = 0; i < 5; i++) {
    const fn = randId();
    const nm = randChars(5);
    parts.push(`function ${fn}() local ${nm}="${randHex(4)}"; for i=1,${randint(1,3)} do if false then ${nm}=${nm}..${nm} end end end`);
  }

  // assemble one-sided lua safely
  const lua = buildOneSidedLuaSafe(parts, target);
  return lua;
}

// --- Public API ---
function obfuscateLua(source, options = {}) {
  if (typeof source !== 'string') throw new Error('source must be a string');
  const target = options && options.targetSizeBytes ? options.targetSizeBytes : DEFAULT_TARGET;
  const debug = !!(options && options.debug);

  // choose random keys
  const keyA = randint(1, 255);   // additive key
  const keyB = randint(1, 7);     // rotate amount (1..7)
  const keyC = randint(1, 0xFFFFFFFF); // permutation seed

  // encode
  const encoded = encodeSourceToArray(source, keyA, keyB, keyC);

  // build obf file
  const lua = buildObfFileFromEncoded(encoded, keyA, keyB, keyC, { targetSizeBytes: target, debug: debug });
  return lua;
}

module.exports = { obfuscateLua };

// quick CLI for testing
if (require.main === module) {
  const fs = require('fs');
  const src = 'print("hello no xor"); for i=1,3 do print("i:",i) end';
  const out = obfuscateLua(src, { targetSizeBytes: 120 * 1024, debug: true });
  fs.writeFileSync('out_obf.lua', out, 'utf8');
  console.log('Wrote out_obf.lua', Buffer.byteLength(out, 'utf8'));
}
