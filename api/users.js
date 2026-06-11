// api/users.js — gebruikersbeheer via Upstash Redis
const crypto = require('crypto');

// ── Upstash Redis ──────────────────────────────────────────────────────────
async function kv(...args) {
  const url   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN  || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('KV niet geconfigureerd');
  const r = await fetch(url, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(args)
  });
  const d = await r.json();
  if (d.error) throw new Error('Redis: ' + d.error);
  return d.result;
}
const kvSet      = (k, v) => kv('SET', k, JSON.stringify(v));
const kvGet      = async (k) => { const r = await kv('GET', k); return r ? JSON.parse(r) : null; };
const kvDel      = (k)    => kv('DEL', k);
const kvSAdd     = (k, v) => kv('SADD', k, v);
const kvSRem     = (k, v) => kv('SREM', k, v);
const kvSMembers = async (k) => { const r = await kv('SMEMBERS', k); return Array.isArray(r) ? r : []; };

// ── Token helpers ─────────────────────────────────────────────────────────
const SECRET = () => process.env.ADMIN_SECRET || 'snood-secret-2025';

// Verifieer admin-token (aangemaakt door auth.js: "username:ts:secret")
function verifyAdminToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parts   = decoded.split(':');
    if (parts.length < 3) return false;
    const username = parts[0];
    const ts       = parseInt(parts[1]);
    const rest     = parts.slice(2).join(':');
    if (rest !== SECRET()) return false;
    if (Date.now() - ts > 24 * 60 * 60 * 1000) return false;
    return username === process.env.ADMIN_USERNAME;
  } catch (e) { return false; }
}

// Genereer user-token: "email:ts:role:hmac"
function generateToken(email, role) {
  const ts  = Date.now();
  const sig = crypto.createHmac('sha256', SECRET()).update(`${email}:${ts}:${role}`).digest('hex');
  return Buffer.from(`${email}:${ts}:${role}:${sig}`).toString('base64');
}

// Verifieer user-token
function verifyUserToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parts   = decoded.split(':');
    if (parts.length < 4) return null;
    const sig   = parts[parts.length - 1];
    const role  = parts[parts.length - 2];
    const ts    = parts[parts.length - 3];
    const email = parts.slice(0, parts.length - 3).join(':');
    const expected = crypto.createHmac('sha256', SECRET()).update(`${email}:${ts}:${role}`).digest('hex');
    if (sig !== expected) return null;
    if (Date.now() - parseInt(ts) > 30 * 24 * 60 * 60 * 1000) return null;
    return { email, role };
  } catch (e) { return null; }
}

// Haal token op en bepaal wie het is
function getCallerInfo(req) {
  const token = req.body?.token || (req.headers?.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  // Probeer eerst admin-token
  if (verifyAdminToken(token)) return { role: 'admin', email: process.env.ADMIN_USERNAME, isAdmin: true };
  // Dan user-token
  const u = verifyUserToken(token);
  if (u) return { ...u, isAdmin: u.role === 'admin' };
  return null;
}

function hashPassword(password) {
  return crypto.createHmac('sha256', SECRET()).update(password).digest('hex');
}

// ── Handler ───────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body || {};

  try {

    // ── REGISTRATIE ─────────────────────────────────────────────────────
    if (action === 'register') {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Email en wachtwoord vereist' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Ongeldig e-mailadres' });
      if (password.length < 8) return res.status(400).json({ error: 'Wachtwoord minimaal 8 tekens' });

      const existing = await kvGet(`user:${email.toLowerCase()}`);
      if (existing) return res.status(409).json({ error: 'Dit e-mailadres is al geregistreerd' });

      const user = {
        email: email.toLowerCase(), passwordHash: hashPassword(password),
        role: 'user', status: 'pending',
        sessionsUsed: 0,       // aantal voltooide foto-sessies
        uploadsUsed: 0,        // totaal aantal uploads (alle fasen)
        freeSessionsTotal: 1,  // max gratis sessies
        maxSessions: null,     // null = onbeperkt (voor betaald), getal = max
        createdAt: new Date().toISOString()
      };
      await kvSet(`user:${email.toLowerCase()}`, user);
      await kvSAdd('users:all',     email.toLowerCase());
      await kvSAdd('users:pending', email.toLowerCase());

      return res.status(200).json({ success: true, message: 'Registratie ontvangen. Je ontvangt bericht zodra je account is goedgekeurd.' });
    }

    // ── INLOGGEN ────────────────────────────────────────────────────────
    if (action === 'login') {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Email en wachtwoord vereist' });

      const user = await kvGet(`user:${email.toLowerCase()}`);
      if (!user || user.passwordHash !== hashPassword(password))
        return res.status(401).json({ error: 'Onjuist e-mailadres of wachtwoord' });
      if (user.status === 'pending')
        return res.status(403).json({ error: 'Je account wacht nog op goedkeuring door de beheerder.' });
      if (user.status === 'blocked')
        return res.status(403).json({ error: 'Je account is geblokkeerd. Neem contact op.' });

      return res.status(200).json({
        success: true, token: generateToken(user.email, user.role),
        email: user.email, role: user.role,
        sessionsUsed: user.sessionsUsed, freeSessionsTotal: user.freeSessionsTotal || 1
      });
    }

    // ── TOKEN VALIDEREN ────────────────────────────────────────────────
    if (action === 'validate') {
      const caller = getCallerInfo(req);
      if (!caller) return res.status(401).json({ valid: false, error: 'Token ongeldig of verlopen' });
      // Admin-token via auth.js heeft geen Redis user record nodig
      if (caller.isAdmin && !caller.email?.includes('@')) {
        return res.status(200).json({ valid: true, email: caller.email, role: 'admin' });
      }
      const user = await kvGet(`user:${caller.email}`);
      if (!user || user.status !== 'approved')
        return res.status(401).json({ valid: false, error: 'Account niet actief' });
      return res.status(200).json({ valid: true, email: user.email, role: user.role,
        sessionsUsed: user.sessionsUsed, freeSessionsTotal: user.freeSessionsTotal || 1 });
    }

    // ── SESSIE REGISTREREN ─────────────────────────────────────────────
    if (action === 'session_start') {
      const caller = getCallerInfo(req);
      if (!caller) return res.status(401).json({ error: 'Niet ingelogd' });
      if (caller.isAdmin) return res.status(200).json({ success: true, allowed: true });

      const user = await kvGet(`user:${caller.email}`);
      if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
      if (user.sessionsUsed >= (user.freeSessionsTotal || 1))
        return res.status(403).json({ error: 'Geen sessies meer beschikbaar.', needsUpgrade: true });

      user.sessionsUsed = (user.sessionsUsed || 0) + 1;
      await kvSet(`user:${caller.email}`, user);
      return res.status(200).json({ success: true, allowed: true,
        sessionsRemaining: (user.freeSessionsTotal || 1) - user.sessionsUsed });
    }

    // ── ADMIN: GEBRUIKERS OPHALEN ──────────────────────────────────────
    if (action === 'admin_list') {
      const caller = getCallerInfo(req);
      if (!caller || !caller.isAdmin) return res.status(403).json({ error: 'Geen toegang' });

      const emails = await kvSMembers('users:all');
      const users  = await Promise.all(emails.map(e => kvGet(`user:${e}`)));
      const clean  = users.filter(Boolean)
        .map(u => ({
          email:             u.email,
          role:              u.role,
          status:            u.status,
          sessionsUsed:      u.sessionsUsed      || 0,
          uploadsUsed:       u.uploadsUsed       || 0,
          freeSessionsTotal: u.freeSessionsTotal || 1,
          maxSessions:       u.maxSessions       ?? null,
          createdAt:         u.createdAt
        }))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      return res.status(200).json({ success: true, users: clean });
    }

    // ── ADMIN: GEBRUIKER BIJWERKEN ────────────────────────────────────
    if (action === 'admin_update') {
      const caller = getCallerInfo(req);
      if (!caller || !caller.isAdmin) return res.status(403).json({ error: 'Geen toegang' });

      const { targetEmail, newStatus, newRole } = req.body;
      const user = await kvGet(`user:${targetEmail.toLowerCase()}`);
      if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });

      if (newStatus) {
        user.status = newStatus;
        if (newStatus === 'approved') {
          await kvSRem('users:pending',  targetEmail.toLowerCase());
          await kvSAdd('users:approved', targetEmail.toLowerCase());
        } else if (newStatus === 'blocked') {
          await kvSRem('users:approved', targetEmail.toLowerCase());
          await kvSRem('users:pending',  targetEmail.toLowerCase());
        }
      }
      if (newRole) user.role = newRole;
      if (req.body.maxSessions !== undefined) user.maxSessions = req.body.maxSessions;
      if (req.body.freeSessionsTotal !== undefined) user.freeSessionsTotal = req.body.freeSessionsTotal;
      if (req.body.resetSessions) { user.sessionsUsed = 0; user.uploadsUsed = 0; }
      await kvSet(`user:${targetEmail.toLowerCase()}`, user);
      return res.status(200).json({ success: true });
    }

    // ── ADMIN: GEBRUIKER VERWIJDEREN ──────────────────────────────────
    if (action === 'admin_delete') {
      const caller = getCallerInfo(req);
      if (!caller || !caller.isAdmin) return res.status(403).json({ error: 'Geen toegang' });

      const { targetEmail } = req.body;
      await kvDel(`user:${targetEmail.toLowerCase()}`);
      await kvSRem('users:all',      targetEmail.toLowerCase());
      await kvSRem('users:pending',  targetEmail.toLowerCase());
      await kvSRem('users:approved', targetEmail.toLowerCase());
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Onbekende actie: ' + action });

  } catch (err) {
    console.error('[users.js]', err.message);
    return res.status(500).json({ error: 'Server fout: ' + err.message });
  }
};
