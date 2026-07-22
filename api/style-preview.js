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

    if (action === 'reset_previews') {
      // Verwijder alle bestaande style_previews zodat ze opnieuw gegenereerd worden
      await kv('SET', 'style_previews:map', JSON.stringify({}));
      const kb = await loadKnowledge();
      const cleaned = kb.map(function(e) {
        const c = Object.assign({}, e);
        delete c.style_preview;
        return c;
      });
      await saveKnowledge(cleaned);
      return res.status(200).json({ success: true, message: 'Alle style previews gereset' });
    }

// Gedeelde vertaal-batch-functie, vervangt de bijna-identieke logica die eerder los
// in translate_previews en translate_names stond. Getest tegen mock-Gemini-responses
// vóór toepassing (zie sessie-notities); gedrag komt overeen met de originelen.
async function translateField(opts) {
  const { entries, sourceField, targetField, minLength, keyFn, buildPrompt, postProcess, validate, notFoundMessage, generationConfig, GEMINI_API_KEY } = opts;

  const toTranslate = (entries || []).filter(function(e) {
    var src = e[sourceField] || '';
    var tgt = e[targetField] || '';
    if (!src || src.length < minLength) return false;
    if (!tgt || tgt.length < minLength) return true;
    return false;
  });
  if (!toTranslate.length) {
    return { success: true, translated: 0, skipped: 0, message: notFoundMessage };
  }

  const seen = new Set();
  const unique = toTranslate.filter(function(e) {
    const key = keyFn(e[sourceField]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let translated = 0;
  const errors = [];
  const PARALLEL = 10;
  const results = [];
  for (let i = 0; i < unique.length; i += PARALLEL) {
    const batch = unique.slice(i, i + PARALLEL);
    await Promise.all(batch.map(async function(entry) {
      const source = entry[sourceField];
      const prompt = buildPrompt(source);
      try {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_API_KEY, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig })
        });
        const data = await r.json();
        if (data.error) { errors.push(source.slice(0,40) + '...: ' + data.error.message); return; }
        let text = (data.candidates||[]).map(c => ((c.content||{}).parts||[])).flat().map(p => p.text||'').join('').trim();
        text = postProcess ? postProcess(text) : text;
        if (!text || text.length < 2) { errors.push(source.slice(0,40) + '...: lege response'); return; }
        const validationError = validate ? validate(text, source) : null;
        if (validationError) { errors.push(source.slice(0,40) + '...: ' + validationError); return; }
        results.push({ source, text });
      } catch(e) {
        errors.push(source.slice(0,40) + '...: ' + e.message);
      }
    }));
  }

  if (results.length) {
    const kb = await loadKnowledge();
    const bySource = {};
    results.forEach(function(r) { bySource[keyFn(r.source)] = r.text; });
    kb.forEach(function(e) {
      const key = keyFn(e[sourceField]);
      if (bySource[key]) {
        e[targetField] = bySource[key];
        translated++;
      }
    });
    await saveKnowledge(kb);
  }

  return { success: true, translated, skipped: toTranslate.length - unique.length, errors: errors.slice(0,5) };
}

    if (action === 'translate_previews') {
      const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
      if (!GEMINI_API_KEY) return res.status(500).json({ error: 'Gemini API key niet geconfigureerd' });

      const result = await translateField({
        entries, GEMINI_API_KEY,
        sourceField: 'style_preview', targetField: 'style_preview_en', minLength: 10,
        keyFn: s => s.trim(),
        buildPrompt: source => 'Translate the following Dutch photo-editing style description into natural, fluent English. Keep the same tone, meaning and level of detail. Do not add or remove information. Do not mention any photographer, person or YouTuber name. Return ONLY the translated text, nothing else.\n\nDutch text:\n' + source,
        validate: text => {
          const t = text.trim();
          if (!t.endsWith('.') && !t.endsWith('!') && !t.endsWith('?')) return 'afgekapte vertaling, overgeslagen';
          return null;
        },
        notFoundMessage: 'Alle entries hebben al een Engelse vertaling',
        generationConfig: { maxOutputTokens: 2500, temperature: 0.3 }
      });
      return res.status(200).json(result);
    }

    if (action === 'translate_names') {
      const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
      if (!GEMINI_API_KEY) return res.status(500).json({ error: 'Gemini API key niet geconfigureerd' });

      const result = await translateField({
        entries, GEMINI_API_KEY,
        sourceField: 'style_description', targetField: 'style_description_nl', minLength: 3,
        keyFn: s => s.trim().toLowerCase(),
        buildPrompt: source => 'Translate the following short English photo-editing style name into a natural, catchy Dutch equivalent (2-5 words). Keep it as a short name/title, not a sentence. Do not mention any photographer or person name. Return ONLY the translated name, nothing else.\n\nEnglish name:\n' + source,
        postProcess: t => t.replace(/^["']|["']$/g, '').replace(/\*+/g, '').trim(),
        validate: (text, source) => {
          if (text.length < source.length * 0.4 && text.length < 8) return 'vermoedelijk afgekapt, overgeslagen';
          return null;
        },
        notFoundMessage: 'Alle entries hebben al een Nederlandse stijlnaam',
        generationConfig: { maxOutputTokens: 2500, temperature: 0.3, thinkingConfig: { thinkingBudget: 0 } }
      });
      return res.status(200).json(result);
    }

    if (action !== 'generate_previews') {
      return res.status(400).json({ error: 'Onbekende actie' });
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) return res.status(500).json({ error: 'Gemini API key niet geconfigureerd' });

    const toProcess = (entries || []).filter(function(e) {
      var p = e.style_preview || '';
      if (!p || p.length < 10) return true;
      if (!p.trim().endsWith('.') && !p.trim().endsWith('!') && !p.trim().endsWith('?')) return true;
      // Opnieuw genereren als fotografnaam in de preview staat
      if (e.photographer_name && p.toLowerCase().includes(e.photographer_name.toLowerCase())) return true;
      return false;
    });
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

    // Fase 1: verzamel alle Gemini-resultaten in parallelle batches van 10
    // (GEEN Redis load/save hier - dat gebeurt pas na alle batches, om
    // race conditions tussen gelijktijdige loadKnowledge/saveKnowledge te voorkomen)
    const PARALLEL = 10;
    const results = []; // { photographer_name, style_description, text }
    for (let i = 0; i < unique.length; i += PARALLEL) {
      const batch = unique.slice(i, i + PARALLEL);
      await Promise.all(batch.map(async function(entry) {
        const prompt = 'Schrijf een stijlomschrijving van 3 tot 5 zinnen voor de bewerkingsstijl genaamd "' + (entry.style_description||'') + '". Gebruik deze informatie: Filosofie: ' + (entry.philosophy||'').slice(0,250) + '. Beste voor: ' + (entry.best_for||'') + '. Genre: ' + (entry.genre||[]).join(', ') + '. BELANGRIJK: Noem NOOIT de naam van een fotograaf, persoon of youtuber. Verwijs altijd naar "deze stijl" of "deze bewerkingsfilosofie". Beschrijf: (1) de visuele sfeer en toon, (2) de kernfilosofie in gewone taal, (3) voor welk type foto en lichtomstandigheden deze stijl het beste werkt, (4) het verwachte visuele effect. Schrijf als lopende tekst, geen opsomming, vanuit het perspectief van een fotograaf die overweegt deze stijl te gebruiken.';

        try {
          const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_API_KEY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: 2500, temperature: 0.4 }
            })
          });
          const data = await r.json();
          if (data.error) { errors.push((entry.photographer_name||'?') + ': ' + data.error.message); return; }
          const text = (data.candidates||[]).map(c => ((c.content||{}).parts||[])).flat().map(p => p.text||'').join('').trim();
          if (!text || text.length < 20) { errors.push((entry.photographer_name||'?') + ': lege response'); return; }
          if (!text.trim().endsWith('.') && !text.trim().endsWith('!') && !text.trim().endsWith('?')) {
            errors.push((entry.photographer_name||'?') + ': Gemini-antwoord zelf afgekapt, overgeslagen'); return;
          }

          results.push({
            photographer_name: entry.photographer_name || '',
            style_description: entry.style_description || '',
            text
          });
        } catch(e) {
          errors.push((entry.photographer_name||'?') + ': ' + e.message);
        }
      }));
    }

    // Fase 2: één keer laden, alle resultaten toepassen, één keer opslaan
    if (results.length) {
      const kb = await loadKnowledge();
      const previewsRaw = await kv('GET', 'style_previews:map');
      const previewMap = previewsRaw ? JSON.parse(previewsRaw) : {};

      results.forEach(function(res) {
        const pg = res.photographer_name.toLowerCase();
        const sg = res.style_description.toLowerCase();
        let updated = false;
        kb.forEach(function(e) {
          if ((e.photographer_name||'').toLowerCase() === pg && (e.style_description||'').toLowerCase() === sg) {
            e.style_preview = res.text;
            updated = true;
            const ek = ((e.youtube_url||'') + '|' + (e.video_title||'')).toLowerCase();
            previewMap[ek] = res.text;
          }
        });
        if (updated) {
          generated++;
          const pk = (res.photographer_name + '|' + res.style_description).toLowerCase();
          previewMap[pk] = res.text;
        }
      });

      await saveKnowledge(kb);
      try { await kv('SET', 'style_previews:map', JSON.stringify(previewMap)); }
      catch(e2) { console.log('Preview map save error:', e2.message); }
    }

    return res.status(200).json({ success: true, generated, skipped: toProcess.length - unique.length, errors: errors.slice(0,5) });

  } catch(e) {
    console.error('style-preview error:', e);
    return res.status(500).json({ error: e.message });
  }
};
