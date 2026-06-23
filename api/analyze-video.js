// api/analyze-video.js — Automatische kennisbank uitbreiding via Gemini videoanalyse
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
  try {
    const filePath = path.join(process.cwd(), 'knowledge-base.json');
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch(e) {
    return [];
  }
}

async function saveKnowledge(entries) {
  await kv('SET', REDIS_KEY, JSON.stringify(entries));
}

// ── Token verificatie ───────────────────────────────────────────────────────
function getToken(req) {
  return req.body?.token || (req.headers?.authorization || '').replace('Bearer ', '');
}
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

// ── Vaste lijsten voor consistentie ─────────────────────────────────────────
const ALLOWED_GENRES = [
  'landschap','portret','straatfotografie','wildlife','infraroodfotografie',
  'architectuur','reisfotografie','nacht & astro','macro','trouwfotografie',
  'documentaire','fine-art','luchtfotografie','kust','sport','experimenteel',
  'product','zwart-wit','cinematisch','grafisch ontwerp','algemeen'
];

const ALLOWED_SOFTWARE = [
  'Lightroom Classic','Lightroom Mobile','Photoshop','Camera Raw (Photoshop)',
  'Capture One','DxO PhotoLab','Luminar Neo','darktable','RawTherapee',
  'Snapseed','VSCO','GIMP','Affinity Photo','ON1 Photo RAW','Nik Collection',
  'Topaz Photo AI','DNG Profile Editor'
];

const GEMINI_PROMPT = `Analyseer deze YouTube video over fotobewerking en geef een JSON entry terug.

WAT IS EEN TECHNIEK?
Een techniek is een concrete, herhaalbare bewerkingsstap met een specifiek doel: name, description (WAT + WAAROM + richting/waarde indien mogelijk), when_to_use, tools (exacte naam), effect (visueel resultaat).

WAT IS EEN UNIQUE INSIGHT?
Een unique insight is GEEN techniek — het is een verrassende observatie of onverwachte aanpak, uniek voor deze video. Geen herhaling van technieken.

VERPLICHTE GENRE LIJST — gebruik ALLEEN: ${ALLOWED_GENRES.join(', ')}
Gebruik nooit Engelse termen of varianten.

VERPLICHTE SOFTWARE LIJST — gebruik ALLEEN: ${ALLOWED_SOFTWARE.join(', ')}
Als software niet genoemd wordt: laat leeg ([]).

LICHTOMSTANDIGHEDEN — bij voorkeur: gouden uur, blauwe uur, bewolkt, harde zon, tegenlicht, diffuus licht, kunstlicht, schaduw, gemengd licht, nacht, daglicht, overcast, storm

MINIMALE EISEN (verplicht):
- minimaal 5 technieken
- minimaal 3 unique_insights
- workflow_order: minimaal 4 stappen
- color_approach: minimaal 2 zinnen
- youtube_url en photographer_name altijd invullen

VERBODEN: fotografernamen in philosophy/techniques/unique_insights, vage omschrijvingen, Engelse genre/software namen, software buiten de lijst.

Geef ALLEEN de JSON terug, geen uitleg, geen markdown code blocks:
{
  "video_title": "...", "photographer_name": "...", "youtube_url": "...",
  "genre": [...], "light_conditions": [...], "mood": [...], "software": [...],
  "style_description": "max 4 woorden",
  "philosophy": "3-4 zinnen",
  "workflow_order": ["stap 1: ...", "stap 2: ...", "stap 3: ...", "stap 4: ..."],
  "techniques": [{"name":"...","description":"...","when_to_use":"...","tools":[...],"effect":"..."}],
  "color_approach": "minimaal 2 zinnen",
  "local_adjustments": "...",
  "what_to_avoid": [...],
  "best_for": "...",
  "unique_insights": ["...", "...", "..."]
}`;

function validateEntry(entry) {
  const issues = [];
  if (!entry.video_title) issues.push('video_title ontbreekt');
  if (!entry.genre || !entry.genre.length) issues.push('genre ontbreekt');
  if (!entry.techniques || entry.techniques.length < 3) issues.push('te weinig technieken (' + (entry.techniques?.length||0) + ')');
  if (!entry.unique_insights || entry.unique_insights.length < 2) issues.push('te weinig unique_insights (' + (entry.unique_insights?.length||0) + ')');
  if (!entry.philosophy) issues.push('philosophy ontbreekt');
  if (!entry.workflow_order || !entry.workflow_order.length) issues.push('workflow_order ontbreekt');
  if (!entry.color_approach) issues.push('color_approach ontbreekt');
  // Weiger nep/gegenereerde entries waarbij Gemini de video niet kon analyseren
  const fakePhrases = ['kon niet worden geanalyseerd', 'kon niet direct worden geanalyseerd',
    'video-informatie niet beschikbaar', 'niet toegankelijk', 'could not be analyzed',
    'unable to analyze', 'onbekende video'];
  const philosophy = (entry.philosophy || '').toLowerCase();
  const title = (entry.video_title || '').toLowerCase();
  if (fakePhrases.some(p => philosophy.includes(p) || title.includes(p))) {
    issues.push('video kon niet worden geanalyseerd door Gemini — entry is onbetrouwbaar');
  }
  if (!entry.photographer_name || ['onbekend', 'unknown', ''].includes(entry.photographer_name.toLowerCase().trim())) {
    issues.push('photographer_name ontbreekt of is onbekend');
  }

  // Genre check tegen vaste lijst
  if (entry.genre) {
    const invalidGenres = entry.genre.filter(g => !ALLOWED_GENRES.includes(g));
    if (invalidGenres.length) issues.push('ongeldige genres: ' + invalidGenres.join(', '));
  }
  // Software check tegen vaste lijst
  if (entry.software && entry.software.length) {
    const invalidSw = entry.software.filter(s => !ALLOWED_SOFTWARE.includes(s));
    if (invalidSw.length) issues.push('ongeldige software: ' + invalidSw.join(', '));
  }

  return issues;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const token = getToken(req);
    if (!verifyAdminToken(token)) return res.status(403).json({ error: 'Geen toegang' });

    const { youtubeUrls } = req.body;
    if (!Array.isArray(youtubeUrls) || !youtubeUrls.length) {
      return res.status(400).json({ error: 'youtubeUrls array vereist' });
    }
    if (youtubeUrls.length > 10) {
      return res.status(400).json({ error: 'Maximaal 10 URLs per keer (timeout limiet)' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Gemini API key niet geconfigureerd' });

    const existingKnowledge = await loadKnowledge();
    const existingTitles = new Set(existingKnowledge.map(e => e.video_title));

    const results = { added: [], skipped: [], failed: [] };

    // Verwerk alle video's PARALLEL (niet na elkaar) om de Vercel timeout te vermijden
    async function analyzeOne(url) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { file_data: { file_uri: url } },
                { text: GEMINI_PROMPT }
              ]
            }],
            generationConfig: { maxOutputTokens: 8192, temperature: 0.4 }
          })
        });
        const d = await r.json();

        if (d.error) {
          return { type: 'failed', url, error: d.error.message };
        }

        let text = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
        text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        let entry;
        try {
          entry = JSON.parse(text);
        } catch(parseErr) {
          return { type: 'failed', url, error: 'JSON parse fout: ' + parseErr.message };
        }

        entry.youtube_url = entry.youtube_url || url;

        if (existingTitles.has(entry.video_title)) {
          return { type: 'skipped', url, title: entry.video_title, reason: 'bestaat al' };
        }

        const issues = validateEntry(entry);
        if (issues.length) {
          return { type: 'failed', url, title: entry.video_title, error: 'Kwaliteit onvoldoende: ' + issues.join('; ') };
        }

        return { type: 'added', url, entry, title: entry.video_title, techniques: entry.techniques.length, insights: entry.unique_insights.length };

      } catch(videoErr) {
        return { type: 'failed', url, error: videoErr.message };
      }
    }

    const outcomes = await Promise.all(youtubeUrls.map(analyzeOne));

    for (const outcome of outcomes) {
      if (outcome.type === 'added') {
        existingKnowledge.push(outcome.entry);
        existingTitles.add(outcome.title);
        results.added.push({ url: outcome.url, title: outcome.title, techniques: outcome.techniques, insights: outcome.insights });
      } else if (outcome.type === 'skipped') {
        results.skipped.push({ url: outcome.url, title: outcome.title, reason: outcome.reason });
      } else {
        results.failed.push({ url: outcome.url, title: outcome.title, error: outcome.error });
      }
    }

    // Sla bijgewerkte kennisbank op als er nieuwe entries zijn
    if (results.added.length > 0) {
      await saveKnowledge(existingKnowledge);
    }

    return res.status(200).json({
      success: true,
      totalEntries: existingKnowledge.length,
      results
    });

  } catch (err) {
    return res.status(500).json({ error: 'Server fout: ' + err.message });
  }
};
