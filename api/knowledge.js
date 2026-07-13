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

// ── Genre normalisatie ─────────────────────────────────────────────────────
const GENRE_NORMALIZATION = {
  'wedding': 'trouwfotografie',
  'bruiloft': 'trouwfotografie',
  'elopement': 'trouwfotografie',
  'portrait': 'portret',
  'portraits': 'portret',
  'travel': 'reisfotografie',
  'travel photography': 'reisfotografie',
  'bos': 'landschap',
  'bosfotografie': 'landschap',
  'forest': 'landschap',
  'event': 'documentaire',
  'editorial': 'documentaire',
  'events': 'documentaire',
  'fantasy': 'experimenteel',
  'abstract': 'experimenteel',
  'grafisch': 'grafisch ontwerp',
  'graphic': 'grafisch ontwerp',
  'vogeloverzicht': 'wildlife',
  'vogelonline': 'wildlife',
  'birds': 'wildlife',
  'bird photography': 'wildlife',
  'wildlife photography': 'wildlife',
  'nature': 'wildlife',
  'street': 'straatfotografie',
  'street photography': 'straatfotografie',
  'architecture': 'architectuur',
  'landscape': 'landschap',
  'macro photography': 'macro',
  'night': 'nacht & astro',
  'astrophotography': 'nacht & astro',
  'astro': 'nacht & astro',
  'product photography': 'product',
  'infrared': 'infraroodfotografie',
  'infrared photography': 'infraroodfotografie',
  'black and white': 'zwart-wit',
  'monochrome': 'zwart-wit',
  'zwart wit': 'zwart-wit',
  'coastal': 'kust',
  'seascape': 'kust',
  'aerial': 'luchtfotografie',
  'drone': 'luchtfotografie',
  'drone photography': 'luchtfotografie',
  'fine art': 'fine-art',
  'cinematic': 'cinematisch',
  'documentary': 'documentaire',
  'sport': 'sport',
  'sports': 'sport',
  'action': 'sport'
};

// ── Software normalisatie ─────────────────────────────────────────────────
const SOFTWARE_NORMALIZATION = {
  'camera raw': 'Photoshop',
  'camera raw (photoshop)': 'Photoshop',
  'adobe camera raw': 'Photoshop',
  'acr': 'Photoshop',
  'lightroom cc': 'Lightroom Classic',
  'adobe lightroom classic': 'Lightroom Classic',
  'adobe lightroom': 'Lightroom Classic',
  'lr classic': 'Lightroom Classic',
  'lrc': 'Lightroom Classic',
  'lightroom mobile': 'Lightroom Mobile',
  'adobe lightroom mobile': 'Lightroom Mobile',
  'lr mobile': 'Lightroom Mobile',
  'adobe photoshop': 'Photoshop',
  'ps': 'Photoshop',
  'capture one pro': 'Capture One',
  'captureone': 'Capture One',
  'c1': 'Capture One',
  'dxo': 'DxO PhotoLab',
  'dxo photolab': 'DxO PhotoLab',
  'luminar': 'Luminar Neo',
  'luminar ai': 'Luminar Neo',
  'luminar 4': 'Luminar Neo',
  'on1': 'ON1 Photo RAW',
  'on1 photo raw': 'ON1 Photo RAW',
  'affinity photo': 'Affinity Photo',
  'affinity': 'Affinity Photo',
  'raw therapee': 'RawTherapee',
  'rawtherapee': 'RawTherapee',
  'bazaart': null
};

function normalizeSoftware(software) {
  if (!Array.isArray(software)) return software;
  const seen = new Set();
  return software.map(function(s) {
    const normalized = SOFTWARE_NORMALIZATION[s.toLowerCase().trim()];
    if (normalized === null) return null; // verwijder ongeldige software
    return normalized !== undefined ? normalized : s;
  }).filter(function(s) {
    if (s === null || seen.has(s)) return false;
    seen.add(s);
    return true;
  });
}

// ── Kwaliteitscheck voor waarschuwingen ────────────────────────────────────
const CHANNEL_NAME_INDICATORS = ['studio', 'photography', 'films', 'productions', 'official', 'channel', 'media', 'creative', 'visuals', 'guys', 'brothers', 'labs'];
const ENGLISH_ONLY = new Set(['dreamy','ethereal','calm','soft','cinematic','clean','dramatic','professional','technical','educational','experimental','artistic','melancholic','serene','vibrant','atmospheric','moody','creative','natural','warm','balanced','surreal','minimalist','timeless','epic','rugged','mysterious','abstract','impressionistic','stark','filmic','painterly','grungy','faded','dusk']);

const KNOWN_MOODS = ['moody','dramatisch','rustig','levendig','naturalistisch','cinematisch','romantisch','donker','licht','mystiek','energiek','melancholisch','strak','commercieel','speels','surrealistisch','minimalistisch','nostalgisch','filmisch','sfeervol','harmonieus','luxueus','luxueuze','abstract','experimenteel','grafisch','documentair','intiem','episch','vintage','modern','warm','koel','helder','zacht','hard','natuurlijk','artistiek','expressief','sereen','dynamisch','klassiek','tijdloos','rauw','rauwe','clean','punchy','technisch','surreeel','surreëel','krachtig','contrastrijk','creatief','cinematic','dreamy','dromerig','analytisch','atmosferisch','atmospheric','verhalend','gedetailleerd','kleurrijk','gepolijst','educatief','mysterieus','professioneel','fine art','informatief','praktisch','ethereal','calm','soft','etherisch','kalm','elegant','moody','grafisch','sterk','vriendelijk','somber','vrolijk','neutraal','zakelijk','speels','romantisch','poëtisch','rauwe','clean','punchy','helder','donker','warm','koel'];

function getEntryWarnings(entry) {
  const warnings = [];
  const name = (entry.photographer_name || '').trim();

  // Kanaalnaam indicatoren
  if (name === name.toUpperCase() && name.length > 3) {
    warnings.push('naam volledig in hoofdletters');
  }
  const nameLower = name.toLowerCase();
  for (const indicator of CHANNEL_NAME_INDICATORS) {
    if (nameLower.includes(indicator)) {
      warnings.push('naam lijkt op kanaalnaam (' + indicator + ')');
      break;
    }
  }

  // Software check
  for (const s of (entry.software || [])) {
    if (SOFTWARE_NORMALIZATION[s.toLowerCase()] === null) {
      warnings.push('ongeldige software: ' + s);
    }
  }

  // Mood typo check
  for (const m of (entry.mood || [])) {
    const ml = m.toLowerCase().trim();
    if (ml === 'not_applicable' || ml === 'n/a') warnings.push('ongeldige mood: ' + m);
  }

  // Weinig technieken
  if ((entry.techniques || []).length < 3) {
    warnings.push('minder dan 3 technieken');
  }

  // Weinig insights
  if ((entry.unique_insights || []).length < 2) {
    warnings.push('minder dan 2 insights');
  }

  return warnings;
}

function normalizeGenres(genres) {
  if (!Array.isArray(genres)) return genres;
  const seen = new Set();
  return genres.map(function(g) {
    const normalized = GENRE_NORMALIZATION[g.toLowerCase().trim()] || g;
    return normalized;
  }).filter(function(g) {
    if (seen.has(g)) return false;
    seen.add(g);
    return true;
  });
}

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
// Fotografnaam correcties
const NAME_CORRECTIONS = {
  'PHLEARN': 'Aaron Nace',
  'THAT ICELANDIC GUY': 'Arnúlfur Hakonarson',
  'THAT ICELANDIC GUY.': 'Arnúlfur Hakonarson',
  'TKNORTH': 'TK North',
  'DM Productions': 'Darren McDaniel',
  'Darren (DM Productions)': 'Darren McDaniel',
  'MyGimpTutorialChannel': null,
  'CREATIVE DC': null,
  'SKY STORY': null,
  'IAMRENSI': null,
  'GIMP TUT': null,
  'WHISPERS OF POWER': null,
  'BNomandProductions': null,
  'Benny Productions': null,
  'MDMZ': null,
  'P A N T E R': null,
  'Areeb Productions': null
};

// Software normalisatie
const SW_RENAME = {
  'Camera Raw (Photoshop)': 'Photoshop',
  'gimp': 'GIMP',
  'Topaz Studio 2': null,
};
const SW_REMOVE = new Set(['Nik Collection','Topaz Photo AI','Topaz Studio 2',
  'DNG Profile Editor','Imagine AI','Affinity Photo','ON1 Photo RAW','PixInsight','algemeen']);
const SUPPORTED_SW = new Set(['Lightroom Classic','Lightroom Mobile','Photoshop',
  'Capture One','DxO PhotoLab','Luminar Neo','darktable','RawTherapee','Snapseed','VSCO','GIMP']);

// Genre normalisatie
const GENRE_FIX = {
  'fijn-art': 'fine-art',
  'stadsfotografie': 'straatfotografie',
  'verhaal': 'documentaire',
  'sfeervol': null,
  'reportage': 'documentaire',
  'documentary': 'documentaire',
};

async function saveKnowledge(entries) {
  // Normaliseer fotografnamen, software en genres (GEEN deduplicatie hier — die zit in save_chunk)
  const cleaned = entries
    .filter(e => {
      const name = (e.photographer_name||'').trim();
      if (NAME_CORRECTIONS[name] === null) return false;
      const sw = (e.software||[]).filter(s => !SW_REMOVE.has(s)).map(s => SW_RENAME[s] || s);
      return sw.some(s => SUPPORTED_SW.has(s));
    })
    .map(e => {
      const name = (e.photographer_name || '').trim();
      if (NAME_CORRECTIONS[name]) e.photographer_name = NAME_CORRECTIONS[name];
      const newSw = [...new Set((e.software||[]).filter(s => !SW_REMOVE.has(s)).map(s => SW_RENAME[s] || s))];
      e.software = newSw;
      e.genre = [...new Set((e.genre||[]).map(g => GENRE_FIX[g] !== undefined ? GENRE_FIX[g] : g).filter(Boolean))];
      return e;
    });
  await kv('SET', REDIS_KEY, JSON.stringify(cleaned));
  return cleaned; // belangrijk: dit is de daadwerkelijk opgeslagen lijst, kan korter zijn dan de input
}

// Legt uit waarom een entry door saveKnowledge zou worden weggefilterd (voor foutmeldingen)
function explainWhyFiltered(entry) {
  const name = (entry.photographer_name || '').trim();
  if (NAME_CORRECTIONS[name] === null) {
    return 'Fotografennaam "' + name + '" staat op de verwijderlijst (waarschijnlijk een kanaalnaam of ongeldige naam).';
  }
  const sw = (entry.software || []).filter(s => !SW_REMOVE.has(s)).map(s => SW_RENAME[s] || s);
  if (!sw.some(s => SUPPORTED_SW.has(s))) {
    return 'Geen enkele opgegeven software (' + (entry.software||[]).join(', ') + ') wordt ondersteund na normalisatie.';
  }
  return 'Onbekende reden — controleer de entry handmatig.';
}

// Dedupliceer op YouTube video ID — alleen voor bulk operaties
function deduplicateEntries(entries) {
  const getVidId = url => {
    if (!url) return null;
    const m = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return m ? m[1].toLowerCase() : null;
  };
  const seen = new Map();
  entries.forEach(e => {
    const vid = getVidId(e.youtube_url);
    if (!vid) return;
    const score = (e.techniques||[]).length + (e.unique_insights||[]).length;
    const existing = seen.get(vid);
    if (!existing || score > (existing.techniques||[]).length + (existing.unique_insights||[]).length) {
      seen.set(vid, e);
    }
  });
  const noUrl = entries.filter(e => !getVidId(e.youtube_url));
  return [...noUrl, ...Array.from(seen.values())];
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

// ── GitHub backup via Git Data API ────────────────────────────────────────
async function pushToGitHub(entries) {
  const ghToken = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO || 'SnOoDPhotos/AI-Photo-coach';
  if (!ghToken) return { success: false, reason: 'geen GITHUB_TOKEN' };

  const api = 'https://api.github.com/repos/' + repo;
  const headers = {
    'Authorization': 'token ' + ghToken,
    'Content-Type': 'application/json',
    'Accept': 'application/vnd.github.v3+json'
  };

  try {
    const ref = await fetch(api + '/git/refs/heads/main', { headers }).then(r => r.json());
    const commit = await fetch(api + '/git/commits/' + ref.object.sha, { headers }).then(r => r.json());
    const content = Buffer.from(JSON.stringify(entries, null, 2)).toString('base64');
    const blob = await fetch(api + '/git/blobs', {
      method: 'POST', headers,
      body: JSON.stringify({ content, encoding: 'base64' })
    }).then(r => r.json());
    const tree = await fetch(api + '/git/trees', {
      method: 'POST', headers,
      body: JSON.stringify({ base_tree: commit.tree.sha, tree: [{ path: 'knowledge-base.json', mode: '100644', type: 'blob', sha: blob.sha }] })
    }).then(r => r.json());
    const newCommit = await fetch(api + '/git/commits', {
      method: 'POST', headers,
      body: JSON.stringify({ message: 'Auto-backup: kennisbank bijgewerkt via admin', tree: tree.sha, parents: [ref.object.sha] })
    }).then(r => r.json());
    await fetch(api + '/git/refs/heads/main', {
      method: 'PATCH', headers,
      body: JSON.stringify({ sha: newCommit.sha })
    });
    return { success: true, commit: newCommit.sha.slice(0, 7) };
  } catch(e) {
    return { success: false, reason: e.message };
  }
}

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

    // ── RESET STYLE PREVIEWS ──────────────────────────────────────────────────
    if (action === 'reset_previews') {
      const token = getToken(req);
      if (!verifyAdminToken(token)) return res.status(403).json({ error: 'Geen toegang' });
      // Leeg de aparte previews map
      await kv('SET', 'style_previews:map', JSON.stringify({}));
      // Verwijder style_preview uit alle kennisbank entries
      const kb = await loadKnowledge();
      const cleaned = kb.map(function(e) {
        const c = Object.assign({}, e);
        delete c.style_preview;
        return c;
      });
      await saveKnowledge(cleaned);
      return res.status(200).json({ success: true, message: 'Alle style previews gewist', count: cleaned.length });
    }

    // ── WAARSCHUWINGEN OPHALEN (admin) ────────────────────────────────────────
    if (action === 'get_warnings') {
      const token = getToken(req);
      if (!verifyAdminToken(token)) return res.status(403).json({ error: 'Geen toegang' });
      const kb = await loadKnowledge();
      const withWarnings = kb.map(function(e, i) {
        const w = getEntryWarnings(e);
        return w.length > 0 ? { index: i, youtube_url: e.youtube_url, video_title: e.video_title, photographer_name: e.photographer_name, warnings: w } : null;
      }).filter(Boolean);
      return res.status(200).json({ success: true, count: withWarnings.length, entries: withWarnings });
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
      if (entry && Array.isArray(entry.genre)) {
        entry.genre = normalizeGenres(entry.genre);
      }
      if (entry && Array.isArray(entry.software)) {
        entry.software = normalizeSoftware(entry.software);
      }
      // Voeg waarschuwingen toe
      const entryWarnings = getEntryWarnings(entry);
      if (entryWarnings.length > 0) {
        entry._warnings = entryWarnings;
      }
      if (!entry || !entry.video_title) return res.status(400).json({ error: 'Ongeldige entry' });

      const entries = await loadKnowledge();

      // Normaliseer YouTube URL voor vergelijking (youtube.com/watch?v=X == youtu.be/X)
      function extractVideoId(url) {
        if (!url) return null;
        const m = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        return m ? m[1] : url.toLowerCase().trim();
      }
      const newId = extractVideoId(entry.youtube_url);
      const newTitle = (entry.video_title || '').toLowerCase().trim();

      const existingIdx = entries.findIndex(e => {
        const eId = extractVideoId(e.youtube_url);
        if (newId && eId && newId === eId) return true;
        return (e.video_title || '').toLowerCase().trim() === newTitle;
      });

      if (existingIdx !== -1) {
        // Vergelijk kwaliteit - behoud de betere versie
        const existing = entries[existingIdx];
        const existingScore = (existing.techniques||[]).length + (existing.unique_insights||[]).length;
        const newScore = (entry.techniques||[]).length + (entry.unique_insights||[]).length;
        // Warning override: ook accepteren als bestaande waarschuwingen heeft en nieuwe die oplost
        const existingHasWarning = (existing.techniques||[]).length < 3 || (existing.unique_insights||[]).length < 2
          || !existing.workflow_order || !existing.color_approach;
        const newFixesWarning = (entry.techniques||[]).length >= 3 && (entry.unique_insights||[]).length >= 2
          && entry.workflow_order && entry.color_approach;
        if (newScore > existingScore || (existingHasWarning && newFixesWarning)) {
          // Behoud style_preview van bestaande entry
          if (existing.style_preview && !entry.style_preview) {
            entry.style_preview = existing.style_preview;
          }
          entries[existingIdx] = entry;
          const persisted = await saveKnowledge(entries);
          const stillPresent = persisted.some(e => extractVideoId(e.youtube_url) === newId || (e.video_title||'').toLowerCase().trim() === newTitle);
          if (!stillPresent) {
            return res.status(422).json({ error: 'Entry werd na normalisatie weggefilterd en dus NIET opgeslagen: ' + explainWhyFiltered(entry), count: persisted.length });
          }
          let ghWarning = null;
          try {
            const ghResult = await pushToGitHub(persisted);
            if (!ghResult.success) ghWarning = 'Opgeslagen in Redis, maar GitHub-sync mislukt: ' + ghResult.reason;
          } catch(ghErr) { ghWarning = 'Opgeslagen in Redis, maar GitHub-sync mislukt: ' + ghErr.message; }
          return res.status(200).json({ success: true, updated: true, count: persisted.length, message: 'Betere versie vervangt bestaande entry', warning: ghWarning });
        } else {
          return res.status(409).json({ error: 'Bestaande entry is al beter (score: ' + existingScore + ' vs ' + newScore + ')', existing_score: existingScore, new_score: newScore });
        }
      }

      entries.push(entry);
      const persisted = await saveKnowledge(entries);
      const stillPresent = persisted.some(e => extractVideoId(e.youtube_url) === newId || (e.video_title||'').toLowerCase().trim() === newTitle);
      if (!stillPresent) {
        return res.status(422).json({ error: 'Entry werd na normalisatie weggefilterd en dus NIET opgeslagen: ' + explainWhyFiltered(entry), count: persisted.length });
      }
      let ghWarning = null;
      try {
        const ghResult = await pushToGitHub(persisted);
        if (!ghResult.success) ghWarning = 'Opgeslagen in Redis, maar GitHub-sync mislukt: ' + ghResult.reason;
      } catch(ghErr) { ghWarning = 'Opgeslagen in Redis, maar GitHub-sync mislukt: ' + ghErr.message; }
      return res.status(200).json({ success: true, count: persisted.length, warning: ghWarning });
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

      const { force_reset } = req.body;

      // Merge: haal bestaande previews op uit Redis via youtube_url als sleutel
      const previewMap = {};
      if (force_reset) {
        // Reset modus: geen previews bewaren
        await saveKnowledge(entries);
        return res.status(200).json({ success: true, count: entries.length, previewsPreserved: 0, reset: true });
      }
      try {
        const existing = await loadKnowledge();
        existing.forEach(function(e) {
          if (e.style_preview && e.style_preview.length > 10) {
            if (e.youtube_url) previewMap[e.youtube_url.toLowerCase().trim()] = e.style_preview;
            if (e.video_title) previewMap[e.video_title.toLowerCase().trim()] = e.style_preview;
          }
        });
      } catch(e) { console.log('Merge preview error:', e.message); }

      // Normaliseer genres in alle inkomende entries
      const normalizedEntries = entries.map(function(e) {
        if (!e) return e;
        const updated = Object.assign({}, e);
        if (Array.isArray(updated.genre)) updated.genre = normalizeGenres(updated.genre);
        if (Array.isArray(updated.software)) updated.software = normalizeSoftware(updated.software);
        const w = getEntryWarnings(updated);
        if (w.length > 0) updated._warnings = w;
        else delete updated._warnings;
        return updated;
      });
      const merged = normalizedEntries.map(function(e) {
        if (!e.style_preview || e.style_preview.length < 10) {
          var preview = null;
          if (e.youtube_url) preview = previewMap[e.youtube_url.toLowerCase().trim()];
          if (!preview && e.video_title) preview = previewMap[e.video_title.toLowerCase().trim()];
          if (preview) return Object.assign({}, e, { style_preview: preview });
        }
        return e;
      });

      const preserved = merged.filter(e => e.style_preview && e.style_preview.length > 10).length;
      await saveKnowledge(merged);
      // Auto-backup naar GitHub
      const ghResult = await pushToGitHub(merged);
      return res.status(200).json({ success: true, count: merged.length, previewsPreserved: preserved, github: ghResult });
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

    // ── CHUNKED OPSLAAN ──────────────────────────────────────────────────
    if (action === 'save_chunk') {
      const token = getToken(req);
      if (!verifyAdminToken(token)) return res.status(403).json({ error: 'Geen toegang' });
      const { entries, chunk_index, total_chunks } = req.body;
      if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries array vereist' });
      try {
        if (chunk_index === 0) {
          // Eerste chunk: vervang alles
          await saveKnowledge(deduplicateEntries(entries));
        } else {
          // Volgende chunks: voeg toe aan bestaande
          const existing = await loadKnowledge();
          const combined = [...existing, ...entries];
          await saveKnowledge(combined);
        }
        const isLast = chunk_index === total_chunks - 1;
        if (isLast) {
          // Push naar GitHub na laatste chunk
          const all = await loadKnowledge();
          await pushToGitHub(all);
          return res.status(200).json({ success: true, done: true, count: all.length });
        }
        return res.status(200).json({ success: true, done: false, chunk: chunk_index });
      } catch(e) {
        return res.status(500).json({ error: 'Chunk opslaan mislukt: ' + e.message });
      }
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
