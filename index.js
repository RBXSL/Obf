require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const helmet = require('helmet');
const app = express();
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// tokens store
const tokens = new Map(); // token => expiry timestamp

function makeToken() {
  return crypto.randomBytes(16).toString('hex');
}

// helper: get script (supports raw or base64)
function getScript() {
  const env = process.env.SECRET_CODE || '';
  // if it looks like base64 (no newlines and only base64 chars) we try decode
  const maybeBase64 = env.replace(/\s+/g, '');
  if (maybeBase64.length > 0 && /^[A-Za-z0-9+/=]+$/.test(maybeBase64) && maybeBase64.length % 4 === 0) {
    try {
      const decoded = Buffer.from(maybeBase64, 'base64').toString('utf8');
      // heuristics: decoded must contain keyword like 'print' or 'function' roughly
      if (decoded.includes('print') || decoded.includes('function') || decoded.includes('return')) {
        return decoded;
      }
    } catch (e) {
      // fallthrough to raw
    }
  }
  return env;
}

// optional debug endpoint (shows presence, not content)
app.get('/debug-env', (req, res) => {
  res.json({ hasSecret: !!process.env.SECRET_CODE, len: (process.env.SECRET_CODE || '').length });
});

// /generate: if API_KEY is set in env, require header Authorization: Bearer <API_KEY>
app.get('/generate', (req, res) => {
  const apiKey = process.env.API_KEY;
  if (apiKey) {
    const auth = (req.get('authorization') || '');
    const provided = auth.split(' ')[1] || req.query.key || '';
    if (provided !== apiKey) return res.status(403).send('Invalid API key');
  }
  const token = makeToken();
  const ttl = 2 * 60 * 1000; // 2 minutes
  tokens.set(token, Date.now() + ttl);
  const url = `${req.protocol}://${req.get('host')}/source?token=${token}`;
  res.send(`✅ Token created (valid for 2 min)\n${url}`);
});

// /source
app.get('/source', (req, res) => {
  const token = req.query.token;
  const now = Date.now();
  const exp = tokens.get(token);
  if (!exp || now > exp) return res.status(403).send('Invalid or expired token');
  tokens.delete(token); // single-use

  const script = getScript();
  if (!script || script.length === 0) {
    return res.status(200).type('text/plain').send('-- no code found --');
  }
  res.setHeader('Content-Type', 'text/plain');
  res.send(script);
});

// health
app.get('/', (req, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Running on port', PORT));
