// Vercel Serverless Function — Subscriptions API for neverpuzo
// Reimplements the same routes/logic as postman/mocks/subscriptions-api/default.js
// Runs at https://neverpuzo.vercel.app/api/*
//
// Users are now persisted in Upstash Redis (key `user:<email>`) instead of an in-memory
// object, so accounts and subscriptions survive serverless cold starts.
// Connection uses KV_REST_API_URL / UPSTASH_REDIS_REST_URL (and matching *_TOKEN) env vars,
// which are auto-injected by the Vercel Upstash (KV) integration.

const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

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

// Load a user object from Redis. @upstash/redis auto-deserializes JSON, but handle
// the string case just in case the stored value comes back as a raw string.
async function loadUser(email) {
  if (!email) return null;
  let result = await redis.get('user:' + email);
  if (!result) return null;
  if (typeof result === 'string') {
    try { result = JSON.parse(result); } catch (e) { return null; }
  }
  return result;
}

async function saveUser(u) {
  await redis.set('user:' + u.email, u);
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
      if (await redis.get('user:' + email)) return send(res, 409, { error: 'User already exists' });
      const user = { name: b.name || '', email, password: b.password || '', plan: null, planExpiry: null, payments: [], createdAt: new Date().toISOString() };
      await redis.set('user:' + email, user);
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
      await redis.set('user:' + email, u);
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

    return send(res, 404, { error: 'Route not defined', method, url });
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    for (const k in CORS) res.setHeader(k, CORS[k]);
    res.end(JSON.stringify({ error: 'Server error', detail: String(err) }));
  }
};
