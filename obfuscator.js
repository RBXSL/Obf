// obfuscator.js
// VM obfuscator proof-of-concept for Luau (Roblox).
// - Small parser for a useful subset
// - Emits bytecode, encodes payload (XOR + base64)
// - Emits a Luau-compatible interpreter (visible) that executes bytecode
// - Adds junk to reach target size

const crypto = require('crypto');

///// Configurable constants
const DEFAULT_TARGET = 100 * 1024; // 100 KB
const XOR_KEY_MIN = 1;
const XOR_KEY_MAX = 255;

///// Utilities
function randName(len = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function randint(a,b){ return Math.floor(Math.random()*(b-a+1))+a; }
function toBase64(buf){ return Buffer.from(buf, 'binary').toString('base64'); }
function xorBuffer(buf, key){
  const out = Buffer.alloc(buf.length);
  for (let i=0;i<buf.length;i++) out[i] = buf[i] ^ key;
  return out;
}

///// Tokenizer (very small)
function tokenize(src){
  const tokens = [];
  const re = /\s*([A-Za-z_][A-Za-z0-9_]*|\d+\.\d+|\d+|==|~=|<=|>=|\.{2}|.|\n)\s*/g;
  let m;
  while ((m = re.exec(src)) !== null){
    tokens.push(m[1]);
  }
  return tokens;
}

///// Parser (subset)
function Parser(tokens){
  this.toks = tokens;
  this.i = 0;
}
Parser.prototype.peek = function(){ return this.toks[this.i]; };
Parser.prototype.next = function(){ return this.toks[this.i++]; };
Parser.prototype.eat = function(tok){
  if (this.peek() === tok) { this.next(); return true; }
  return false;
};

Parser.prototype.parseChunk = function(){
  const stmts = [];
  while (this.i < this.toks.length){
    const p = this.peek();
    if (p === 'end' || p === undefined) break;
    stmts.push(this.parseStatement());
  }
  return { type: 'chunk', body: stmts };
};

Parser.prototype.parseStatement = function(){
  const p = this.peek();
  if (p === 'local'){
    this.next(); // consume local
    const name = this.next(); // identifier
    if (this.eat('=')){
      const expr = this.parseExpression();
      return { type:'local_assign', name, expr };
    } else {
      // local declaration without init
      return { type:'local_decl', name };
    }
  }
  if (p === 'function'){
    // function name (simple) or global?
    this.next();
    const name = this.next();
    this.eat('(');
    const params = [];
    while (this.peek() !== ')' && this.peek() !== undefined){
      const tok = this.next();
      if (tok === ',') continue;
      params.push(tok);
    }
    this.eat(')');
    const body = [];
    while (this.peek() !== 'end' && this.peek() !== undefined){
      body.push(this.parseStatement());
    }
    this.eat('end');
    return { type:'function', name, params, body };
  }
  if (p === 'return'){
    this.next();
    const expr = this.parseExpression();
    return { type:'return', expr };
  }
  // assignment or function call
  // simple pattern: id = expr  OR id ( ... )
  if (/^[A-Za-z_]/.test(p)){
    const id = this.next();
    if (this.peek() === '='){
      this.next();
      const expr = this.parseExpression();
      return { type:'assign', name:id, expr };
    } else if (this.peek() === '('){
      // function call
      this.eat('(');
      const args = [];
      while (this.peek() !== ')' && this.peek() !== undefined){
        if (this.peek() === ','){ this.next(); continue; }
        args.push(this.parseExpression());
      }
      this.eat(')');
      return { type:'call', callee:id, args };
    } else {
      // bare expression / unsupported -> treat as noop
      return { type:'noop' };
    }
  }
  // skip token
  this.next();
  return { type:'noop' };
};

Parser.prototype.parseExpression = function(){
  return this.parseConcat();
};

// support .. (concat) with lower precedence
Parser.prototype.parseConcat = function(){
  let left = this.parseAdd();
  while (this.peek() === '..'){
    this.next();
    const right = this.parseAdd();
    left = { type:'binop', op:'..', left, right };
  }
  return left;
};
Parser.prototype.parseAdd = function(){
  let left = this.parseMul();
  while (this.peek() === '+' || this.peek() === '-'){
    const op = this.next();
    const right = this.parseMul();
    left = { type:'binop', op, left, right };
  }
  return left;
};
Parser.prototype.parseMul = function(){
  let left = this.parsePrimary();
  while (this.peek() === '*' || this.peek() === '/'){
    const op = this.next();
    const right = this.parsePrimary();
    left = { type:'binop', op, left, right };
  }
  return left;
};
Parser.prototype.parsePrimary = function(){
  const p = this.peek();
  if (!p) return { type:'nil' };
  if (p === '('){
    this.next(); const e = this.parseExpression(); this.eat(')'); return e;
  }
  if (/^\d/.test(p)){
    this.next(); return { type:'number', value: Number(p) };
  }
  if (p === '"' || p==='\''){
    // shouldn't happen due to tokenizer; but fallback
  }
  // strings: tokens may include the full quoted string if tokenizer kept quotes; we used regex that produces single chars, so we find strings by scanning original source separately.
  if (/^".*"$/.test(p) || /^'.*'$/.test(p)){
    this.next(); return { type:'string', value: p.slice(1,-1) };
  }
  // identifier or function call as expression
  if (/^[A-Za-z_]/.test(p)){
    const id = this.next();
    if (this.peek() === '('){
      this.eat('(');
      const args = [];
      while (this.peek() !== ')' && this.peek() !== undefined){
        if (this.peek() === ','){ this.next(); continue;}
        args.push(this.parseExpression());
      }
      this.eat(')');
      return { type:'call_expr', callee:id, args };
    } else {
      return { type:'ident', name:id };
    }
  }
  // fallback
  this.next();
  return { type:'nil' };
};

///// Bytecode builder
const OPCODES = {
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
  CLOSE: 255
};

function BytecodeBuilder(){
  this.consts = []; // array of constants
  this.names = [];  // global names
  this.code = [];   // number array: [op, arg1, arg2 ...]
  this.localSlots = {}; // map function-scope locals to slot index (only 0..N)
}
BytecodeBuilder.prototype.addConst = function(v){
  const key = (typeof v) + '::' + String(v);
  const idx = this.consts.indexOf(v);
  if (idx !== -1) return idx;
  this.consts.push(v);
  return this.consts.length - 1;
};
BytecodeBuilder.prototype.addName = function(n){
  const idx = this.names.indexOf(n);
  if (idx !== -1) return idx;
  this.names.push(n);
  return this.names.length - 1;
};
BytecodeBuilder.prototype.emit = function(){
  for (let i=0;i<arguments.length;i++) this.code.push(arguments[i]);
};
BytecodeBuilder.prototype.buildFromAst = function(ast){
  if (ast.type === 'chunk'){
    for (const s of ast.body) this.buildFromAst(s);
    this.emit(OPCODES.CLOSE);
    return;
  }
  if (ast.type === 'local_assign'){
    // local name = expr
    const slot = Object.keys(this.localSlots).length;
    this.localSlots[ast.name] = slot;
    this.buildExpr(ast.expr);
    this.emit(OPCODES.SETL, slot);
    return;
  }
  if (ast.type === 'assign'){
    // name = expr (global)
    this.buildExpr(ast.expr);
    const idx = this.addName(ast.name);
    this.emit(OPCODES.SETG, idx);
    return;
  }
  if (ast.type === 'call'){
    // push global function
    const idx = this.addName(ast.callee);
    this.emit(OPCODES.GETG, idx);
    for (const a of ast.args){
      this.buildExpr(a);
    }
    this.emit(OPCODES.CALL, ast.args.length);
    // pop result implicitly
    return;
  }
  if (ast.type === 'function'){
    // For POC: we support top-level function definitions by storing function as a constant
    // Build a child builder for body
    const child = new BytecodeBuilder();
    // map params to local slots
    for (let i=0;i<ast.params.length;i++){
      child.localSlots[ast.params[i]] = i; // params occupy first slots
    }
    for (const s of ast.body) child.buildFromAst(s);
    child.emit(OPCODES.RETURN, 0);
    child.emit(OPCODES.CLOSE);
    // make a serialized function object: {consts, names, code, locals}
    const fnObj = { consts: child.consts, names: child.names, code: child.code };
    const cidx = this.addConst(fnObj);
    const nameIdx = this.addName(ast.name);
    this.emit(OPCODES.PUSHK, cidx);
    this.emit(OPCODES.SETG, nameIdx);
    return;
  }
  if (ast.type === 'return'){
    this.buildExpr(ast.expr);
    this.emit(OPCODES.RETURN, 1);
    return;
  }
  if (ast.type === 'noop') return;
  // fallback
};

BytecodeBuilder.prototype.buildExpr = function(expr){
  if (!expr) { this.emit(OPCODES.PUSHK, this.addConst(null)); return; }
  if (expr.type === 'number'){
    const idx = this.addConst(expr.value);
    this.emit(OPCODES.PUSHK, idx); return;
  }
  if (expr.type === 'string'){
    const idx = this.addConst(expr.value);
    this.emit(OPCODES.PUSHK, idx); return;
  }
  if (expr.type === 'ident'){
    // global or local?
    if (expr.name in this.localSlots){
      this.emit(OPCODES.GETL, this.localSlots[expr.name]); return;
    } else {
      const nidx = this.addName(expr.name);
      this.emit(OPCODES.GETG, nidx); return;
    }
  }
  if (expr.type === 'call_expr'){
    // push function value
    if (expr.callee in this.localSlots){
      this.emit(OPCODES.GETL, this.localSlots[expr.callee]);
    } else {
      this.emit(OPCODES.GETG, this.addName(expr.callee));
    }
    for (const a of expr.args) this.buildExpr(a);
    this.emit(OPCODES.CALL, expr.args.length);
    return;
  }
  if (expr.type === 'binop'){
    this.buildExpr(expr.left);
    this.buildExpr(expr.right);
    if (expr.op === '+') this.emit(OPCODES.ADD);
    else if (expr.op === '-') this.emit(OPCODES.SUB);
    else if (expr.op === '*') this.emit(OPCODES.MUL);
    else if (expr.op === '/') this.emit(OPCODES.DIV);
    else if (expr.op === '..') this.emit(OPCODES.CONCAT);
    else this.emit(OPCODES.ADD);
    return;
  }
  // default nil
  this.emit(OPCODES.PUSHK, this.addConst(null));
};

///// Serializer: create a compact binary representation
function serializeProgram(builder){
  // Simple JSON-like serialization, then to buffer
  const obj = { consts: builder.consts, names: builder.names, code: builder.code };
  const s = JSON.stringify(obj);
  return Buffer.from(s, 'utf8');
}

///// Build Lua loader (interpreter) code (Luau-compatible)
function buildLuaInterpreterPayload(base64Payload, xorKey){
  // We'll embed a small interpreter in Lua that:
  // - base64-decodes the payload
  // - XOR-decrypts bytes
  // - parses JSON using a tiny local parser (we'll keep serialized payload simple so we can use load on a Lua literal)
  // For safety (no loadstring used), we will decode JSON-ish string and use a tiny JSON parse in Lua.
  // To keep POC short, we'll pass payload as a base64-encoded JSON string, then in Lua do a small decode + "load" into a table via safe deserialization.
  // Note: implementing a full JSON parser in Lua is long; instead we will produce a Lua table literal at serialization time (not JSON).
  // So change: serializeProgram will produce a Lua table text rather than JSON — easier to load via load (but not loadstring required? interpreter will parse the table via an internal parser).
  // To simplify: we will embed the decoded string and then run 'load' on 'return ' .. decoded to get a table (this uses load and is allowed in executors; in Studio some load usage is restricted — but VM obfuscator is primarily for executor mode; if Studio compatibility is needed, we can implement a small parser.)

  // For executor mode we can use load to create the table. We'll use load (exists in many executors).
  // Build bootstrap that decodes and 'load's the table, then interprets bytecode.

  // The Lua loader below will:
  // - have base64 decoder (internal)
  // - decode payload to text
  // - XOR with key
  // - load('return '..text) to reconstruct table {consts=..., names=..., code=...}
  // - run VM interpreter over the code

  const lua = `
-- VM loader generated
local payload_b64 = "${base64Payload}"
local xor_key = ${xorKey}

local function b64dec(s)
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

local enc = b64dec(payload_b64)
local bytes = {}
for i=1,#enc do bytes[i] = string.byte(enc,i) ~ xor_key end
local txt = string.char(unpack(bytes))
-- 'txt' now contains Lua source for a table literal; we will load it via load (executor-only)
local loader = load("return "..txt)
if not loader then error("vm: failed to load payload") end
local prog = loader()
-- prog = { consts = {...}, names = {...}, code = {...} }

-- interpreter
local OP = { PUSHK=1, GETG=2, SETG=3, GETL=4, SETL=5, CALL=6, RETURN=7, ADD=8, SUB=9, MUL=10, DIV=11, CONCAT=12, CLOSE=255 }

local function run(prog)
  local consts = prog.consts
  local names = prog.names
  local code = prog.code
  local ip = 1
  local stack = {}
  local locals = {}
  local function push(v) stack[#stack+1]=v end
  local function pop() local v = stack[#stack]; stack[#stack]=nil; return v end

  while ip <= #code do
    local op = code[ip]; ip = ip + 1
    if op == OP.PUSHK then
      local idx = code[ip]; ip = ip + 1
      push(consts[idx+1])
    elseif op == OP.GETG then
      local nidx = code[ip]; ip = ip + 1
      push(_G[names[nidx+1]])
    elseif op == OP.SETG then
      local nidx = code[ip]; ip = ip + 1
      local v = pop()
      _G[names[nidx+1]] = v
    elseif op == OP.GETL then
      local slot = code[ip]; ip = ip + 1
      push(locals[slot+1])
    elseif op == OP.SETL then
      local slot = code[ip]; ip = ip + 1
      locals[slot+1] = pop()
    elseif op == OP.CALL then
      local nargs = code[ip]; ip = ip + 1
      local args = {}
      for i=1,nargs do args[nargs-i+1] = pop() end
      local fn = pop()
      if type(fn) == 'function' then
        local ok,res = pcall(fn, table.unpack(args))
        if ok then
          push(res)
        else
          push(nil)
        end
      else
        push(nil)
      end
    elseif op == OP.RETURN then
      local n = code[ip]; ip = ip + 1
      local out = {}
      for i=1,n do out[n-i+1] = pop() end
      return table.unpack(out)
    elseif op == OP.ADD then local b=pop(); local a=pop(); push(a + b)
    elseif op == OP.SUB then local b=pop(); local a=pop(); push(a - b)
    elseif op == OP.MUL then local b=pop(); local a=pop(); push(a * b)
    elseif op == OP.DIV then local b=pop(); local a=pop(); push(a / b)
    elseif op == OP.CONCAT then local b=pop(); local a=pop(); push(tostring(a)..tostring(b))
    elseif op == OP.CLOSE then break
    else
      error("vm: unknown opcode "..tostring(op))
    end
  end
end

-- run
run(prog)
`;

  return lua;
}

///// High level obfuscate function
function obfuscateLua(source, opts = {}){
  const target = opts.targetSizeBytes || DEFAULT_TARGET;
  const key = randint(XOR_KEY_MIN, XOR_KEY_MAX);

  // tokenize and parse
  const tokens = tokenize(source);
  const p = new Parser(tokens);
  const ast = p.parseChunk();

  // build bytecode
  const builder = new BytecodeBuilder();
  builder.buildFromAst(ast);

  // serialize program to a Lua table literal string
  // We'll produce a Lua table literal like: { consts = {...}, names = {...}, code = {...} }
  const tableLit = (() => {
    function litVal(v){
      if (v === null || v === undefined) return 'nil';
      if (typeof v === 'number') return String(v);
      if (typeof v === 'string') {
        return '"' + v.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,'\\n') + '"';
      }
      if (typeof v === 'object') {
        // function object for nested functions (child bytecode)
        // recursively emit nested table
        if (v.consts && v.names && v.code){
          return '{ consts = {' + v.consts.map(litVal).join(',') + '}, names = {' + v.names.map(litVal).join(',') + '}, code = {' + v.code.join(',') + '} }';
        }
      }
      return 'nil';
    }
    const constsPart = builder.consts.map(litVal).join(',');
    const namesPart = builder.names.map(s=> '"' + String(s).replace(/"/g,'\\"') + '"' ).join(',');
    const codePart = builder.code.join(',');
    return '{ consts = {' + constsPart + '}, names = {' + namesPart + '}, code = {' + codePart + '} }';
  })();

  // XOR + base64 encode the table literal text
  const payloadBuf = Buffer.from(tableLit, 'utf8');
  const xored = xorBuffer(payloadBuf, key);
  const b64 = toBase64(xored);

  // build lua interpreter payload (bootstrap that loads and runs)
  const luaLoader = buildLuaInterpreterPayload(b64, key);

  // add junk until target size
  let final = '-- OBFUSCATED VM PAYLOAD\n' + luaLoader;
  while (Buffer.byteLength(final, 'utf8') < target){
    final += '\n-- ' + randName(8) + ' = "' + crypto.randomBytes(8).toString('hex') + '"\n';
  }
  // trim to target (safe cut)
  if (Buffer.byteLength(final, 'utf8') > target) {
    final = final.slice(0, target);
  }

  return final;
}

module.exports = { obfuscateLua };
