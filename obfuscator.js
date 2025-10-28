// obfuscator.js
// One-sided intimidating obfuscator for Luau (executor-first).
// - XOR byte-array payload
// - Single-line (no newlines) output for intimidation
// - Randomized loader names, junk functions, dummy loops/conds
// - Pads to ~100KB by default
//
// Usage:
// const fs = require('fs');
// const { obfuscateLua } = require('./obfuscator');
// const out = obfuscateLua('print("hello")', { targetSizeBytes: 100*1024 });
// fs.writeFileSync('out_obf.lua', out, 'utf8');

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

function buildOneSidedLua(byteArr, key, opts){
  const target = opts.targetSizeBytes || DEFAULT_TARGET;

  // Randomized internal names
  const decodeFn = randId();
  const bxorFn = randId();
  const execFn = randId();
  const dataVar = randId();
  const tmpVar = randId();
  const guardVar = randId();

  // Small helper to generate "fake" nested functions & junk snippets
  function fakeBlock(count){
    let out = "";
    for (let i=0;i<count;i++){
      const fn = randId();
      const a = randName(6);
      const b = randHex(6);
      // create a dummy function that is never called
      out += `function ${fn}() local ${a}="${b}" for i=1,${randint(2,6)} do if i==${999999+i} then ${a}=${a}..${a} end end end`;
    }
    return out;
  }

  // Build the core loader that decodes bytes and executes original code.
  // Use bitwise fallback for XOR, try load then loadstring; executor-first.
  // We'll keep the loader as minimal as possible but randomized variable/function names.
  const dataArrayLiteral = byteArr.join(',');

  let lua = "";

  // PROGRAM header: data array and key
  lua += `${dataVar}={${dataArrayLiteral}}`;           // data var
  lua += `${guardVar}=${key}`;                         // key var

  // bxor fallback
  lua += `local function ${bxorFn}(a,b) local r=0 for i=0,7 do local ab=math.floor(a/2^i)%2 local bb=math.floor(b/2^i)%2 if ab~=bb then r=r+2^i end end return r end`;

  // decode function: builds the decoded string
  lua += `local function ${decodeFn}()`; 
  lua += `local _t={}`; 
  lua += `for i=1,#${dataVar} do _t[i]=string.char(${bxorFn}(${dataVar}[i],${guardVar})) end`;
  lua += `local s=table.concat(_t)`; 
  lua += `return s end`;

  // exec function: try load, loadstring, fallback pcall + load chunk prefix
  lua += `local function ${execFn}(s)`;
  lua += `local f = nil`;
  lua += `if type(load)=='function' then f = load(s) end`;
  lua += `if not f and type(loadstring)=='function' then f = loadstring(s) end`;
  // if still no f, try wrapping as "return (function() ... end)()" to be safe (may not be necessary)
  lua += `if not f then pcall(function() end) end`;
  lua += `if f then local ok,err = pcall(f) if not ok then -- swallow errors to keep obfuscation stealth; optionally report\n end end`;
  lua += `end`;

  // Add fake nested junk, dummy loops/conds to confuse manual readers
  lua += fakeBlock(6);
  // Add a few dummy conditional chains and loops that are never true or never run
  for (let i=0;i<8;i++){
    const v1 = randName(6);
    const v2 = randHex(4);
    lua += `local ${v1}="${v2}"`;
    lua += `if ${v1}==${v1}..'x' then for i=1,0 do ${v1}=${v1} end else if false then ${v1}=${v1} end end`;
  }

  // Run decode & exec
  lua += `local ${tmpVar}=${decodeFn}()`;
  lua += `${execFn}(${tmpVar})`;

  // Add long one-sided junk lines (assignments + fake functions) to reach target size and intimidate
  function junkLine(){
    // create long repeated assignment-ish segment
    let seg = "";
    const parts = randint(6,14);
    for (let i=0;i<parts;i++){
      seg += `${randName(4)}="${randHex(6)}"`;
    }
    // add a tiny fake loop
    seg += `function ${randId()}() for i=1,${randint(2,6)} do if i==${999999+randint(1,1000)} then return end end end`;
    return seg;
  }

  while (Buffer.byteLength(lua,'utf8') < target){
    lua += junkLine();
  }

  // Trim exactly to target size and remove newlines (one-sided)
  if (Buffer.byteLength(lua,'utf8') > target) lua = lua.slice(0, target);
  lua = lua.replace(/\n/g, ''); // ensure one-sided single-line
  return lua;
}

// Main exported function
function obfuscateLua(source, opts = {}){
  const target = opts.targetSizeBytes || DEFAULT_TARGET;
  // Choose a random XOR key
  const key = randint(1,255);
  // Convert source to byte array and XOR with key
  const bytes = toByteArray(source);
  const xored = xorArray(bytes, key);
  // Build one-sided Lua text
  const lua = buildOneSidedLua(xored, key, { targetSizeBytes: target });
  return lua;
}

module.exports = { obfuscateLua };
