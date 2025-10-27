// obfuscator.js (fixed VM issues: no top-level return; PUSHK handles nested functions)
// Drop-in replacement for previous POC

const crypto = require('crypto');

const DEFAULT_TARGET = 100 * 1024;
function randint(a,b){ return Math.floor(Math.random()*(b-a+1))+a; }
function randName(len=10){ const chars="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"; let s=""; for(let i=0;i<len;i++) s+=chars[Math.floor(Math.random()*chars.length)]; return s; }
function toByteArray(str){ const arr=[]; for(let i=0;i<str.length;i++) arr.push(str.charCodeAt(i)); return arr; }
function xorArray(arr,key){ return arr.map(x=>x^key); }

// --- (Tokenizer, Parser, Bytecode builder) ---
// For brevity we reuse the POC parser/builder from prior code (same subset).
// I'll include the necessary parts (trimmed) — these are essentially identical to the POC parser+builder.

function tokenize(src){
  const tokens = [];
  const re = /\s*([A-Za-z_][A-Za-z0-9_]*|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\d+\.\d+|\d+|==|~=|<=|>=|\.{2}|.|[\n])\s*/g;
  let m;
  while ((m = re.exec(src)) !== null) tokens.push(m[1]);
  return tokens;
}

function Parser(tokens){ this.toks = tokens; this.i = 0; }
Parser.prototype.peek = function(){ return this.toks[this.i]; };
Parser.prototype.next = function(){ return this.toks[this.i++]; };
Parser.prototype.eat = function(tok){ if (this.peek() === tok){ this.next(); return true; } return false; };

Parser.prototype.parseChunk = function(){
  const stmts = [];
  while (this.i < this.toks.length){
    const p = this.peek();
    if (p === undefined) break;
    stmts.push(this.parseStatement());
  }
  return { type:'chunk', body:stmts };
};

Parser.prototype.parseStatement = function(){
  const p = this.peek();
  if (!p) return { type:'noop' };
  if (p === 'local'){ this.next(); const name=this.next(); if (this.eat('=')){ const expr=this.parseExpression(); return {type:'local_assign', name, expr}; } return {type:'local_decl', name}; }
  if (p === 'function'){ this.next(); const name=this.next(); this.eat('('); const params=[]; while(this.peek()!==')'&&this.peek()!==undefined){ const t=this.next(); if(t===',') continue; params.push(t);} this.eat(')'); const body=[]; while(this.peek()!=='end'&&this.peek()!==undefined) body.push(this.parseStatement()); this.eat('end'); return {type:'function', name, params, body}; }
  if (p === 'return'){ this.next(); const expr=this.parseExpression(); return {type:'return', expr}; }
  if (p === 'while'){ this.next(); const cond=this.parseExpression(); this.eat('do'); const body=[]; while(this.peek()!=='end'&&this.peek()!==undefined) body.push(this.parseStatement()); this.eat('end'); return {type:'while', cond, body}; }
  if (p === 'for'){ this.next(); const name=this.next(); this.eat('='); const init=this.parseExpression(); this.eat(','); const limit=this.parseExpression(); let step={type:'number',value:1}; if (this.peek()===','){ this.next(); step=this.parseExpression(); } this.eat('do'); const body=[]; while(this.peek()!=='end'&&this.peek()!==undefined) body.push(this.parseStatement()); this.eat('end'); return {type:'fornum', name, init, limit, step, body}; }
  if (/^[A-Za-z_]/.test(p)){ const id=this.next(); if (this.peek() === '='){ this.next(); const expr=this.parseExpression(); return {type:'assign', name:id, expr}; } else if (this.peek() === '('){ this.next(); const args=[]; while(this.peek()!==')' && this.peek()!==undefined){ if (this.peek()===','){ this.next(); continue; } args.push(this.parseExpression()); } this.eat(')'); return {type:'call', callee:id, args}; } else return {type:'noop'}; }
  this.next(); return {type:'noop'};
};

Parser.prototype.parseExpression = function(){ return this.parseConcat(); };
Parser.prototype.parseConcat = function(){ let left=this.parseAdd(); while(this.peek()==='..'){ this.next(); const right=this.parseAdd(); left={type:'binop', op:'..', left, right}; } return left; };
Parser.prototype.parseAdd = function(){ let left=this.parseMul(); while(this.peek()==='+'||this.peek()==='-'){ const op=this.next(); const right=this.parseMul(); left={type:'binop', op, left, right}; } return left; };
Parser.prototype.parseMul = function(){ let left=this.parsePrimary(); while(this.peek()==='*'||this.peek()==='/'){ const op=this.next(); const right=this.parsePrimary(); left={type:'binop', op, left, right}; } return left; };
Parser.prototype.parsePrimary = function(){ const p=this.peek(); if(!p) return {type:'nil'}; if (p==='('){ this.next(); const e=this.parseExpression(); this.eat(')'); return e; } if (/^\d/.test(p)){ this.next(); return {type:'number', value:Number(p)}; } if ((p[0]==='"' && p[p.length-1]==='"') || (p[0]==="'" && p[p.length-1]==="'")){ this.next(); const s = p.slice(1,-1).replace(/\\n/g,'\n').replace(/\\r/g,'\r'); return {type:'string', value:s}; } if (/^[A-Za-z_]/.test(p)){ const id=this.next(); if (this.peek()==='('){ this.next(); const args=[]; while(this.peek()!==')' && this.peek()!==undefined){ if (this.peek()===','){ this.next(); continue; } args.push(this.parseExpression()); } this.eat(')'); return {type:'call_expr', callee:id, args}; } return {type:'ident', name:id}; } this.next(); return {type:'nil'}; };

// --- Bytecode base ops (we will use fixed mapping but can permute later)
const BASE_OPS = { PUSHK:1, GETG:2, SETG:3, GETL:4, SETL:5, CALL:6, RETURN:7, ADD:8, SUB:9, MUL:10, DIV:11, CONCAT:12, JMP:13, JZ:14, CLOSE:255 };

function BytecodeBuilder(){
  this.consts=[]; this.names=[]; this.code=[]; this.localSlots={}; this.nextLocal=0;
}
BytecodeBuilder.prototype.addConst=function(v){
  for(let i=0;i<this.consts.length;i++){ const c=this.consts[i]; if (typeof c==='object' && typeof v==='object'){ if (JSON.stringify(c)===JSON.stringify(v)) return i; } else if (c===v) return i; }
  this.consts.push(v); return this.consts.length-1;
};
BytecodeBuilder.prototype.addName=function(n){ const idx=this.names.indexOf(n); if(idx!==-1) return idx; this.names.push(n); return this.names.length-1; };
BytecodeBuilder.prototype.emit=function(){ for(let i=0;i<arguments.length;i++) this.code.push(arguments[i]); };
BytecodeBuilder.prototype.newLocal=function(name){ if(this.localSlots[name]!==undefined) return this.localSlots[name]; const s=this.nextLocal++; this.localSlots[name]=s; return s; };

BytecodeBuilder.prototype.buildFromAst = function(ast){
  if(!ast) return;
  if(ast.type==='chunk'){ for(const s of ast.body) this.buildFromAst(s); this.emit(BASE_OPS.CLOSE); return; }
  if(ast.type==='local_assign'){ const slot=this.newLocal(ast.name); this.buildExpr(ast.expr); this.emit(BASE_OPS.SETL, slot); return; }
  if(ast.type==='assign'){ this.buildExpr(ast.expr); const idx=this.addName(ast.name); this.emit(BASE_OPS.SETG, idx); return; }
  if(ast.type==='call'){ const idx=this.addName(ast.callee); this.emit(BASE_OPS.GETG, idx); for(const a of ast.args) this.buildExpr(a); this.emit(BASE_OPS.CALL, ast.args.length); return; }
  if(ast.type==='function'){ const child=new BytecodeBuilder(); for(let i=0;i<ast.params.length;i++) child.localSlots[ast.params[i]]=i; child.nextLocal=ast.params.length; for(const s of ast.body) child.buildFromAst(s); child.emit(BASE_OPS.RETURN,0); child.emit(BASE_OPS.CLOSE); const fnObj={consts:child.consts, names:child.names, code:child.code}; const cidx=this.addConst(fnObj); const nameIdx=this.addName(ast.name); this.emit(BASE_OPS.PUSHK, cidx); this.emit(BASE_OPS.SETG, nameIdx); return; }
  if(ast.type==='return'){ this.buildExpr(ast.expr); this.emit(BASE_OPS.RETURN,1); return; }
  if(ast.type==='while'){ const startIp=this.code.length; this.buildExpr(ast.cond); this.emit(BASE_OPS.JZ, 0); const jzPos=this.code.length-1; for(const s of ast.body) this.buildFromAst(s); this.emit(BASE_OPS.JMP, startIp); const endIp=this.code.length; this.code[jzPos+1]=endIp; return; }
  if(ast.type==='fornum'){ // fallback: naive expand - still works for simple for loops but not perfectly optimized
    const slot=this.newLocal(ast.name);
    this.buildExpr(ast.init);
    this.emit(BASE_OPS.SETL, slot);
    const startIp=this.code.length;
    // condition check: we'll compute (i - limit) and JZ to exit if beyond - this is a simplified approach
    this.emit(BASE_OPS.GETL, slot);
    this.buildExpr(ast.limit);
    this.emit(BASE_OPS.SUB);
    // if i - limit > 0 then break --> we use JZ on (limit - i) <=0 may be inverted; POC: we won't perfectly handle signed compare - recommending using while instead of for for complex cases
    this.emit(BASE_OPS.JZ, 0);
    const jzPos2=this.code.length-1;
    for(const s of ast.body) this.buildFromAst(s);
    // increment
    this.buildExpr(ast.step);
    this.emit(BASE_OPS.GETL, slot);
    this.emit(BASE_OPS.ADD);
    this.emit(BASE_OPS.SETL, slot);
    this.emit(BASE_OPS.JMP, startIp);
    const endIp2=this.code.length;
    this.code[jzPos2+1]=endIp2;
    return;
  }
  if(ast.type==='noop') return;
};

BytecodeBuilder.prototype.buildExpr = function(expr){
  if(!expr){ this.emit(BASE_OPS.PUSHK, this.addConst(null)); return; }
  if(expr.type==='number'){ const idx=this.addConst(expr.value); this.emit(BASE_OPS.PUSHK, idx); return; }
  if(expr.type==='string'){ const idx=this.addConst(expr.value); this.emit(BASE_OPS.PUSHK, idx); return; }
  if(expr.type==='ident'){ if(expr.name in this.localSlots){ this.emit(BASE_OPS.GETL, this.localSlots[expr.name]); return; } const nidx=this.addName(expr.name); this.emit(BASE_OPS.GETG, nidx); return; }
  if(expr.type==='call_expr'){ if(expr.callee in this.localSlots) this.emit(BASE_OPS.GETL, this.localSlots[expr.callee]); else this.emit(BASE_OPS.GETG, this.addName(expr.callee)); for(const a of expr.args) this.buildExpr(a); this.emit(BASE_OPS.CALL, expr.args.length); return; }
  if(expr.type==='binop'){ this.buildExpr(expr.left); this.buildExpr(expr.right); if(expr.op==='+') this.emit(BASE_OPS.ADD); else if(expr.op==='-') this.emit(BASE_OPS.SUB); else if(expr.op==='*') this.emit(BASE_OPS.MUL); else if(expr.op==='/') this.emit(BASE_OPS.DIV); else if(expr.op==='..') this.emit(BASE_OPS.CONCAT); else this.emit(BASE_OPS.ADD); return; }
  this.emit(BASE_OPS.PUSHK, this.addConst(null));
};

// --- serialize to Lua table (NO top-level return)
function serializeProgram(builder){
  // constants: encode strings as { __type="s", k=K, data={...} }
  const constsLua = builder.consts.map(c=>{
    if (c === null) return 'nil';
    if (typeof c === 'number') return String(c);
    if (typeof c === 'string'){
      const k = randint(1,255);
      const bytes = xorArray(toByteArray(c), k);
      return `{ __type = "s", k = ${k}, data = { ${bytes.join(', ')} } }`;
    }
    if (typeof c === 'object' && c.consts && c.names && c.code){
      // nested function object: recursively serialize nested string consts
      const nestedConsts = c.consts.map(nc=>{
        if (nc === null) return 'nil';
        if (typeof nc === 'number') return String(nc);
        if (typeof nc === 'string'){ const k2 = randint(1,255); const b2 = xorArray(toByteArray(nc), k2); return `{ __type = "s", k = ${k2}, data = { ${b2.join(', ')} } }`; }
        return 'nil';
      }).join(',');
      const nestedNames = c.names.map(s=>`"${String(s).replace(/"/g,'\\"')}"`).join(',');
      const nestedCode = c.code.join(',');
      return `{ consts = { ${nestedConsts} }, names = { ${nestedNames} }, code = { ${nestedCode} } }`;
    }
    return 'nil';
  }).join(',');

  const namesLua = builder.names.map(s=>`"${String(s).replace(/"/g,'\\"')}"`).join(',');
  const codeLua = builder.code.join(',');

  // Build a PROGRAM assignment (no return)
  const programLua = `
-- embedded program table
PROGRAM = {
  consts = { ${constsLua} },
  names = { ${namesLua} },
  code = { ${codeLua} }
}
`;
  return programLua;
}

// --- build final Lua file (interpreter + program)
function buildLuaFile(programLua, targetSize){
  const bxorName = randName(8);
  const runName = randName(8);

  const interpreter = `
${programLua}

local function ${bxorName}(a,b)
  local res = 0
  for i=0,7 do
    local ab = math.floor(a / (2^i)) % 2
    local bb = math.floor(b / (2^i)) % 2
    if ab ~= bb then res = res + 2^i end
  end
  return res
end

local function decodeConst(entry)
  if entry == nil then return nil end
  if type(entry) == 'number' then return entry end
  if type(entry) == 'string' then return entry end
  if type(entry) == 'table' and entry.__type == 's' then
    local out = {}
    for i=1,#entry.data do
      local b = entry.data[i]
      local dec = ${bxorName}(b, entry.k)
      out[#out+1] = string.char(dec)
    end
    return table.concat(out)
  end
  if type(entry) == 'table' and entry.consts then
    -- nested function object; decode its consts into runtime forms, keep names/code
    local nc = {}
    for i=1,#entry.consts do nc[i] = decodeConst(entry.consts[i]) end
    return { consts = nc, names = entry.names, code = entry.code }
  end
  return nil
end

local RAW_CONSTS = PROGRAM.consts or {}
local NAMES = PROGRAM.names or {}
local CODE = PROGRAM.code or {}

-- decode all constants (strings -> plaintext strings; function objects become tables with code)
local CONSTS = {}
for i=1,#RAW_CONSTS do CONSTS[i] = decodeConst(RAW_CONSTS[i]) end

local OPS = {
  PUSHK = ${BASE_OPS.PUSHK},
  GETG  = ${BASE_OPS.GETG},
  SETG  = ${BASE_OPS.SETG},
  GETL  = ${BASE_OPS.GETL},
  SETL  = ${BASE_OPS.SETL},
  CALL  = ${BASE_OPS.CALL},
  RETURN= ${BASE_OPS.RETURN},
  ADD   = ${BASE_OPS.ADD},
  SUB   = ${BASE_OPS.SUB},
  MUL   = ${BASE_OPS.MUL},
  DIV   = ${BASE_OPS.DIV},
  CONCAT= ${BASE_OPS.CONCAT},
  JMP   = ${BASE_OPS.JMP},
  JZ    = ${BASE_OPS.JZ},
  CLOSE = ${BASE_OPS.CLOSE}
}

-- interpreter (recursive runner)
local function ${runName}(prog_consts, prog_names, prog_code)
  local ip = 1
  local stack = {}
  local locals = {}
  local function push(v) stack[#stack+1]=v end
  local function pop() local v = stack[#stack]; stack[#stack]=nil; return v end

  while ip <= #prog_code do
    local op = prog_code[ip]; ip = ip + 1
    if op == OPS.PUSHK then
      local idx = prog_code[ip]; ip = ip + 1
      local val = prog_consts[idx+1]
      -- if val is a nested function object, create a Lua closure that runs it
      if type(val) == 'table' and val.code then
        local child = val
        local function closure(...)
          -- decode child consts into runtime constants
          local child_consts = {}
          for i=1,#child.consts do child_consts[i] = child.consts[i] end
          return ${runName}(child_consts, child.names, child.code)
        end
        push(closure)
      else
        push(val)
      end
    elseif op == OPS.GETG then
      local nidx = prog_code[ip]; ip = ip + 1
      push(_G[prog_names[nidx+1]])
    elseif op == OPS.SETG then
      local nidx = prog_code[ip]; ip = ip + 1
      local v = pop()
      _G[prog_names[nidx+1]] = v
    elseif op == OPS.GETL then
      local slot = prog_code[ip]; ip = ip + 1
      push(locals[slot+1])
    elseif op == OPS.SETL then
      local slot = prog_code[ip]; ip = ip + 1
      locals[slot+1] = pop()
    elseif op == OPS.CALL then
      local nargs = prog_code[ip]; ip = ip + 1
      local args = {}
      for i=1,nargs do args[nargs - i + 1] = pop() end
      local fn = pop()
      if type(fn) == 'function' then
        local ok, res = pcall(fn, table.unpack(args))
        if ok then push(res) else push(nil) end
      else push(nil) end
    elseif op == OPS.RETURN then
      local n = prog_code[ip]; ip = ip + 1
      local out = {}
      for i=1,n do out[n - i + 1] = pop() end
      return table.unpack(out)
    elseif op == OPS.ADD then local b=pop(); local a=pop(); push(a + b)
    elseif op == OPS.SUB then local b=pop(); local a=pop(); push(a - b)
    elseif op == OPS.MUL then local b=pop(); local a=pop(); push(a * b)
    elseif op == OPS.DIV then local b=pop(); local a=pop(); push(a / b)
    elseif op == OPS.CONCAT then local b=pop(); local a=pop(); push(tostring(a)..tostring(b))
    elseif op == OPS.JMP then local target = prog_code[ip]; ip = target + 1
    elseif op == OPS.JZ then local target = prog_code[ip]; ip = ip + 1; local v = pop(); if not v then ip = target + 1 end
    elseif op == OPS.CLOSE then break
    else error("vm: unknown opcode "..tostring(op))
    end
  end
end

-- start execution using CONSTS, NAMES, CODE (CONSTS contains decoded primitives & nested tables)
${runName}(CONSTS, NAMES, CODE)
`;

  let out = interpreter;
  while (Buffer.byteLength(out, 'utf8') < targetSize){
    out += '\n-- ' + randName(8) + ' = "' + crypto.randomBytes(8).toString('hex') + '"';
  }
  if (Buffer.byteLength(out,'utf8') > targetSize) out = out.slice(0, targetSize);
  return out;
}

// --- high-level obfuscate function
function obfuscateLua(source, opts={}){
  const target = opts.targetSizeBytes || DEFAULT_TARGET;
  const tokens = tokenize(source);
  const p = new Parser(tokens);
  const ast = p.parseChunk();
  const builder = new BytecodeBuilder();
  builder.buildFromAst(ast);
  const programLua = serializeProgram(builder);
  const final = buildLuaFile(programLua, target);
  return final;
}

module.exports = { obfuscateLua };
