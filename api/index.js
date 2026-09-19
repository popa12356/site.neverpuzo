// Vercel Serverless Function — Subscriptions API for neverpuzo
// Reimplements the same routes/logic as postman/mocks/subscriptions-api/default.js
// Runs at https://neverpuzo.vercel.app/api/*
//
// Users are now persisted in Redis (key `user:<email>`) instead of an in-memory
// object, so accounts and subscriptions survive serverless cold starts.
// Connection uses the REDIS_URL env var (a single TCP connection string, format
// rediss://...) via the ioredis client.
//
// Activation keys: each key is stored at `key:<code>` with an index set
// `keys:index`. Admin endpoints (/admin/keys, /admin/users) are protected by the
// ADMIN_SECRET env var (sent via the x-admin-secret header). A `users:index` set
// tracks all registered emails so admins can list users.

const Redis = require('ioredis');
const crypto = require('crypto');
// Reuse a single connection across warm invocations (Vercel best practice)
const redis = global.__redis || (global.__redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
  tls: (process.env.REDIS_URL || '').startsWith('rediss://') ? {} : undefined
}));

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  for (const k in CORS) res.setHeader(k, CORS[k]);
  res.end(JSON.stringify(obj));
}

function emailFromAuth(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+mock-jwt-(.+)$/);
  return m ? m[1] : null;
}

// On Vercel req.body may already be parsed (object). Otherwise read the raw stream.
// Promisified version of the old readBody callback helper.
function getBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') { resolve(req.body); return; }
    if (typeof req.body === 'string') {
      try { resolve(req.body ? JSON.parse(req.body) : {}); } catch (e) { resolve({}); }
      return;
    }
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// Load a user object from Redis. ioredis stores plain strings, so parse the JSON.
async function loadUser(email) {
  if (!email) return null;
  const raw = await redis.get('user:' + email);
  return raw ? JSON.parse(raw) : null;
}

async function saveUser(u) {
  await redis.set('user:' + u.email, JSON.stringify(u));
}

// Returns true if the plan was expired and cleared (so caller can persist the change).
function checkExpiry(u) {
  if (u.planExpiry && u.planExpiry !== 'forever' && u.planExpiry < Date.now()) {
    u.plan = null; u.planExpiry = null;
    return true;
  }
  return false;
}

function publicUser(u) {
  return { name: u.name, email: u.email, plan: u.plan, planExpiry: u.planExpiry, payments: u.payments, createdAt: u.createdAt };
}

// On Vercel req.url may or may not include the `/api` prefix depending on routing.
// Normalize by matching the path suffix (ignore query string).
function pathEndsWith(url, suffix) {
  const path = (url || '').split('?')[0].replace(/\/+$/, '');
  return path === suffix || path.endsWith(suffix);
}

// ─── Activation keys ────────────────────────────────────────────────────────
const PLAN_TYPES = {
  '7':   { label: 'Ключ 7 дней',      days: 7 },
  '30':  { label: 'Ключ 30 дней',     days: 30 },
  'forever': { label: 'Ключ навсегда', days: -1 }
};

// Admin auth: compare the x-admin-secret header against the ADMIN_SECRET env var.
function isAdmin(req) {
  const s = req.headers['x-admin-secret'] || '';
  return process.env.ADMIN_SECRET && s === process.env.ADMIN_SECRET;
}

// Generate a key code like PUZO-XXXX-XXXX-XXXX (hex, uppercase).
function genKeyCode() {
  const seg = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return 'PUZO-' + seg() + '-' + seg() + '-' + seg();
}

async function saveKey(k) {
  await redis.set('key:' + k.code, JSON.stringify(k));
  await redis.sadd('keys:index', k.code);
}

async function loadKey(code) {
  const raw = await redis.get('key:' + code);
  return raw ? JSON.parse(raw) : null;
}

async function listKeys() {
  const codes = await redis.smembers('keys:index');
  const out = [];
  for (const c of codes) {
    const raw = await redis.get('key:' + c);
    if (raw) out.push(JSON.parse(raw));
  }
  out.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return out;
}

async function listUsers() {
  const emails = await redis.smembers('users:index');
  const out = [];
  for (const e of emails) {
    const u = await loadUser(e);
    if (u) out.push(Object.assign(publicUser(u), { createdAt: u.createdAt }));
  }
  return out;
}

module.exports = async (req, res) => {
  try {
    const { method, url } = req;

    // CORS preflight
    if (method === 'OPTIONS') {
      res.statusCode = 204;
      for (const k in CORS) res.setHeader(k, CORS[k]);
      res.end();
      return;
    }

    // POST /api/register
    if (method === 'POST' && pathEndsWith(url, '/register')) {
      const b = await getBody(req);
      const email = (b.email || '').toLowerCase();
      if (!email) return send(res, 400, { error: 'Email required' });
      if (await loadUser(email)) return send(res, 409, { error: 'User already exists' });
      const user = { name: b.name || '', email, password: b.password || '', plan: null, planExpiry: null, payments: [], createdAt: new Date().toISOString() };
      await saveUser(user);
      await redis.sadd('users:index', email);
      return send(res, 201, { token: 'mock-jwt-' + email, user: publicUser(user) });
    }

    // POST /api/login
    if (method === 'POST' && pathEndsWith(url, '/login')) {
      const b = await getBody(req);
      const email = (b.email || '').toLowerCase();
      const u = await loadUser(email);
      if (!u || u.password !== (b.password || '')) return send(res, 401, { error: 'Invalid credentials' });
      if (checkExpiry(u)) await saveUser(u);
      return send(res, 200, { token: 'mock-jwt-' + email, user: publicUser(u) });
    }

    // GET /api/subscription/status
    if (method === 'GET' && pathEndsWith(url, '/subscription/status')) {
      const email = emailFromAuth(req);
      const u = await loadUser(email);
      if (!u) return send(res, 401, { error: 'Unauthorized' });
      if (checkExpiry(u)) await saveUser(u);
      let active = false, daysLeft = 0;
      if (u.planExpiry === 'forever') { active = true; }
      else if (u.planExpiry && u.planExpiry > Date.now()) { active = true; daysLeft = Math.ceil((u.planExpiry - Date.now()) / 86400000); }
      return send(res, 200, { email: u.email, plan: u.plan, planExpiry: u.planExpiry, active, daysLeft });
    }

    // GET /api/user/me
    if (method === 'GET' && pathEndsWith(url, '/user/me')) {
      const email = emailFromAuth(req);
      const u = await loadUser(email);
      if (!u) return send(res, 401, { error: 'Unauthorized' });
      if (checkExpiry(u)) await saveUser(u);
      return send(res, 200, publicUser(u));
    }

    // POST /api/subscription/activate
    if (method === 'POST' && pathEndsWith(url, '/subscription/activate')) {
      const email = emailFromAuth(req);
      const u = await loadUser(email);
      if (!u) return send(res, 401, { error: 'Unauthorized' });
      const b = await getBody(req);
      const planLabel = b.planLabel || '';
      const days = b.days;
      let expiry = null;
      if (days && days > 0) {
        const base = (typeof u.planExpiry === 'number' && u.planExpiry > Date.now()) ? u.planExpiry : Date.now();
        expiry = base + days * 86400000;
      } else if (days === -1) { expiry = 'forever'; }
      u.plan = planLabel; u.planExpiry = expiry;
      u.payments = u.payments || [];
      const am = planLabel.match(/(\d+\s*₽)/);
      u.payments.unshift({ title: planLabel, amount: am ? am[1] : '', date: new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) });
      await saveUser(u);
      return send(res, 200, { plan: u.plan, planExpiry: u.planExpiry, payments: u.payments });
    }

    // POST /api/change-password
    if (method === 'POST' && pathEndsWith(url, '/change-password')) {
      const email = emailFromAuth(req);
      const u = await loadUser(email);
      if (!u) return send(res, 401, { error: 'Unauthorized' });
      const b = await getBody(req);
      if (u.password !== (b.oldPassword || '')) return send(res, 400, { error: 'Wrong current password' });
      u.password = b.newPassword || u.password;
      await saveUser(u);
      return send(res, 200, { ok: true });
    }

    // GET /api/sync/modules — синхронизация модулей/функций лоадера. Доступно только с активной подпиской.
    if (method === 'GET' && pathEndsWith(url, '/sync/modules')) {
      const email = emailFromAuth(req);
      const u = await loadUser(email);
      if (!u) return send(res, 401, { error: 'Unauthorized' });
      if (checkExpiry(u)) await saveUser(u);
      const active = u.planExpiry === 'forever' || (typeof u.planExpiry === 'number' && u.planExpiry > Date.now());
      if (!active) return send(res, 403, { error: 'No active subscription' });
      return send(res, 200, {
        version: '1.4.0',
        updatedAt: new Date().toISOString(),
        modules: [
          { id: 'esp',        name: 'ESP',          version: '1.2.0', enabled: true,  file: 'modules/esp.lua',        sha256: 'a1b2c3' },
          { id: 'tracers',    name: 'Tracers',      version: '1.0.3', enabled: true,  file: 'modules/tracers.lua',    sha256: 'd4e5f6' },
          { id: 'nametags',   name: 'NameTags',     version: '1.1.0', enabled: true,  file: 'modules/nametags.lua',   sha256: '7a8b9c' },
          { id: 'hud',        name: 'HUD',          version: '2.0.1', enabled: true,  file: 'modules/hud.lua',        sha256: 'c0ffee' },
          { id: 'fullbright', name: 'FullBright',   version: '1.0.0', enabled: false, file: 'modules/fullbright.lua', sha256: 'beadED' }
        ]
      });
    }

    // POST /api/redeem — USER redeems an activation key
    if (method === 'POST' && pathEndsWith(url, '/redeem')) {
      const email = emailFromAuth(req);
      const u = await loadUser(email);
      if (!u) return send(res, 401, { error: 'Unauthorized' });
      const b = await getBody(req);
      const code = (b.code || '').trim().toUpperCase();
      if (!code) return send(res, 400, { error: 'Key required' });
      const k = await loadKey(code);
      if (!k) return send(res, 404, { error: 'Invalid key' });
      if (k.usedBy) return send(res, 409, { error: 'Key already used' });
      const days = k.days;
      let expiry = null;
      if (days && days > 0) {
        const base = (typeof u.planExpiry === 'number' && u.planExpiry > Date.now()) ? u.planExpiry : Date.now();
        expiry = base + days * 86400000;
      } else if (days === -1) { expiry = 'forever'; }
      u.plan = k.label; u.planExpiry = expiry;
      u.payments = u.payments || [];
      u.payments.unshift({ title: k.label + ' (по ключу)', amount: '', date: new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) });
      k.usedBy = email; k.usedAt = new Date().toISOString();
      await saveKey(k);
      await saveUser(u);
      return send(res, 200, { plan: u.plan, planExpiry: u.planExpiry });
    }

    // POST /api/admin/keys — ADMIN creates keys
    if (method === 'POST' && pathEndsWith(url, '/admin/keys')) {
      if (!isAdmin(req)) return send(res, 403, { error: 'Forbidden' });
      const b = await getBody(req);
      const type = String(b.type || '30');
      const count = Math.min(Math.max(parseInt(b.count || 1, 10), 1), 50);
      const def = PLAN_TYPES[type];
      if (!def) return send(res, 400, { error: 'Unknown key type' });
      const created = [];
      for (let i = 0; i < count; i++) {
        const k = { code: genKeyCode(), type, label: def.label, days: def.days, createdAt: new Date().toISOString(), usedBy: null, usedAt: null };
        await saveKey(k);
        created.push(k);
      }
      return send(res, 201, { created });
    }

    // GET /api/admin/keys — ADMIN lists all keys
    if (method === 'GET' && pathEndsWith(url, '/admin/keys')) {
      if (!isAdmin(req)) return send(res, 403, { error: 'Forbidden' });
      return send(res, 200, { keys: await listKeys() });
    }

    // GET /api/admin/users — ADMIN lists all users
    if (method === 'GET' && pathEndsWith(url, '/admin/users')) {
      if (!isAdmin(req)) return send(res, 403, { error: 'Forbidden' });
      return send(res, 200, { users: await listUsers() });
    }

    return send(res, 404, { error: 'Route not defined', method, url });
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    for (const k in CORS) res.setHeader(k, CORS[k]);
    res.end(JSON.stringify({ error: 'Server error', detail: String(err) }));
  }
};
