// obfuscator.js
// Robust one-sided obfuscator for Luau (executor-first, loadstring-friendly).
// - XOR byte-array payload
// - Ensures separators (no }local problems)
// - Single-line intimidating output (one-sided) with junk and randomized names
// - Loader uses load() then loadstring() and reports compile/runtime errors in debug mode
//
// API:
// const { obfuscateLua } = require('./obfuscator');
// const out = obfuscateLua('print("hello")', { targetSizeBytes: 120*1024, debug: true });
// fs.writeFileSync('out_obf.lua', out, 'utf8');

const crypto = require('crypto');

const DEFAULT_TARGET = 100 * 1024;

function randint(a, b) {
  return Math.floor(Math.random() * (b - a + 1)) + a;
}
function randChars(len = 8) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function randId() {
  return randChars(6) + "_" + randChars(6);
}
function randHex(len = 8) {
  return crypto.randomBytes(len).toString('hex');
}
function toByteArray(s) {
  const arr = [];
  for (let i = 0; i < s.length; i++) arr.push(s.charCodeAt(i));
  return arr;
}
function xorArray(arr, key) {
  return arr.map(v => (v ^ key) & 0xFF);
}

// Ensure a fragment ends in a safe separator so joining won't produce syntax errors.
// We use semicolons as the canonical separator.
function ensureTerminator(fragment) {
  if (!fragment) return ';';
  fragment = String(fragment);
  fragment = fragment.replace(/\s+$/g, '');
  // If it already ends with a semicolon or a closing brace or an 'end' token, return as-is
  if (/[;}]$/.test(fragment)) return fragment;
  // Add semicolon for safety
  return fragment + ';';
}

// Generate a single junk segment (assignments + small dummy functions) — one-sided-friendly.
function generateJunkSegment() {
  let seg = '';
  const assignments = randint(4, 10);
  for (let i = 0; i < assignments; i++) {
    const name = randChars(randint(3, 7));
    const val = randHex(randint(3, 6));
    seg += `${name}="${val}";`;
  }
  // Add a few tiny dummy functions that are never called
  for (let j = 0; j < randint(1, 3); j++) {
    const fn = randId();
    const vn = randChars(6);
    const vv = randHex(6);
    seg += `function ${fn}() local ${vn}="${vv}"; for i=1,${randint(1,4)} do if false then ${vn}=${vn}..${vn} end end end;`;
  }
  return seg;
}

// Build final one-sided Lua safely from array of fragments.
// fragments: array of strings (code pieces). targetSize: bytes target.
function buildOneSidedLuaSafe(fragments, targetSize) {
  // Ensure each fragment ends with semicolon
  const safe = fragments.map(ensureTerminator);
  // Join with no additional separator (fragments already end with ;)
  let lua = safe.join('');
  // Normalize newlines defensively: convert CRLF to LF, then convert any newline to semicolon
  lua = lua.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+/g, ';');
  // Collapse repeated semicolons
  lua = lua.replace(/;{2,}/g, ';');

  // Pad with junk segments until target reached
  while (Buffer.byteLength(lua, 'utf8') < targetSize) {
    lua += generateJunkSegment();
    lua = lua.replace(/;{2,}/g, ';');
  }

  // Trim to exact target size; if trimming cuts in the middle of a multibyte sequence it is still UTF-8 safe because we only produce ASCII characters.
  if (Buffer.byteLength(lua, 'utf8') > targetSize) {
    lua = lua.slice(0, targetSize);
  }

  // Final cleanup: remove newlines and collapse semicolons
  lua = lua.replace(/\n/g, ';').replace(/;{2,}/g, ';');
  return lua;
}

// Build an obfuscated Lua file that decodes the payload and uses loadstring/load to run it.
// - xoredBytes: array of numbers (already XORed with key)
// - key: numeric XOR key (1..255)
// - options: { targetSizeBytes, debug } debug controls whether loader prints preview & errors
function buildObfFile(xoredBytes, key, options = {}) {
  const target = options.targetSizeBytes || DEFAULT_TARGET;
  const debug = !!options.debug;

  // Randomized internal names for loader functions/vars
  const dataVar = randId();      // holds data array
  const keyVar = randId();       // holds key
  const bxorFn = randId();       // bxor fallback name
  const decodeFn = randId();     // decode function name
  const execFn = randId();       // exec function name
  const tmpVar = randId();       // temp var for decoded string
  const previewLen = 200;        // how many chars to preview in debug mode

  // Pieces to join safely
  const parts = [];

  // Data array (numbers)
  parts.push(`${dataVar}={${xoredBytes.join(',')}}`); // ensureTerminator will add semicolon

  // Key
  parts.push(`${keyVar}=${key}`);

  // bxor fallback for byte XOR; keep tiny and deterministic
  parts.push(`local function ${bxorFn}(a,b) local r=0 for i=0,7 do local ab=math.floor(a/2^i)%2 local bb=math.floor(b/2^i)%2 if ab~=bb then r=r+2^i end end return r end`);

  // Decode function: reconstructs original source string
  parts.push(`local function ${decodeFn}() local _t={} for i=1,#${dataVar} do _t[i]=string.char(${bxorFn}(${dataVar}[i],${keyVar})) end local s=table.concat(_t) return s end`);

  // Exec function: try load then loadstring. In debug mode, capture compile error and print preview.
  if (debug) {
    // Debugging variant prints preview and returns compile errors as part of runtime error.
    parts.push(`local function ${execFn}(s) local f,err=nil,nil if type(load)=='function' then f,err=load(s) elseif type(loadstring)=='function' then f,err=loadstring(s) end if not f then error("compile failed: "..tostring(err).." | preview: "..string.sub(s,1,${previewLen})) end local ok,err2=pcall(f) if not ok then error("runtime error: "..tostring(err2)) end end`);
  } else {
    // Production variant: try load/loadstring, if compile fails just silently return
    parts.push(`local function ${execFn}(s) local f=nil if type(load)=='function' then f=load(s) elseif type(loadstring)=='function' then f=loadstring(s) end if not f then return end pcall(f) end`);
  }

  // Add a few fake nested functions & dummy blocks for intimidation (not called)
  for (let i = 0; i < 4; i++) {
    const fn = randId();
    const vn = randChars(6);
    const vv = randHex(6);
    parts.push(`function ${fn}() local ${vn}="${vv}" for i=1,${randint(1,4)} do if false then ${vn}=${vn}..${vn} end end end`);
  }

  // Decode + execute call
  parts.push(`local ${tmpVar}=${decodeFn}()`);
  parts.push(`${execFn}(${tmpVar})`);

  // build one-sided lua
  const lua = buildOneSidedLuaSafe(parts, target);
  return lua;
}

// Public function: obfuscateLua
// options: { targetSizeBytes: Number (defaults to 100KB), debug: Boolean (prints compile errors & preview) }
function obfuscateLua(source, options = {}) {
  if (typeof source !== 'string') throw new Error('source must be a string');
  const target = options.targetSizeBytes || DEFAULT_TARGET;
  if (typeof target !== 'number' || target < 128) throw new Error('targetSizeBytes must be a number >= 128');

  // Choose a random XOR key (1..255)
  const key = randint(1, 255);
  const bytes = toByteArray(source);
  const xored = xorArray(bytes, key);

  // Build final obfuscated one-line lua file
  const lua = buildObfFile(xored, key, options);
  return lua;
}

// Export
module.exports = { obfuscateLua };


// ----- Optional quick CLI test helper when run directly (node obfuscator.js) -----
// This block lets you run `node obfuscator.js` to generate a test file if you want.
if (require.main === module) {
  const fs = require('fs');
  const src = 'print("hello from obfuscated file")\nfor i=1,3 do print("i", i) end';
  console.log('Generating test out_one_sided.lua (120KB, debug=true)...');
  const out = obfuscateLua(src, { targetSizeBytes: 120 * 1024, debug: true });
  fs.writeFileSync('out_one_sided.lua', out, 'utf8');
  console.log('Wrote out_one_sided.lua, bytes:', Buffer.byteLength(out, 'utf8'));
}
