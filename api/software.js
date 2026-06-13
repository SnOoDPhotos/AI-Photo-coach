// api/software.js — software capabilities beheer via Upstash Redis
const fs   = require('fs');
const path = require('path');

const REDIS_KEY = 'software:capabilities';

async function kv(...args) {
  const url   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN  || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('KV niet geconfigureerd');
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  const d = await r.json();
  if (d.error) throw new Error('Redis: ' + d.error);
  return d.result;
}

async function load() {
  try {
    const raw = await kv('GET', REDIS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch(e) {}
  try {
    const filePath = path.join(process.cwd(), 'software-capabilities.json');
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch(e) {
    return [];
  }
}

async function save(data) {
  await kv('SET', REDIS_KEY, JSON.stringify(data));
}

function verifyAdminToken(token) {
  try {
    const secret  = process.env.ADMIN_SECRET || 'snood-secret-2025';
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parts   = decoded.split(':');
    if (parts.length < 3) return false;
    const ts = parseInt(parts[1]);
    if (Date.now() - ts > 24 * 60 * 60 * 1000) return false;
    return parts[0] === process.env.ADMIN_USERNAME && parts.slice(2).join(':') === secret;
  } catch(e) { return false; }
}

function getToken(req) {
  return req.body?.token || (req.headers?.authorization || '').replace('Bearer ', '');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // GET — publiek toegankelijk voor de app
    if (req.method === 'GET') {
      const data = await load();
      return res.status(200).json(data);
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { action } = req.body || {};

    // Lijst ophalen
    if (action === 'list') {
      const data = await load();
      return res.status(200).json({ success: true, software: data });
    }

    // Opslaan (admin only)
    if (action === 'save_all') {
      if (!verifyAdminToken(getToken(req))) return res.status(403).json({ error: 'Geen toegang' });
      const { software } = req.body;
      if (!Array.isArray(software)) return res.status(400).json({ error: 'software array vereist' });
      await save(software);
      return res.status(200).json({ success: true, count: software.length });
    }

    // Initialiseren vanuit JSON bestand
    if (action === 'init_from_file') {
      if (!verifyAdminToken(getToken(req))) return res.status(403).json({ error: 'Geen toegang' });
      try {
        const filePath = path.join(process.cwd(), 'software-capabilities.json');
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        await save(data);
        return res.status(200).json({ success: true, message: `${data.length} software pakketten geladen` });
      } catch(e) {
        return res.status(500).json({ error: 'Kon bestand niet laden: ' + e.message });
      }
    }

    return res.status(400).json({ error: 'Onbekende actie' });

  } catch(err) {
    return res.status(500).json({ error: 'Server fout: ' + err.message });
  }
};
