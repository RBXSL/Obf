// obfuscator.js (fixed loader: portable XOR & safe load)
// VM obfuscator POC for executor environments (uses load/loadstring).
const crypto = require('crypto');

const DEFAULT_TARGET = 100 * 1024;
const XOR_KEY_MIN = 1;
const XOR_KEY_MAX = 255;

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

// simple tokenizer & parser (subset) - identical to prior POC
function tokenize(src){
  const tokens = [];
  const re = /\s*([A-Za-z_][A-Za-z0-9_]*|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\d+\.\d+|\d+|==|~=|<=|>=|\.{2}|.|\n)\s*/g;
  let m;
  while ((m = re.exec(src)) !== null){
    tokens.push(m[1]);
  }
  return tokens;
}

// Parser constructor
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
// parseChunk / parseStatement / parseExpression (same subset as before)
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
    this.next();
    const name = this.next();
    if (this.eat('=')){
      const expr = this.parseExpression();
      return { type:'local_assign', name, expr };
    } else return { type:'local_decl', name };
  }
  if (p === 'function'){
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
    while (this.peek() !== 'end' && this.peek() !== undefined) body.push(this.parseStatement());
    this.eat('end');
    return { type:'function', name, params, body };
  }
  if (p === 'return'){
    this.next();
    const expr = this.parseExpression();
    return { type:'return', expr };
  }
  if (p === 'while'){
    this.next();
    const cond = this.parseExpression();
    this.eat('do');
    const body = [];
    while (this.peek() !== 'end' && this.peek() !== undefined) body.push(this.parseStatement());
    this.eat('end');
    return { type:'while', cond, body };
  }
  if (/^[A-Za-z_]/.test(p)){
    const id = this.next();
    if (this.peek() === '='){ this.next(); const expr = this.parseExpression(); return { type:'assign', name:id, expr }; }
    else if (this.peek() === '('){
      this.eat('(');
      const args = [];
      while (this.peek() !== ')' && this.peek() !== undefined){
        if (this.peek() === ','){ this.next(); continue; }
        args.push(this.parseExpression());
      }
      this.eat(')');
      return { type:'call', callee:id, args };
    } else return { type:'noop' };
  }
  this.next();
  return { type:'noop' };
};
Parser.prototype.parseExpression = function(){ return this.parseConcat(); };
Parser.prototype.parseConcat = function(){
  let left = this.parseAdd();
  while (this.peek() === '..'){ this.next(); const right = this.parseAdd(); left = { type:'binop', op:'..', left, right }; }
  return left;
};
Parser.prototype.parseAdd = function(){
  let left = this.parseMul();
  while (this.peek() === '+' || this.peek() === '-'){ const op = this.next(); const right = this.parseMul(); left = { type:'binop', op, left, right }; }
  return left;
};
Parser.prototype.parseMul = function(){
  let left = this.parsePrimary();
  while (this.peek() === '*' || this.peek() === '/'){ const op = this.next(); const right = this.parsePrimary(); left = { type:'binop', op, left, right }; }
  return left;
};
Parser.prototype.parsePrimary = function(){
  const p = this.peek(); if (!p) return { type:'nil' };
  if (p === '('){ this.next(); const e = this.parseExpression(); this.eat(')'); return e; }
  if (/^\d/.test(p)){ this.next(); return { type:'number', value: Number(p) }; }
  if ((p[0] === '"' && p[p.length-1] === '"') || (p[0] === "'" && p[p.length-1] === "'")){
    this.next(); const str = p.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r'); return { type:'string', value: str };
  }
  if (/^[A-Za-z_]/.test(p)){ const id = this.next(); if (this.peek() === '('){ this.eat('('); const args = []; while (this.peek() !== ')' && this.peek() !== undefined){ if (this.peek() === ','){ this.next(); continue;} args.push(this.parseExpression()); } this.eat(')'); return { type:'call_expr', callee:id, args }; } else return { type:'ident', name:id }; }
  this.next(); return { type:'nil' };
};

///// Bytecode & builder (supports JMP/JZ for loops)
const OPCODES = {
  PUSHK: 1, GETG: 2, SETG: 3, GETL: 4, SETL: 5,
  CALL: 6, RETURN: 7, ADD: 8, SUB: 9, MUL: 10, DIV: 11,
  CONCAT: 12, JMP: 13, JZ: 14, CLOSE: 255
};

function BytecodeBuilder(){
  this.consts = []; this.names = []; this.code = []; this.localSlots = {}; this.nextLocalSlot = 0;
}
BytecodeBuilder.prototype.addConst = function(v){
  const idx = this.consts.findIndex(x => x === v);
  if (idx !== -1) return idx; this.consts.push(v); return this.consts.length - 1;
};
BytecodeBuilder.prototype.addName = function(n){
  const idx = this.names.indexOf(n); if (idx !== -1) return idx; this.names.push(n); return this.names.length - 1;
};
BytecodeBuilder.prototype.emit = function(){ for (let i=0;i<arguments.length;i++) this.code.push(arguments[i]); };
BytecodeBuilder.prototype.newLocal = function(name){ if (this.localSlots[name] !== undefined) return this.localSlots[name]; const slot = this.nextLocalSlot++; this.localSlots[name] = slot; return slot; };

BytecodeBuilder.prototype.buildFromAst = function(ast){
  if (!ast) return;
  if (ast.type === 'chunk'){ for (const s of ast.body) this.buildFromAst(s); this.emit(OPCODES.CLOSE); return; }
  if (ast.type === 'local_assign'){ const slot = this.newLocal(ast.name); this.buildExpr(ast.expr); this.emit(OPCODES.SETL, slot); return; }
  if (ast.type === 'assign'){ this.buildExpr(ast.expr); const idx = this.addName(ast.name); this.emit(OPCODES.SETG, idx); return; }
  if (ast.type === 'call'){ const idx = this.addName(ast.callee); this.emit(OPCODES.GETG, idx); for (const a of ast.args) this.buildExpr(a); this.emit(OPCODES.CALL, ast.args.length); return; }
  if (ast.type === 'function'){ const child = new BytecodeBuilder(); for (let i=0;i<ast.params.length;i++) child.localSlots[ast.params[i]] = i; child.nextLocalSlot = ast.params.length; for (const s of ast.body) child.buildFromAst(s); child.emit(OPCODES.RETURN, 0); child.emit(OPCODES.CLOSE); const fnObj = { consts: child.consts, names: child.names, code: child.code }; const cidx = this.addConst(fnObj); const nameIdx = this.addName(ast.name); this.emit(OPCODES.PUSHK, cidx); this.emit(OPCODES.SETG, nameIdx); return; }
  if (ast.type === 'return'){ this.buildExpr(ast.expr); this.emit(OPCODES.RETURN, 1); return; }
  if (ast.type === 'while'){
    const startPos = this.code.length;
    this.buildExpr(ast.cond);
    // emit JZ with placeholder target (we'll record and patch)
    this.emit(OPCODES.JZ, 0);
    const jzIndex = this.code.length - 1;
    for (const s of ast.body) this.buildFromAst(s);
    this.emit(OPCODES.JMP, startPos);
    const endPos = this.code.length;
    // patch target (write at jzIndex+1)
    this.code[jzIndex + 1] = endPos;
    return;
  }
  if (ast.type === 'noop') return;
};

BytecodeBuilder.prototype.buildExpr = function(expr){
  if (!expr) { this.emit(OPCODES.PUSHK, this.addConst(null)); return; }
  if (expr.type === 'number'){ const idx = this.addConst(expr.value); this.emit(OPCODES.PUSHK, idx); return; }
  if (expr.type === 'string'){ const idx = this.addConst(expr.value); this.emit(OPCODES.PUSHK, idx); return; }
  if (expr.type === 'ident'){ if (expr.name in this.localSlots){ this.emit(OPCODES.GETL, this.localSlots[expr.name]); return; } else { const nidx = this.addName(expr.name); this.emit(OPCODES.GETG, nidx); return; } }
  if (expr.type === 'call_expr'){ if (expr.callee in this.localSlots) this.emit(OPCODES.GETL, this.localSlots[expr.callee]); else this.emit(OPCODES.GETG, this.addName(expr.callee)); for (const a of expr.args) this.buildExpr(a); this.emit(OPCODES.CALL, expr.args.length); return; }
  if (expr.type === 'binop'){ this.buildExpr(expr.left); this.buildExpr(expr.right); if (expr.op === '+') this.emit(OPCODES.ADD); else if (expr.op === '-') this.emit(OPCODES.SUB); else if (expr.op === '*') this.emit(OPCODES.MUL); else if (expr.op === '/') this.emit(OPCODES.DIV); else if (expr.op === '..') this.emit(OPCODES.CONCAT); else this.emit(OPCODES.ADD); return; }
  this.emit(OPCODES.PUSHK, this.addConst(null));
};

function serializeToLuaTable(builder){
  function litVal(v){
    if (v === null || v === undefined) return 'nil';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string') return '"' + v.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,'\\n') + '"';
    if (typeof v === 'object') {
      if (v.consts && v.names && v.code){
        return '{ consts = {' + v.consts.map(litVal).join(',') + '}, names = {' + v.names.map(s=> '"' + String(s).replace(/"/g,'\\"') + '"' ).join(',') + '}, code = {' + v.code.join(',') + '} }';
      }
      return 'nil';
    }
    return 'nil';
  }
  const constsPart = builder.consts.map(litVal).join(',');
  const namesPart = builder.names.map(s=> '"' + String(s).replace(/"/g,'\\"') + '"' ).join(',');
  const codePart = builder.code.join(',');
  return '{ consts = {' + constsPart + '}, names = {' + namesPart + '}, code = {' + codePart + '} }';
}

// --- FIXED loader builder: uses bit32.bxor if present, otherwise pure-Lua fallback
function buildLuaInterpreterPayload(base64Payload, xorKey){
  // key and payload embedded
  const lua = `
-- VM loader (fixed XOR fallback)
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

-- portable XOR: use bit32.bxor if available, else fallback implementation
local function bxor_fallback(a,b)
  local res = 0
  for i=0,7 do
    local ab = math.floor(a / (2^i)) % 2
    local bb = math.floor(b / (2^i)) % 2
    if ab ~= bb then res = res + 2^i end
  end
  return res
end

local function xor_bytes_str(s, key)
  local have_bit32 = (type(bit32) == 'table' and type(bit32.bxor) == 'function')
  local out = {}
  for i=1,#s do
    local vb = string.byte(s, i)
    local dec
    if have_bit32 then dec = bit32.bxor(vb, key) else dec = bxor_fallback(vb, key) end
    out[#out+1] = string.char(dec)
  end
  return table.concat(out)
end

-- decode payload
local enc = b64dec(payload_b64)
local txt = xor_bytes_str(enc, xor_key)

-- loader: return the table literal produced during obfuscation
local loader = load("return " .. txt)
if not loader then error("vm: failed to load payload") end
local prog = loader()

-- interpreter opcodes mapping (same as builder)
local OP = { PUSHK=1, GETG=2, SETG=3, GETL=4, SETL=5, CALL=6, RETURN=7, ADD=8, SUB=9, MUL=10, DIV=11, CONCAT=12, JMP=13, JZ=14, CLOSE=255 }

local function run(prog)
  local consts = prog.consts or {}
  local names = prog.names or {}
  local code = prog.code or {}
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
        local ok, res = pcall(fn, table.unpack(args))
        if ok then push(res) else push(nil) end
      else push(nil) end
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
    elseif op == OP.JMP then local target = code[ip]; ip = target + 1
    elseif op == OP.JZ then local target = code[ip]; ip = ip + 1; local v = pop(); if not v then ip = target + 1 end
    elseif op == OP.CLOSE then break
    else error("vm: unknown opcode "..tostring(op))
    end
  end
end

run(prog)
`;
  return lua;
}

function obfuscateLua(source, opts = {}){
  const target = opts.targetSizeBytes || DEFAULT_TARGET;
  const key = randint(XOR_KEY_MIN, XOR_KEY_MAX);

  const tokens = tokenize(source);
  const p = new Parser(tokens);
  const ast = p.parseChunk();

  const builder = new BytecodeBuilder();
  builder.buildFromAst(ast);

  const tableLit = serializeToLuaTable(builder);

  const payloadBuf = Buffer.from(tableLit, 'utf8');
  const xored = xorBuffer(payloadBuf, key);
  const b64 = toBase64(xored);

  const luaLoader = buildLuaInterpreterPayload(b64, key);

  let final = '-- OBFUSCATED VM PAYLOAD (fixed)\n' + luaLoader;
  while (Buffer.byteLength(final, 'utf8') < target){
    final += '\n-- ' + randName(8) + ' = "' + crypto.randomBytes(8).toString('hex') + '"\n';
  }
  if (Buffer.byteLength(final, 'utf8') > target) final = final.slice(0, target);
  return final;
}

module.exports = { obfuscateLua };
