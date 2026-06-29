// api/knowledge.js — kennisbank beheer via Upstash Redis
const fs   = require('fs');
const path = require('path');

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

const REDIS_KEY = 'knowledge:db';

// Laad kennisbank: Redis eerst, dan fallback naar JSON bestand
async function loadKnowledge() {
  try {
    const raw = await kv('GET', REDIS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch(e) {
    console.log('Redis niet bereikbaar, fallback naar JSON:', e.message);
  }
  // Fallback: lees knowledge-base.json van schijf
  try {
    const filePath = path.join(process.cwd(), 'knowledge-base.json');
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch(e) {
    return [];
  }
}

// Sla kennisbank op in Redis
async function saveKnowledge(entries) {
  await kv('SET', REDIS_KEY, JSON.stringify(entries));
}

// ── Token verificatie (zelfde logica als auth.js) ─────────────────────────
function verifyAdminToken(token) {
  try {
    const secret  = process.env.ADMIN_SECRET || 'snood-secret-2025';
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parts   = decoded.split(':');
    if (parts.length < 3) return false;
    const username = parts[0];
    const ts       = parseInt(parts[1]);
    const rest     = parts.slice(2).join(':');
    if (rest !== secret) return false;
    if (Date.now() - ts > 7 * 24 * 60 * 60 * 1000) return false;
    return username === process.env.ADMIN_USERNAME;
  } catch(e) { return false; }
}

function getToken(req) {
  return req.body?.token || (req.headers?.authorization || '').replace('Bearer ', '');
}

// ── Handler ───────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {

    // ── GET: kennisbank ophalen (publiek toegankelijk voor de app) ────────
    if (req.method === 'GET') {
      const entries = await loadKnowledge();
      return res.status(200).json(entries);
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { action } = req.body || {};

    // ── LIJST OPHALEN (POST, voor admin GUI) ──────────────────────────────
    if (action === 'list') {
      const token = getToken(req);
      if (!verifyAdminToken(token)) return res.status(403).json({ error: 'Geen toegang' });
      const entries = await loadKnowledge();
      return res.status(200).json({ success: true, entries });
    }

    // ── PUBLIEKE STIJLENLIJST (geen auth nodig, voor expert stijl dropdown) ──
    if (action === 'styles') {
      const entries = await loadKnowledge();
      // Return all fields needed for style selection
      return res.status(200).json(entries);
    }

    // ── ENTRY TOEVOEGEN ───────────────────────────────────────────────────
    if (action === 'add') {
      const token = getToken(req);
      if (!verifyAdminToken(token)) return res.status(403).json({ error: 'Geen toegang' });

      const { entry } = req.body;
      if (!entry || !entry.video_title) return res.status(400).json({ error: 'Ongeldige entry' });

      const entries = await loadKnowledge();
      const exists = entries.find(e => e.video_title === entry.video_title);
      if (exists) return res.status(409).json({ error: 'Entry met deze titel bestaat al' });

      entries.push(entry);
      await saveKnowledge(entries);
      return res.status(200).json({ success: true, count: entries.length });
    }

    // ── ENTRY BIJWERKEN (op index of video_title) ─────────────────────────
    if (action === 'update') {
      const token = getToken(req);
      if (!verifyAdminToken(token)) return res.status(403).json({ error: 'Geen toegang' });

      const { index, fields } = req.body;
      if (typeof index !== 'number' || !fields) return res.status(400).json({ error: 'index en fields vereist' });

      const entries = await loadKnowledge();
      if (index < 0 || index >= entries.length) return res.status(404).json({ error: 'Entry niet gevonden' });

      // Merge alleen de opgegeven velden
      Object.assign(entries[index], fields);
      await saveKnowledge(entries);
      return res.status(200).json({ success: true });
    }

    // ── VOLLEDIGE KENNISBANK OVERSCHRIJVEN ────────────────────────────────
    if (action === 'save_all') {
      const token = getToken(req);
      if (!verifyAdminToken(token)) return res.status(403).json({ error: 'Geen toegang' });

      const { entries } = req.body;
      if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries array vereist' });

      // Haal previews op uit aparte Redis key (nooit overschreven door export)
      let previewMap = {};
      try {
        const previewsRaw = await kv('GET', 'style_previews:map');
        if (previewsRaw) previewMap = JSON.parse(previewsRaw);
      } catch(e) { console.log('Geen aparte previews key, probeer uit entries'); }

      // Fallback: haal ook previews uit bestaande Redis entries
      if (Object.keys(previewMap).length === 0) {
        try {
          const existing = await loadKnowledge();
          existing.forEach(function(e) {
            if (e.style_preview && e.style_preview.length > 10) {
              const key = ((e.youtube_url || '') + '|' + (e.video_title || '')).toLowerCase();
              previewMap[key] = e.style_preview;
            }
          });
        } catch(e) {}
      }

      const merged = entries.map(function(e) {
        if (!e.style_preview || e.style_preview.length < 10) {
          const key = ((e.youtube_url || '') + '|' + (e.video_title || '')).toLowerCase();
          if (previewMap[key]) {
            return Object.assign({}, e, { style_preview: previewMap[key] });
          }
        }
        return e;
      });

      const preserved = merged.filter(e => e.style_preview && e.style_preview.length > 10).length;
      await saveKnowledge(merged);
      return res.status(200).json({ success: true, count: merged.length, previewsPreserved: preserved });
    }

    // ── ENTRY VERWIJDEREN ─────────────────────────────────────────────────
    if (action === 'delete') {
      const token = getToken(req);
      if (!verifyAdminToken(token)) return res.status(403).json({ error: 'Geen toegang' });

      const { index } = req.body;
      if (typeof index !== 'number') return res.status(400).json({ error: 'index vereist' });

      const entries = await loadKnowledge();
      if (index < 0 || index >= entries.length) return res.status(404).json({ error: 'Entry niet gevonden' });

      entries.splice(index, 1);
      await saveKnowledge(entries);
      return res.status(200).json({ success: true, count: entries.length });
    }

    // ── REDIS INITIALISEREN vanuit knowledge-base.json ────────────────────
    if (action === 'init_from_file') {
      const token = getToken(req);
      if (!verifyAdminToken(token)) return res.status(403).json({ error: 'Geen toegang' });

      try {
        const filePath = path.join(process.cwd(), 'knowledge-base.json');
        const data = fs.readFileSync(filePath, 'utf-8');
        const entries = JSON.parse(data);
        await saveKnowledge(entries);
        return res.status(200).json({ success: true, message: `${entries.length} entries geladen uit knowledge-base.json` });
      } catch(e) {
        return res.status(500).json({ error: 'Kon knowledge-base.json niet laden: ' + e.message });
      }
    }

    return res.status(400).json({ error: 'Onbekende actie: ' + action });

  } catch(err) {
    console.error('[knowledge.js]', err.message);
    return res.status(500).json({ error: 'Server fout: ' + err.message });
  }
};
