// obfuscator.js
// VM-based Luau obfuscator (executor & Studio friendly; does NOT use load/loadstring).
// - Emits Lua file with embedded VM interpreter.
// - Per-constant encryption (add+rotate+split) and per-build opcode permutation.
// - Interpreter is mangled (randomized names, small helpers).
// - Optionally emit one-sided single-line output.
//
// API:
// const { obfuscateLua } = require('./obfuscator');
// const out = obfuscateLua('print("hello")', { targetSizeBytes: 120*1024, oneSided: true, debug: false });
// fs.writeFileSync('out_vm.lua', out, 'utf8');

const crypto = require('crypto');

const DEFAULT_TARGET = 100 * 1024;

function randint(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
function randName(len = 8) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function randId() { return randName(6) + "_" + randName(6); }
function toBytes(s) { const a = []; for (let i = 0; i < s.length; i++) a.push(s.charCodeAt(i) & 0xFF); return a; }
function bytesToLuaArray(b) { return b.map(x => String(x)).join(','); }
function rotl8(v, n) { return ((v << n) | (v >>> (8 - n))) & 0xFF; }
function rotr8(v, n) { return ((v >>> n) | (v << (8 - n))) & 0xFF; }

// SIMPLE TOKENIZER / PARSER (subset) -> builds a simple AST
function tokenize(src) {
  const re = /\s*([A-Za-z_][A-Za-z0-9_]*|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\d+\.\d+|\d+|==|~=|<=|>=|\.{2}|.|[\n])\s*/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}
function Parser(tokens) {
  this.t = tokens; this.i = 0;
}
Parser.prototype.peek = function() { return this.t[this.i]; };
Parser.prototype.next = function() { return this.t[this.i++]; };
Parser.prototype.eat = function(tok) { if (this.peek() === tok) { this.next(); return true; } return false; };

Parser.prototype.parseChunk = function() {
  const body = [];
  while (this.i < this.t.length) {
    const p = this.peek();
    if (!p) break;
    // handle only main constructs we need
    if (p === 'local') {
      this.next();
      const name = this.next();
      if (this.eat('=')) {
        const expr = this.parseExpression();
        body.push({type: 'local_assign', name, expr});
      } else {
        body.push({type: 'local_decl', name});
      }
      continue;
    }
    if (p === 'function') {
      this.next();
      const name = this.next();
      this.eat('(');
      const params = [];
      while (this.peek() !== ')' && this.peek() !== undefined) {
        const tok = this.next();
        if (tok === ',') continue;
        params.push(tok);
      }
      this.eat(')');
      const fbody = [];
      while (this.peek() !== 'end' && this.peek() !== undefined) {
        fbody.push(this.parseStatement());
      }
      this.eat('end');
      body.push({type:'function', name, params, body: fbody});
      continue;
    }
    if (p === 'for') {
      // simplified: skip and produce noop to avoid complexity
      // users should prefer while loops
      // consume until 'end'
      this.next();
      while (this.peek() && this.peek() !== 'end') this.next();
      this.eat('end');
      continue;
    }
    // assignment or call or simple statements
    body.push(this.parseStatement());
  }
  return {type: 'chunk', body};
};

Parser.prototype.parseStatement = function() {
  const p = this.peek();
  if (!p) return {type:'noop'};
  if (p === 'return') { this.next(); const e = this.parseExpression(); return {type:'return', expr: e}; }
  if (/^[A-Za-z_]/.test(p)) {
    const id = this.next();
    if (this.peek() === '=') { this.next(); const expr = this.parseExpression(); return {type:'assign', name: id, expr}; }
    if (this.peek() === '(') {
      this.next();
      const args = [];
      while (this.peek() !== ')' && this.peek() !== undefined) {
        if (this.peek() === ',') { this.next(); continue; }
        args.push(this.parseExpression());
      }
      this.eat(')');
      return {type: 'call', callee: id, args};
    }
    return {type:'noop'};
  }
  // consume and ignore
  this.next();
  return {type:'noop'};
};

Parser.prototype.parseExpression = function() { return this.parseConcat(); };
Parser.prototype.parseConcat = function() {
  let left = this.parseAdd();
  while (this.peek() === '..') { this.next(); const right = this.parseAdd(); left = {type:'binop', op:'..', left, right}; }
  return left;
};
Parser.prototype.parseAdd = function() {
  let left = this.parseMul();
  while (this.peek() === '+' || this.peek() === '-') { const op = this.next(); const right = this.parseMul(); left = {type:'binop', op, left, right}; }
  return left;
};
Parser.prototype.parseMul = function() {
  let left = this.parsePrimary();
  while (this.peek() === '*' || this.peek() === '/') { const op = this.next(); const right = this.parsePrimary(); left = {type:'binop', op, left, right}; }
  return left;
};
Parser.prototype.parsePrimary = function() {
  const p = this.peek();
  if (!p) return {type: 'nil'};
  if (p === '(') { this.next(); const e = this.parseExpression(); this.eat(')'); return e; }
  if (/^\d/.test(p)) { this.next(); return {type:'number', value: Number(p)}; }
  if ((p[0] === '"' && p[p.length-1] === '"') || (p[0] === "'" && p[p.length-1] === "'")) { this.next(); const s = p.slice(1, -1).replace(/\\n/g,'\n').replace(/\\r/g,'\r'); return {type:'string', value: s}; }
  if (/^[A-Za-z_]/.test(p)) {
    const id = this.next();
    if (this.peek() === '(') {
      this.next();
      const args = [];
      while (this.peek() !== ')' && this.peek() !== undefined) {
        if (this.peek() === ',') { this.next(); continue; }
        args.push(this.parseExpression());
      }
      this.eat(')');
      return {type: 'call_expr', callee: id, args};
    }
    return {type: 'ident', name: id};
  }
  this.next();
  return {type:'nil'};
};

// --- Bytecode builder (simple) ---
const OPC = {
  PUSHK: 1,
  GETG: 2,
  SETG: 3,
  GETL: 4,
  SETL: 5,
  CALL: 6,
  RETURN: 7,
  ADD: 8,
  SUB: 9,
  MUL: 10,
  DIV: 11,
  CONCAT: 12,
  JMP: 13,
  JZ: 14,
  CLOSE: 255
};

function BytecodeBuilder() {
  this.consts = []; this.names = []; this.code = []; this.localSlots = {}; this.nextLocal = 0;
}
BytecodeBuilder.prototype.addConst = function(v) {
  for (let i = 0; i < this.consts.length; i++) {
    const c = this.consts[i];
    if (typeof c === 'object' && typeof v === 'object') {
      if (JSON.stringify(c) === JSON.stringify(v)) return i;
    } else if (c === v) return i;
  }
  this.consts.push(v); return this.consts.length - 1;
};
BytecodeBuilder.prototype.addName = function(n) {
  const idx = this.names.indexOf(n); if (idx !== -1) return idx; this.names.push(n); return this.names.length - 1;
};
BytecodeBuilder.prototype.emit = function() { for (let i = 0; i < arguments.length; i++) this.code.push(arguments[i]); };
BytecodeBuilder.prototype.newLocal = function(name) { if (this.localSlots[name] !== undefined) return this.localSlots[name]; const s = this.nextLocal++; this.localSlots[name] = s; return s; };

BytecodeBuilder.prototype.buildFromAst = function(ast) {
  if (!ast) return;
  if (ast.type === 'chunk') { for (const s of ast.body) this.buildFromAst(s); this.emit(OPC.CLOSE); return; }
  if (ast.type === 'local_assign') {
    const slot = this.newLocal(ast.name);
    this.buildExpr(ast.expr);
    this.emit(OPC.SETL, slot);
    return;
  }
  if (ast.type === 'assign') {
    this.buildExpr(ast.expr);
    const idx = this.addName(ast.name);
    this.emit(OPC.SETG, idx);
    return;
  }
  if (ast.type === 'call') {
    const idx = this.addName(ast.callee);
    this.emit(OPC.GETG, idx);
    for (const a of ast.args) this.buildExpr(a);
    this.emit(OPC.CALL, ast.args.length);
    return;
  }
  if (ast.type === 'function') {
    // build nested function as table
    const child = new BytecodeBuilder();
    for (let i = 0; i < ast.params.length; i++) child.localSlots[ast.params[i]] = i;
    child.nextLocal = ast.params.length;
    for (const s of ast.body) child.buildFromAst(s);
    child.emit(OPC.RETURN, 0);
    child.emit(OPC.CLOSE);
    const fnObj = { consts: child.consts, names: child.names, code: child.code };
    const cidx = this.addConst(fnObj);
    const nameIdx = this.addName(ast.name);
    this.emit(OPC.PUSHK, cidx);
    this.emit(OPC.SETG, nameIdx);
    return;
  }
  if (ast.type === 'return') {
    this.buildExpr(ast.expr);
    this.emit(OPC.RETURN, 1);
    return;
  }
  if (ast.type === 'noop') return;
  if (ast.type === 'while') {
    const start = this.code.length;
    this.buildExpr(ast.cond);
    this.emit(OPC.JZ, 0); const jz = this.code.length - 1;
    for (const s of ast.body) this.buildFromAst(s);
    this.emit(OPC.JMP, start);
    const end = this.code.length;
    this.code[jz + 1] = end;
    return;
  }
};

BytecodeBuilder.prototype.buildExpr = function(expr) {
  if (!expr) { this.emit(OPC.PUSHK, this.addConst(null)); return; }
  if (expr.type === 'number') { this.emit(OPC.PUSHK, this.addConst(expr.value)); return; }
  if (expr.type === 'string') { this.emit(OPC.PUSHK, this.addConst(expr.value)); return; }
  if (expr.type === 'ident') {
    if (expr.name in this.localSlots) { this.emit(OPC.GETL, this.localSlots[expr.name]); return; }
    const nidx = this.addName(expr.name);
    this.emit(OPC.GETG, nidx); return;
  }
  if (expr.type === 'call_expr') {
    if (expr.callee in this.localSlots) this.emit(OPC.GETL, this.localSlots[expr.callee]); else this.emit(OPC.GETG, this.addName(expr.callee));
    for (const a of expr.args) this.buildExpr(a);
    this.emit(OPC.CALL, expr.args.length);
    return;
  }
  if (expr.type === 'binop') {
    this.buildExpr(expr.left);
    this.buildExpr(expr.right);
    if (expr.op === '+') this.emit(OPC.ADD);
    else if (expr.op === '-') this.emit(OPC.SUB);
    else if (expr.op === '*') this.emit(OPC.MUL);
    else if (expr.op === '/') this.emit(OPC.DIV);
    else if (expr.op === '..') this.emit(OPC.CONCAT);
    else this.emit(OPC.ADD);
    return;
  }
  this.emit(OPC.PUSHK, this.addConst(null));
};

// --- PER-CONSTANT ENCRYPTION (add + rotate + split chunks)
// We encrypt string constants into multiple chunks. Each chunk is an array of bytes with its own small key and index mapping.
// That means constants are not stored as one plaintext blob in the file.

function encryptConstantString(str) {
  const bytes = toBytes(str || "");
  // split into chunks of random length to complicate reconstruction
  const chunks = [];
  let i = 0;
  while (i < bytes.length) {
    const len = Math.min(bytes.length - i, randint(6, Math.max(6, Math.min(32, Math.floor(bytes.length / 2) || 6))));
    const raw = bytes.slice(i, i + len);
    const keyA = randint(1, 254);
    const keyB = randint(1, 7);
    // apply add+rotl
    const transformed = raw.map(b => rotl8((b + keyA) & 0xFF, keyB));
    // also shuffle indices deterministically via a small PRNG seeded per-chunk
    const seed = crypto.randomBytes(4).readUInt32LE(0) >>> 0;
    // simple Fisher-Yates with deterministic PRNG
    const arr = transformed.slice();
    let pr = seed;
    function nxt() { pr = (1103515245 * pr + 12345) >>> 0; return pr; }
    for (let j = arr.length - 1; j > 0; j--) {
      const r = nxt() % (j + 1);
      const tmp = arr[j]; arr[j] = arr[r]; arr[r] = tmp;
    }
    // store chunk metadata: seed, keyA, keyB, data array
    chunks.push({seed, keyA, keyB, data: arr});
    i += len;
  }
  return chunks;
}

// --- serialize program into Lua data (consts encoded)
function serializeProgram(builder, permutedOps) {
  // consts: numbers and encrypted string-chunk lists; nested function objects handled recursively.
  const constsLua = builder.consts.map(c => {
    if (c === null) return 'nil';
    if (typeof c === 'number') return String(c);
    if (typeof c === 'string') {
      const chunks = encryptConstantString(c);
      // produce a Lua representation: {{seed=..., a=..., b=..., data={...}}, {...}}
      const chunksLua = chunks.map(ch => `{ seed=${ch.seed}, a=${ch.keyA}, b=${ch.keyB}, data={${bytesToLuaArray(ch.data)}} }`).join(',');
      return `{__s=true, chunks={${chunksLua}}}`;
    }
    if (typeof c === 'object' && c.consts && c.names && c.code) {
      // nested function object: serialize nested consts (strings inside nested function are encoded too).
      const nestedConsts = c.consts.map(nc => {
        if (nc === null) return 'nil';
        if (typeof nc === 'number') return String(nc);
        if (typeof nc === 'string') {
          const chks = encryptConstantString(nc);
          const chksLua = chks.map(cc => `{ seed=${cc.seed}, a=${cc.keyA}, b=${cc.keyB}, data={${bytesToLuaArray(cc.data)}} }`).join(',');
          return `{__s=true, chunks={${chksLua}}}`;
        }
        return 'nil';
      }).join(',');
      const nestedNames = c.names.map(n => `"${String(n).replace(/"/g,'\\"')}"`).join(',');
      const nestedCode = c.code.join(',');
      return `{ consts = { ${nestedConsts} }, names = { ${nestedNames} }, code = { ${nestedCode} } }`;
    }
    return 'nil';
  }).join(',');

  const namesLua = builder.names.map(n => `"${String(n).replace(/"/g,'\\"')}"`).join(',');
  const codeLua = builder.code.join(',');

  // include permuted opcodes mapping
  const opsLua = Object.keys(permutedOps).map(k => `${k}=${permutedOps[k]}`).join(',');

  // produce program table (no top-level return)
  return `
PROGRAM = {
  ops = { ${opsLua} },
  consts = { ${constsLua} },
  names = { ${namesLua} },
  code = { ${codeLua} }
}
`;
}

// permute opcodes per build
function permuteOpsMap() {
  const keys = Object.keys(OPC);
  const vals = Object.values(OPC);
  const shuffled = vals.slice().sort(() => Math.random() - 0.5);
  const map = {};
  keys.forEach((k, i) => map[k] = shuffled[i]);
  return map;
}

// Build interpreter (Luau) — runs bytecode, decodes per-constant encrypted chunks (reverses shuffle, rotr, subtract)
function buildLuaInterpreter(programLua, permMap, targetSize, oneSided) {
  // randomize some function names used inside the interpreter to make static matching harder
  const fn_build_chunks = randId();
  const fn_rotr = randId();
  const fn_sub = randId();
  const fn_unshuffle = randId();
  const fn_buildstr = randId();
  const fn_run = randId();
  // produce interpreter text (careful: must be valid Luau)
  let lua = programLua;

  lua += `
-- helper: rotate-right 8-bit
local function ${fn_rotr}(v,n) n=n%8; local a=math.floor(v/ (2^n)); local b=(v* (2^(8-n)))%256; return (a + b)%256 end

-- helper: subtract keyA modulo 256
local function ${fn_sub}(x,k) local r = x - (k%256) if r < 0 then r = r + 256 end return r end

-- helper: unshuffle using same PRNG (linear congruential style)
local function ${fn_unshuffle}(arr, seed)
  local len = #arr
  local idx = {}
  for i=1,len do idx[i-1] = i-1 end
  local swaps = {}
  local pr = seed
  local function prng()
    pr = (1103515245 * pr + 12345) % 4294967296
    return pr
  end
  for i = len-1,1,-1 do
    local r = prng() % (i+1)
    swaps[#swaps+1] = {i, r}
    local tmp = idx[i+1]; idx[i+1] = idx[r+1]; idx[r+1] = tmp
  end
  local perm = {}
  for i=1,len do perm[i] = idx[i] + 1 end
  local inv = {}
  for i=1,len do inv[perm[i]] = i end
  local out = {}
  for i=1,len do out[inv[i]] = arr[i] end
  return out
end

-- build string from chunks (chunks: { {seed=.., a=.., b=.., data={..}}, ... })
local function ${fn_buildstr}(chunks)
  local bytes = {}
  for ci=1,#chunks do
    local ch = chunks[ci]
    local data = ch.data
    -- unshuffle using seed
    local arr = ${fn_unshuffle}(data, ch.seed)
    -- rotate-right by b and subtract a
    for j=1,#arr do
      local v = ${fn_rotr}(arr[j], ch.b)
      v = ${fn_sub}(v, ch.a)
      bytes[#bytes+1] = v
    end
  end
  local out = {}
  for i=1,#bytes do out[i] = string.char(bytes[i]) end
  return table.concat(out)
end

-- decode all program constants into runtime consts
local RCONST = {}
for i=1,#PROGRAM.consts do
  local c = PROGRAM.consts[i]
  if type(c) == 'table' and c.__s then
    RCONST[i] = ${fn_buildstr}(c.chunks)
  elseif type(c) == 'number' or type(c)=='string' or c==nil then
    RCONST[i] = c
  else
    -- nested function object table: build runtime object with decoded consts
    if type(c) == 'table' and c.consts then
      local nested = { consts = {}, names = c.names, code = c.code }
      for j=1,#c.consts do
        local nc = c.consts[j]
        if type(nc) == 'table' and nc.__s then nested.consts[j] = ${fn_buildstr}(nc.chunks) else nested.consts[j] = nc end
      end
      RCONST[i] = nested
    else
      RCONST[i] = c
    end
  end
end

-- op mapping
local OPS = {}
`;
  // append permMap values into lua
  const opLines = Object.keys(permMap).map(k => `OPS["${k}"] = ${permMap[k]};`).join('\n');
  lua += opLines + '\n';

  // interpreter runner (mangled but straightforward)
  lua += `
local function ${fn_run}()
  local code = PROGRAM.code
  local names = PROGRAM.names
  local ip = 1
  local stack = {}
  local locals = {}
  local function push(v) stack[#stack+1] = v end
  local function pop() local v = stack[#stack]; stack[#stack] = nil; return v end
  while ip <= #code do
    local op = code[ip]; ip = ip + 1
    if op == OPS.PUSHK then
      local idx = code[ip]; ip = ip + 1
      local val = RCONST[idx+1]
      -- if nested function object, create closure that runs it
      if type(val) == 'table' and val.code then
        local child = val
        local function closure(...)
          local child_const_r = {}
          for ii=1,#child.consts do child_const_r[ii] = child.consts[ii] end
          -- run child code (simple runner)
          -- implement minimal runner for nested function (recurse)
          local saved_prog = PROGRAM
          local saved_RCONST = RCONST
          PROGRAM = { code = child.code, names = child.names, consts = child.consts }
          -- decode child's consts on the fly
          local child_runtime_consts = {}
          for cidx=1,#child.consts do
            local cc = child.consts[cidx]
            if type(cc)=='table' and cc.__s then child_runtime_consts[cidx] = ${fn_buildstr}(cc.chunks) else child_runtime_consts[cidx] = cc end
          end
          RCONST = child_runtime_consts
          local res
          do
            local ip2 = 1
            local stack2 = {}
            local function push2(v) stack2[#stack2+1] = v end
            local function pop2() local v = stack2[#stack2]; stack2[#stack2] = nil; return v end
            while ip2 <= #child.code do
              local op2 = child.code[ip2]; ip2 = ip2 + 1
              if op2 == OPS.PUSHK then local idx2 = child.code[ip2]; ip2 = ip2 + 1; push2(child_runtime_consts[idx2+1])
              elseif op2 == OPS.GETG then local nidx = child.code[ip2]; ip2 = ip2 + 1; push2(_G[child.names[nidx+1]])
              elseif op2 == OPS.CALL then local nargs = child.code[ip2]; ip2 = ip2 + 1; local args = {} for ri=1,nargs do args[nargs-ri+1] = pop2() end; local fnc = pop2(); if type(fnc)=='function' then local ok,r = pcall(fnc, table.unpack(args)); if ok then push2(r) else push2(nil) end else push2(nil) end
              elseif op2 == OPS.RETURN then local n = child.code[ip2]; ip2 = ip2 + 1; local outt = {}; for ri=1,n do outt[n-ri+1] = pop2() end; res = table.unpack(outt); break
              elseif op2 == OPS.CLOSE then break
              else
                -- arithmetic ops limited in nested POC
                if op2 == OPS.ADD then local b=pop2(); local a=pop2(); push2(a+b)
                elseif op2 == OPS.CONCAT then local b=pop2(); local a=pop2(); push2(tostring(a)..tostring(b))
                else
                  -- unsupported op: ignore
                end
              end
            end
          end
          -- restore globals
          PROGRAM = saved_prog
          RCONST = saved_RCONST
          return res
        end
        push(closure)
      else
        push(val)
      end
    elseif op == OPS.GETG then
      local nidx = code[ip]; ip = ip + 1
      push(_G[names[nidx+1]])
    elseif op == OPS.SETG then
      local nidx = code[ip]; ip = ip + 1
      local v = pop(); _G[names[nidx+1]] = v
    elseif op == OPS.GETL then
      local slot = code[ip]; ip = ip + 1; push(locals[slot+1])
    elseif op == OPS.SETL then
      local slot = code[ip]; ip = ip + 1; locals[slot+1] = pop()
    elseif op == OPS.CALL then
      local nargs = code[ip]; ip = ip + 1; local args = {} for i=1,nargs do args[nargs-i+1] = pop() end; local fn = pop()
      if type(fn) == 'function' then local ok,res = pcall(fn, table.unpack(args)); if ok then push(res) else push(nil) end else push(nil) end
    elseif op == OPS.RETURN then
      local n = code[ip]; ip = ip + 1; local out = {}; for i=1,n do out[n-i+1] = pop() end; return table.unpack(out)
    elseif op == OPS.ADD then local b=pop(); local a=pop(); push(a + b)
    elseif op == OPS.SUB then local b=pop(); local a=pop(); push(a - b)
    elseif op == OPS.MUL then local b=pop(); local a=pop(); push(a * b)
    elseif op == OPS.DIV then local b=pop(); local a=pop(); push(a / b)
    elseif op == OPS.CONCAT then local b=pop(); local a=pop(); push(tostring(a)..tostring(b))
    elseif op == OPS.JMP then local target = code[ip]; ip = target + 1
    elseif op == OPS.JZ then local target = code[ip]; ip = ip + 1; local v = pop(); if not v then ip = target + 1 end
    elseif op == OPS.CLOSE then break
    else
      -- unknown opcode: break
      break
    end
  end
end

-- run
pcall(${fn_run})
`;

  // pad to target size
  let out = lua;
  if (oneSided) {
    out = out.replace(/\n/g, ';');
  }
  while (Buffer.byteLength(out, 'utf8') < targetSize) {
    out += `;${randName(6)}="${crypto.randomBytes(6).toString('hex')}"`;
  }
  if (Buffer.byteLength(out, 'utf8') > targetSize) out = out.slice(0, targetSize);
  return out;
}

// --- top-level obfuscate function
function obfuscateLua(source, opts = {}) {
  if (typeof source !== 'string') throw new Error('source must be string');
  const targetSize = opts.targetSizeBytes || DEFAULT_TARGET;
  const oneSided = !!opts.oneSided;
  const debug = !!opts.debug;

  // parse
  const tokens = tokenize(source);
  const p = new Parser(tokens);
  const ast = p.parseChunk();

  // build bytecode
  const builder = new BytecodeBuilder();
  builder.buildFromAst(ast);

  // permute ops
  const permMap = permuteOps = (function(){
    const keys = Object.keys(OPC);
    const vals = Object.values(OPC);
    const shuffled = vals.slice().sort(() => Math.random() - 0.5);
    const mapping = {};
    keys.forEach((k,i) => mapping[k] = shuffled[i]);
    return mapping;
  })();

  // serialize program (with encrypted consts)
  const programLua = serializeProgram(builder, permMap);

  // build final Lua interpreter file
  const finalLua = buildLuaInterpreter(programLua, permMap, targetSize, oneSided);

  return finalLua;
}

module.exports = { obfuscateLua };

// quick test when run directly
if (require.main === module) {
  const fs = require('fs');
  const src = 'print("hello"); for i=1,3 do print("i", i) end';
  const out = obfuscateLua(src, { targetSizeBytes: 120 * 1024, oneSided: false, debug: false });
  fs.writeFileSync('out_vm_obf.lua', out, 'utf8');
  console.log('Wrote out_vm_obf.lua', Buffer.byteLength(out, 'utf8'));
    }
