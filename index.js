require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const helmet = require('helmet');
const app = express();

app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store tokens temporarily in memory (use Redis in production)
const tokens = new Map(); // token => expiry timestamp

// Generate random token
function makeToken() {
  return crypto.randomBytes(16).toString('hex');
}

// Example: generate new URL manually (for admin use)
app.get('/generate', (req, res) => {
  const token = makeToken();
  const ttl = 60 * 2 * 1000; // 2 minutes
  tokens.set(token, Date.now() + ttl);
  const url = `${req.protocol}://${req.get('host')}/source?token=${token}`;
  res.send(`✅ Token created (valid for 2 min)\n${url}`);
});

// Secure source delivery
app.get('/source', (req, res) => {
  const token = req.query.token;
  const now = Date.now();
  const exp = tokens.get(token);

  if (!exp || now > exp) {
    return res.status(403).send("Invalid or expired token");
  }

  tokens.delete(token); // single-use
  res.setHeader("Content-Type", "text/plain");
  res.send(process.env.SECRET_CODE || "-- no code found --");
});

// Health check
app.get('/', (req, res) => {
  res.send("Secure Lua Server running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on port " + PORT));
