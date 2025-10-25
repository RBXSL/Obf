# lua_vm_obf.py
# Lightweight Lua obfuscator featuring:
# - string encryption (XOR + base64)
# - local renaming
# - opaque predicates injection
# - function virtualization to a small stack VM
#
# Usage (CLI): python lua_vm_obf.py input.lua > obf.lua
#
# Note: This is a demonstrator. Do not run untrusted code through it without testing.

import re, sys, base64, random, string, argparse

# ---------------- utilities ----------------
random.seed()

LUA_KEYWORDS = {
    "and","break","do","else","elseif","end","false","for","function","goto","if",
    "in","local","nil","not","or","repeat","return","then","true","until","while"
}

def gen_ident(n=6):
    chars = string.ascii_letters + string.digits + "_"
    return random.choice(string.ascii_letters + "_") + ''.join(random.choice(chars) for _ in range(n-1))

def xor_encrypt_bytes(b: bytes, key: bytes):
    return bytes([b[i] ^ key[i % len(key)] for i in range(len(b))])

def to_b64s(b: bytes):
    return base64.b64encode(b).decode('ascii')

# ---------------- string encryption ----------------
def encrypt_strings(lua_code: str, key: bytes):
    # Replace "..." and '...' strings (not long [[ ]]) with __decode("<b64>")
    def repl(m):
        s = m.group(0)
        quote = s[0]
        inner = s[1:-1]
        if inner == "": 
            return s  # leave empty strings
        enc = xor_encrypt_bytes(inner.encode('utf-8'), key)
        return '__decode("' + to_b64s(enc) + '")'
    pattern = re.compile(r'(?P<q>"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\')', re.DOTALL)
    out = pattern.sub(repl, lua_code)
    return out

# ---------------- rename locals (conservative) ----------------
def rename_locals(lua_code: str):
    mapping = {}
    # local function name
    for m in re.finditer(r'\blocal\s+function\s+([A-Za-z_][A-Za-z0-9_]*)', lua_code):
        name = m.group(1)
        if name not in mapping and name not in LUA_KEYWORDS:
            mapping[name] = gen_ident(6)
    # local a, b = ...
    for m in re.finditer(r'\blocal\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)', lua_code):
        names = m.group(1)
        for n in [x.strip() for x in names.split(",")]:
            if n and n not in LUA_KEYWORDS and n not in mapping:
                mapping[n] = gen_ident(5)
    if mapping:
        # replace word boundaries, longest first
        items = sorted(mapping.items(), key=lambda x: -len(x[0]))
        for orig, new in items:
            lua_code = re.sub(r'\b' + re.escape(orig) + r'\b', new, lua_code)
    return lua_code

# ---------------- opaque predicate insertion ----------------
def insert_opaque_predicates(lua_code: str, count=2):
    # Insert simple opaque if blocks in random safe places (after semicolons or newlines)
    parts = re.split(r'(\n)', lua_code)  # keep newlines
    out = []
    inserted = 0
    for i, p in enumerate(parts):
        out.append(p)
        if inserted < count and p == '\n' and random.random() < 0.15:
            # create an arithmetic opaque predicate that is always true (e.g., ((a*a) % 1 == 0))
            a = random.randint(1000,9999)
            b = random.randint(1,9)
            # predicate: ((a*b) % b == 0)
            pred_code = f'if ({a*b}%{b}==0) then local _={a};_=_+{b}- {b} end\n'
            out.append(pred_code)
            inserted += 1
    return ''.join(out)

# ---------------- virtualization: convert function bodies to opcode arrays ----------------
# The VM is tiny and supports:
#   push_const <idx>
#   load_var <name>
#   store_var <name>
#   call <nargs>
#   add, sub, mul, div, concat
#   return <nvalues>
#   jmp <offset>
#   jz <offset>  (pop value, if false/nil -> jump)
#
# We will only virtualize simple function bodies (sequence of simple statements).
# This is intentionally conservative: more patterns can be added.

def simple_tokenize_lines(func_body: str):
    # naive line-splitting; keep it simple for safety
    lines = [ln.strip() for ln in func_body.splitlines() if ln.strip()]
    return lines

def compile_lines_to_ops(lines):
    ops = []
    consts = []
    # map constants to indices
    def const_idx(v):
        if v not in consts:
            consts.append(v)
        return consts.index(v)
    # naive compilation rules
    for ln in lines:
        # assignment: a = b or a = "str" or a = funccall()
        m = re.match(r'([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)', ln)
        if m:
            lhs, rhs = m.group(1), m.group(2).strip()
            # literal string or number
            ms = re.match(r'^"([^"]*)"|^\'([^\']*)\'$', rhs)
            mn = re.match(r'^(\d+(\.\d+)?)$', rhs)
            mcall = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$', rhs)
            if ms:
                lit = ms.group(1) if ms.group(1) is not None else ms.group(2)
                ops.append(('push_const', const_idx(('s', lit))))
                ops.append(('store_var', lhs))
            elif mn:
                ops.append(('push_const', const_idx(('n', float(mn.group(1))))))
                ops.append(('store_var', lhs))
            elif mcall:
                fname = mcall.group(1)
                args = mcall.group(2).strip()
                if args == '':
                    ops.append(('load_var', fname))   # treat call of global function stored in var
                    ops.append(('call', 0))
                    ops.append(('store_var', lhs))
                else:
                    # split args by comma (naive)
                    arg_list = [a.strip() for a in args.split(',')]
                    for a in arg_list:
                        ai = re.match(r'^"([^"]*)"|^\'([^\']*)\'$', a)
                        an = re.match(r'^(\d+(\.\d+)?)$', a)
                        if ai:
                            lit = ai.group(1) if ai.group(1) is not None else ai.group(2)
                            ops.append(('push_const', const_idx(('s', lit))))
                        elif an:
                            ops.append(('push_const', const_idx(('n', float(an.group(1))))))
                        else:
                            ops.append(('load_var', a))
                    ops.append(('load_var', fname))
                    ops.append(('call', len(arg_list)))
                    ops.append(('store_var', lhs))
            else:
                # fallback: treat rhs as var
                ops.append(('load_var', rhs))
                ops.append(('store_var', lhs))
            continue
        # return x
        mr = re.match(r'return\s+(.+)', ln)
        if mr:
            expr = mr.group(1).strip()
            me = re.match(r'^"([^"]*)"|^\'([^\']*)\'$', expr)
            mn = re.match(r'^(\d+(\.\d+)?)$', expr)
            if me:
                lit = me.group(1) if me.group(1) is not None else me.group(2)
                ops.append(('push_const', const_idx(('s', lit))))
                ops.append(('return', 1))
            elif mn:
                ops.append(('push_const', const_idx(('n', float(mn.group(1))))))
                ops.append(('return', 1))
            else:
                ops.append(('load_var', expr))
                ops.append(('return', 1))
            continue
        # other: try call
        mc = re.match(r'([A-Za-z_][A-Za-z0-9_]*)\((.*)\)', ln)
        if mc:
            fname = mc.group(1)
            args = mc.group(2).strip()
            arg_list = [a.strip() for a in args.split(',')] if args else []
            for a in arg_list:
                ai = re.match(r'^"([^"]*)"|^\'([^\']*)\'$', a)
                an = re.match(r'^(\d+(\.\d+)?)$', a)
                if ai:
                    lit = ai.group(1) if ai.group(1) is not None else ai.group(2)
                    ops.append(('push_const', const_idx(('s', lit))))
                elif an:
                    ops.append(('push_const', const_idx(('n', float(an.group(1))))))
                else:
                    ops.append(('load_var', a))
            ops.append(('load_var', fname))
            ops.append(('call', len(arg_list)))
            # discard return
            continue
        # fallback: push as comment (skip)
    return ops, consts

def ops_to_lua_table(ops, consts, fname_tag):
    # produce Lua tables: consts as table of {type, val}, ops as list of small tables
    const_lines = []
    for c in consts:
        if c[0] == 's':
            # encode small strings in b64 to avoid interfering with strings
            const_lines.append(f'{{"s","{to_b64s(c[1].encode("utf-8"))}"}}')
        else:
            const_lines.append(f'{{"n",{c[1]}}}')
    op_lines = []
    for op in ops:
        if op[0] == 'push_const':
            op_lines.append(f'{{"pc",{op[1]}}}')
        elif op[0] == 'load_var':
            op_lines.append(f'{{"lv","{op[1]}"}}')
        elif op[0] == 'store_var':
            op_lines.append(f'{{"sv","{op[1]}"}}')
        elif op[0] == 'call':
            op_lines.append(f'{{"call",{op[1]}}}')
        elif op[0] == 'return':
            op_lines.append(f'{{"ret",{op[1]}}}')
        else:
            # unknown op, encode as nop
            op_lines.append('{"nop"}')
    lua_tbl = f"__VIRT_{fname_tag} = {{consts = {{{','.join(const_lines)}}}, ops = {{{','.join(op_lines)}}}}}\n"
    return lua_tbl

# ---------------- VM interpreter (Lua) ----------------
# This small interpreter will be injected once at top of the obfuscated file.
LUA_VM_RUNTIME = r'''
-- VM runtime injected by obfuscator
local function __b64dec(s)
  local b='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  s=s:gsub('[^'..b..'=]','')
  return (s:gsub('.', function(x)
    if x == '=' then return '' end
    local r = b:find(x)-1
    return string.char(r)
  end))
end
local function __decode(s_b64, key)
  local enc = __b64dec(s_b64)
  if not key then return enc end
  local out = {}
  for i=1,#enc do
    out[i] = string.char(bit32 and (string.byte(enc,i) ~ key:byte((i-1)%#key+1)) or (string.byte(enc,i)))
  end
  return table.concat(out)
end

local function __run_virt(vtab, env, key)
  -- env: table holding variables and functions
  local consts = {}
  for i,c in ipairs(vtab.consts) do
    if c[1] == "s" then
      local raw = __decode(c[2], key)
      consts[i] = raw
    else
      consts[i] = c[2]
    end
  end
  local stack = {}
  local sp = 0
  local pc = 1
  local ops = vtab.ops
  while pc <= #ops do
    local op = ops[pc]
    local t = op[1]
    if t == "pc" then
      sp = sp + 1; stack[sp] = consts[op[2]+1]; pc = pc + 1
    elseif t == "lv" then
      sp = sp + 1; stack[sp] = env[op[2]]
      pc = pc + 1
    elseif t == "sv" then
      local v = stack[sp]; stack[sp] = nil; sp = sp - 1
      env[op[2]] = v
      pc = pc + 1
    elseif t == "call" then
      local nargs = op[2]
      local args = {}
      for i=nargs,1,-1 do
        args[i] = stack[sp - (nargs - i)]; stack[sp - (nargs - i)] = nil
      end
      sp = sp - nargs
      local fn = stack[sp]; stack[sp] = nil; sp = sp -1
      local ok, res = pcall(fn, table.unpack(args))
      if ok then
        sp = sp + 1; stack[sp] = res
      else
        error(res)
      end
      pc = pc + 1
    elseif t == "ret" then
      local nvals = op[2]
      if nvals == 0 then return end
      local r = stack[sp]; return r
    else
      pc = pc + 1
    end
  end
end
'''

# ---------------- top-level transform ----------------

def virtualize_functions(lua_src: str, key: bytes):
    # Find simple functions: local function name(...) ... end
    pattern = re.compile(r'(local\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\((.*?)\)\s*)([\s\S]*?)\send\b', re.MULTILINE)
    new_src = lua_src
    offset = 0
    vtabs = []
    for m in list(pattern.finditer(lua_src)):
        full = m.group(0)
        header = m.group(1)
        name = m.group(2)
        args = m.group(3)
        body = m.group(4)
        # naive check: only virtualize small bodies with simple statements
        lines = simple_tokenize_lines(body)
        if len(lines) == 0 or len(lines) > 25:
            continue
        ops, consts = compile_lines_to_ops(lines)
        if not ops:
            continue
        tag = gen_ident(6)
        vtab_lua = ops_to_lua_table(ops, consts, tag)
        vtabs.append(vtab_lua)
        # replace original function with wrapper that calls vm
        args_list = args.strip()
        wrapper = f'local function {name}({args_list}) return __run_virt(__VIRT_{tag}, _ENV, __OBF_KEY) end'
        # perform replacement in working copy
        start, end = m.span()
        new_src = new_src[:start+offset] + vtab_lua + wrapper + new_src[end+offset:]
        offset += len(vtab_lua) + len(wrapper) - len(full)
    # inject VM runtime and decoding wrapper + key constant at top
    key_b64 = to_b64s(key)
    key_decl = f'local __OBF_KEY = "{key_b64}"\n'
    final = LUA_VM_RUNTIME + key_decl + new_src
    return final

# ---------------- CLI & integration ----------------
def obfuscate_lua_source(source_text: str):
    # generate per-build key
    key = bytes([random.randint(1,255) for _ in range(8)])  # 8 byte XOR key
    # 1) encrypt strings
    s_enc = encrypt_strings(source_text, key)
    # 2) rename locals
    s_ren = rename_locals(s_enc)
    # 3) insert opaque predicates
    s_opp = insert_opaque_predicates(s_ren, count=3)
    # 4) virtualize some functions
    s_virt = virtualize_functions(s_opp, key)
    return s_virt

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Simple Lua obfuscator (VM + strings)')
    parser.add_argument('infile', help='Input lua file')
    args = parser.parse_args()
    with open(args.infile, 'r', encoding='utf-8') as f:
        src = f.read()
    out = obfuscate_lua_source(src)
    print(out)
