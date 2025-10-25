# app.py
# Render-ready Flask obfuscator microservice for Lua
#
# Endpoints:
#  - GET  /            -> "OK" health check
#  - POST /obfuscate   -> form-data:
#       - file: uploaded .lua OR 'code' form field with raw code
#       - level: 1|2|3 (optional, default 2) — strength
# Returns: attachment "obfuscated.lua"
#
# To run locally:
#   pip install flask
#   FLASK_ENV=production python app.py
#
# For Render: add a Procfile with: web: python app.py

from flask import Flask, request, send_file, jsonify, abort
import re, base64, random, io, string, time
from typing import Tuple, List

app = Flask(__name__)
random.seed()

# ---------- Config ----------
MAX_INPUT_SIZE = 300_000  # bytes
ALLOWED_LEVELS = {1, 2, 3}

# ---------- Utilities ----------
LUA_KEYWORDS = {
    "and","break","do","else","elseif","end","false","for","function","goto","if",
    "in","local","nil","not","or","repeat","return","then","true","until","while"
}

def gen_ident(n=8):
    chars = string.ascii_letters + string.digits + "_"
    return random.choice(string.ascii_letters + "_") + ''.join(random.choice(chars) for _ in range(n-1))

def xor_encrypt_bytes(b: bytes, key: bytes) -> bytes:
    return bytes([b[i] ^ key[i % len(key)] for i in range(len(b))])

def to_b64s(b: bytes) -> str:
    return base64.b64encode(b).decode('ascii')

def from_b64s(s: str) -> bytes:
    return base64.b64decode(s)

# ---------- String encryption ----------
def encrypt_strings(lua_code: str, key: bytes) -> str:
    # Replace simple quoted literal strings with __decode("<b64>")
    # (does not handle long [[ ... ]] strings)
    def repl(m):
        s = m.group(0)
        quote = s[0]
        inner = s[1:-1]
        if inner == "":
            return s
        enc = xor_encrypt_bytes(inner.encode('utf-8'), key)
        return '__decode("' + to_b64s(enc) + '")'
    pattern = re.compile(r'(?P<q>"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\')', re.DOTALL)
    return pattern.sub(repl, lua_code)

# ---------- Local renaming (conservative) ----------
def rename_locals(lua_code: str) -> str:
    mapping = {}
    for m in re.finditer(r'\blocal\s+function\s+([A-Za-z_][A-Za-z0-9_]*)', lua_code):
        name = m.group(1)
        if name not in mapping and name not in LUA_KEYWORDS:
            mapping[name] = gen_ident(6)
    for m in re.finditer(r'\blocal\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)', lua_code):
        names = m.group(1)
        for n in [x.strip() for x in names.split(",")]:
            if n and n not in LUA_KEYWORDS and n not in mapping:
                mapping[n] = gen_ident(5)
    if mapping:
        items = sorted(mapping.items(), key=lambda x: -len(x[0]))
        for orig, new in items:
            lua_code = re.sub(r"\b" + re.escape(orig) + r"\b", new, lua_code)
    return lua_code

# ---------- Opaque predicate insertion ----------
def insert_opaque_predicates(lua_code: str, count: int = 2) -> str:
    parts = re.split(r'(\n)', lua_code)  # keep newlines
    out = []
    inserted = 0
    for p in parts:
        out.append(p)
        if inserted < count and p == '\n' and random.random() < 0.18:
            a = random.randint(1000,9999)
            b = random.randint(1,9)
            pred = f'if ({a*b}%{b}==0) then local _={a};_=_+{b}-{b} end\n'
            out.append(pred)
            inserted += 1
    return ''.join(out)

# ---------- Virtualization (small VM) ----------
# We'll find simple local functions (short bodies) and convert them to tables:
# __VIRT_<tag> = { consts = {...}, ops = {...} }
# and replace the function with a wrapper calling __run_virt(__VIRT_<tag>, _ENV, __OBF_KEY)

def simple_tokenize_lines(func_body: str) -> List[str]:
    return [ln.strip() for ln in func_body.splitlines() if ln.strip()]

def compile_lines_to_ops(lines: List[str]):
    ops = []
    consts = []
    def const_idx(v):
        if v not in consts:
            consts.append(v)
        return consts.index(v)
    for ln in lines:
        # assignment: a = <expr>
        m = re.match(r'([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)', ln)
        if m:
            lhs, rhs = m.group(1), m.group(2).strip()
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
                    ops.append(('load_var', fname))
                    ops.append(('call', 0))
                    ops.append(('store_var', lhs))
                else:
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
                ops.append(('load_var', rhs))
                ops.append(('store_var', lhs))
            continue
        # return <expr>
        mr = re.match(r'return\s+(.+)', ln)
        if mr:
            expr = mr.group(1).strip()
            me = re.match(r'^"([^"]*)"|^\'([^\']*)\'$', expr)
            mn = re.match(r'^(\d+(\.\d+)?)$', expr)
            if me:
                lit = me.group(1) if me.group(1) is not None else me.group(2)
                ops.append(('push_const', const_idx(('s', lit))))
                ops.append(('ret', 1))
            elif mn:
                ops.append(('push_const', const_idx(('n', float(mn.group(1))))))
                ops.append(('ret', 1))
            else:
                ops.append(('load_var', expr))
                ops.append(('ret', 1))
            continue
        # simple arithmetic assignment: a = b + c  (naive)
        ma = re.match(r'([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z0-9_\"\']+)\s*([\+\-\*/])\s*([A-Za-z0-9_\"\']+)', ln)
        if ma:
            lhs, left, opch, right = ma.group(1), ma.group(2), ma.group(3), ma.group(4)
            for elm in (left, right):
                ai = re.match(r'^"([^"]*)"|^\'([^\']*)\'$', elm)
                an = re.match(r'^(\d+(\.\d+)?)$', elm)
                if ai:
                    lit = ai.group(1) if ai.group(1) is not None else ai.group(2)
                    ops.append(('push_const', const_idx(('s', lit))))
                elif an:
                    ops.append(('push_const', const_idx(('n', float(an.group(1))))))
                else:
                    ops.append(('load_var', elm))
            if opch == '+':
                ops.append(('add',))
            elif opch == '-':
                ops.append(('sub',))
            elif opch == '*':
                ops.append(('mul',))
            elif opch == '/':
                ops.append(('div',))
            ops.append(('store_var', lhs))
            continue
        # function call line
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
            continue
        # unrecognized -> skip
    return ops, consts

def ops_to_lua_table(ops, consts, tag) -> str:
    const_lines = []
    for c in consts:
        if c[0] == 's':
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
        elif op[0] == 'add':
            op_lines.append('{"add"}')
        elif op[0] == 'sub':
            op_lines.append('{"sub"}')
        elif op[0] == 'mul':
            op_lines.append('{"mul"}')
        elif op[0] == 'div':
            op_lines.append('{"div"}')
        elif op[0] == 'ret':
            op_lines.append(f'{{"ret",{op[1]}}}')
        else:
            op_lines.append('{"nop"}')
    lua_tbl = f"__VIRT_{tag} = {{ consts = {{{','.join(const_lines)}}}, ops = {{{','.join(op_lines)}}} }}\n"
    return lua_tbl

LUA_VM_RUNTIME = r'''
-- Obfuscator VM runtime (injected)
local function __b64dec(s)
  local b='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  s=s:gsub('[^'..b..'=]','')
  return (s:gsub('.', function(x)
    if x == '=' then return '' end
    local r = b:find(x)-1
    return string.char(r)
  end))
end
local function __decode(s_b64, key_b64)
  local enc = __b64dec(s_b64)
  if not key_b64 then return enc end
  -- decode key
  local k = (key_b64 and __b64dec(key_b64)) or ""
  local out = {}
  for i=1,#enc do
    local c = string.byte(enc,i)
    local kc = string.byte(k, ((i-1) % #k) + 1) or 0
    out[#out+1] = string.char(bit32 and (c ~ kc) or ((c)))
  end
  return table.concat(out)
end

local function __run_virt(vtab, env, key_b64)
  local consts = {}
  for i,c in ipairs(vtab.consts) do
    if c[1] == "s" then
      consts[i] = __decode(c[2], key_b64)
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
      sp = sp + 1; stack[sp] = env[op[2]]; pc = pc + 1
    elseif t == "sv" then
      local v = stack[sp]; stack[sp] = nil; sp = sp - 1
      env[op[2]] = v; pc = pc + 1
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
    elseif t == "add" then
      local b = stack[sp]; stack[sp] = nil; sp = sp -1
      local a = stack[sp]; stack[sp] = nil; sp = sp -1
      sp = sp + 1; stack[sp] = a + b; pc = pc + 1
    elseif t == "sub" then
      local b = stack[sp]; stack[sp] = nil; sp = sp -1
      local a = stack[sp]; stack[sp] = nil; sp = sp -1
      sp = sp + 1; stack[sp] = a - b; pc = pc + 1
    elseif t == "mul" then
      local b = stack[sp]; stack[sp] = nil; sp = sp -1
      local a = stack[sp]; stack[sp] = nil; sp = sp -1
      sp = sp + 1; stack[sp] = a * b; pc = pc + 1
    elseif t == "div" then
      local b = stack[sp]; stack[sp] = nil; sp = sp -1
      local a = stack[sp]; stack[sp] = nil; sp = sp -1
      sp = sp + 1; stack[sp] = a / b; pc = pc + 1
    elseif t == "ret" then
      local n = op[2]
      if n == 0 then return nil end
      local r = stack[sp]; return r
    else
      pc = pc + 1
    end
  end
end
'''

def virtualize_functions(lua_src: str, key: bytes, max_lines=30):
    pattern = re.compile(r'(local\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\((.*?)\)\s*)([\s\S]*?)\send\b', re.MULTILINE)
    new_src = lua_src
    offset = 0
    for m in list(pattern.finditer(lua_src)):
        full = m.group(0)
        start, end = m.span()
        name = m.group(2)
        args = m.group(3)
        body = m.group(4)
        lines = simple_tokenize_lines(body)
        # Conservative selection: small functions only
        if len(lines) == 0 or len(lines) > max_lines:
            continue
        ops, consts = compile_lines_to_ops(lines)
        if not ops:
            continue
        tag = gen_ident(6)
        vtab_lua = ops_to_lua_table(ops, consts, tag)
        wrapper = f'local function {name}({args.strip()}) return __run_virt(__VIRT_{tag}, _ENV, "{to_b64s(key)}") end\n'
        new_src = new_src[:start+offset] + vtab_lua + wrapper + new_src[end+offset:]
        offset += len(vtab_lua) + len(wrapper) - len(full)
    # Prepend VM runtime and key wrapper
    final = LUA_VM_RUNTIME + "\n" + new_src
    return final

# ---------- High-level pipeline ----------
def obfuscate(source_text: str, level: int = 2) -> str:
    # generate per-request key (variable length depending on level)
    key_len = 8 + (level - 1) * 4  # 8, 12, 16 bytes
    key = bytes([random.randint(1,255) for _ in range(key_len)])
    # 1) encrypt strings
    s1 = encrypt_strings(source_text, key)
    # 2) rename locals
    s2 = rename_locals(s1)
    # 3) insert opaque predicates (level-dependent)
    s3 = insert_opaque_predicates(s2, count=1 + level)
    # 4) virtualize functions (level-dependent aggressiveness)
    s4 = virtualize_functions(s3, key, max_lines=20 + level*10)
    # 5) minor minify (condense spaces)
    s5 = re.sub(r'[ \t]+', ' ', s4)
    s5 = re.sub(r'\n\s+\n', '\n', s5)
    return s5

# ---------- Flask endpoints ----------
@app.route('/', methods=['GET'])
def index():
    return "OK", 200

@app.route('/obfuscate', methods=['POST'])
def do_obfuscate():
    # Accept 'file' upload or 'code' text field
    if 'file' in request.files and request.files['file'].filename != '':
        f = request.files['file']
        data = f.read()
        try:
            src = data.decode('utf-8', errors='ignore')
        except Exception:
            return jsonify({"error": "Failed to decode file as UTF-8"}), 400
    else:
        src = request.form.get('code', '')
    if not src:
        return jsonify({"error": "No Lua code provided (send form field 'code' or upload 'file')"}), 400
    if len(src) > MAX_INPUT_SIZE:
        return jsonify({"error": "Input too large"}), 400
    lvl_raw = request.form.get('level', '2')
    try:
        lvl = int(lvl_raw)
        if lvl not in ALLOWED_LEVELS:
            lvl = 2
    except:
        lvl = 2
    # perform obfuscation
    try:
        start = time.time()
        result = obfuscate(src, level=lvl)
        elapsed = time.time() - start
    except Exception as e:
        return jsonify({"error": "Obfuscation failed", "details": str(e)}), 500
    # return as attachment
    buf = io.BytesIO(result.encode('utf-8'))
    buf.seek(0)
    return send_file(buf,
                     as_attachment=True,
                     download_name='obfuscated.lua',
                     mimetype='text/x-lua')

# ---------- Run ----------
if __name__ == '__main__':
    # NOTE: In production (Render) you may want to use gunicorn. This file can be run as-is for development.
    app.run(host='0.0.0.0', port=5000)
