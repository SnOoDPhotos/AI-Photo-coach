// api/style-preview.js — batch genereer style previews via Gemini

// ── Token verificatie (zelfde als auth.js) ─────────────────────────────────
function verifyAdminToken(token) {
  try {
    const secret = process.env.ADMIN_SECRET || 'snood-secret-2025';
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const [username, ts, ...rest] = decoded.split(':');
    if (rest.join(':') !== secret) return false;
    if (Date.now() - parseInt(ts) > 7 * 24 * 60 * 60 * 1000) return false;
    return username === process.env.ADMIN_USERNAME;
  } catch(e) { return false; }
}

// ── Upstash Redis ──────────────────────────────────────────────────────────
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

const REDIS_KEY = 'knowledge:db';

async function loadKnowledge() {
  try {
    const raw = await kv('GET', REDIS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch(e) { console.log('Redis fallback:', e.message); }
  return [];
}

async function saveKnowledge(entries) {
  await kv('SET', REDIS_KEY, JSON.stringify(entries));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { action, token, entries } = req.body || {};

    if (!verifyAdminToken(token)) {
      return res.status(401).json({ error: 'Geen toegang' });
    }

    if (action !== 'generate_previews') {
      return res.status(400).json({ error: 'Onbekende actie' });
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) return res.status(500).json({ error: 'Gemini API key niet geconfigureerd' });

    const toProcess = (entries || []).filter(e => !e.style_preview || e.style_preview.length < 10);
    if (!toProcess.length) {
      return res.status(200).json({ success: true, generated: 0, skipped: 0, message: 'Alle entries hebben al een preview' });
    }

    // Deduplicate by photographer+style
    const seen = new Set();
    const unique = toProcess.filter(function(e) {
      const key = ((e.photographer_name||'') + '|' + (e.style_description||'')).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    let generated = 0;
    const errors = [];

    // Process in parallel batches of 10
    const PARALLEL = 10;
    for (let i = 0; i < unique.length; i += PARALLEL) {
      const batch = unique.slice(i, i + PARALLEL);
      await Promise.all(batch.map(async function(entry) {
        const prompt = 'Schrijf een stijlomschrijving van 3 tot 5 zinnen voor de bewerkingsstijl van fotograaf ' + (entry.photographer_name||'') + ' (stijlnaam: "' + (entry.style_description||'') + '"). Gebruik deze informatie: Filosofie: ' + (entry.philosophy||'').slice(0,250) + '. Beste voor: ' + (entry.best_for||'') + '. Genre: ' + (entry.genre||[]).join(', ') + '. Beschrijf: (1) de visuele sfeer en toon, (2) de kernfilosofie in gewone taal, (3) voor welk type foto en lichtomstandigheden deze stijl het beste werkt, (4) het verwachte visuele effect. Schrijf als lopende tekst, geen opsomming, vanuit het perspectief van een fotograaf die overweegt deze stijl te gebruiken.';

        try {
          const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_API_KEY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: 800, temperature: 0.4 }
            })
          });
          const data = await r.json();
          if (data.error) { errors.push((entry.photographer_name||'?') + ': ' + data.error.message); return; }
          const text = (data.candidates||[]).map(c => ((c.content||{}).parts||[])).flat().map(p => p.text||'').join('').trim();
          if (!text || text.length < 20) { errors.push((entry.photographer_name||'?') + ': lege response'); return; }

          // Update all matching entries in KB
          const kb = await loadKnowledge();
          const pg = (entry.photographer_name||'').toLowerCase();
          const sg = (entry.style_description||'').toLowerCase();
          let updated = false;
          kb.forEach(function(e) {
            if ((e.photographer_name||'').toLowerCase() === pg && (e.style_description||'').toLowerCase() === sg) {
              e.style_preview = text;
              updated = true;
            }
          });
          if (updated) {
            await saveKnowledge(kb);
            // Sla ook op in aparte previews map (overleeft export naar database)
            try {
              const previewsRaw = await kv('GET', 'style_previews:map');
              const previewMap = previewsRaw ? JSON.parse(previewsRaw) : {};
              const pk = ((entry.photographer_name||'') + '|' + (entry.style_description||'')).toLowerCase();
              previewMap[pk] = text;
              // Sla ook op per entry keys voor snelle lookup
              kb.forEach(function(e) {
                if ((e.photographer_name||'').toLowerCase() === pg && (e.style_description||'').toLowerCase() === sg) {
                  const ek = ((e.youtube_url||'') + '|' + (e.video_title||'')).toLowerCase();
                  previewMap[ek] = text;
                }
              });
              await kv('SET', 'style_previews:map', JSON.stringify(previewMap));
            } catch(e2) { console.log('Preview map save error:', e2.message); }
            generated++;
          }
        } catch(e) {
          errors.push((entry.photographer_name||'?') + ': ' + e.message);
        }
      }));
    }

    return res.status(200).json({ success: true, generated, skipped: toProcess.length - unique.length, errors: errors.slice(0,5) });

  } catch(e) {
    console.error('style-preview error:', e);
    return res.status(500).json({ error: e.message });
  }
};
