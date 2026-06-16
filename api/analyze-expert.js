const fs   = require('fs');
const path = require('path');

// ── Redis helpers ──────────────────────────────────────────────────────────
async function kvGet(key) {
  const url   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN  || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['GET', key])
  });
  const d = await r.json();
  return d.result ? JSON.parse(d.result) : null;
}

// ── Kennisbank laden (Redis eerst, dan JSON fallback) ──────────────────────
async function loadKnowledgeBase() {
  try {
    const data = await kvGet('knowledge:db');
    if (Array.isArray(data) && data.length > 0) return data;
  } catch(e) {
    console.log('Redis fallback kennisbank:', e.message);
  }
  try {
    const filePath = path.join(process.cwd(), 'knowledge-base.json');
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch(e) {
    return [];
  }
}

// ── Software capabilities laden (Redis eerst, dan JSON fallback) ───────────
async function loadSoftwareCapabilities() {
  try {
    const data = await kvGet('software:capabilities');
    if (Array.isArray(data) && data.length > 0) return data;
  } catch(e) {}
  try {
    const filePath = path.join(process.cwd(), 'software-capabilities.json');
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch(e) {
    return [];
  }
}

// ── Software context bouwen voor de AI ────────────────────────────────────
function buildSoftwareContext(softwareId, capabilities) {
  if (!softwareId || !capabilities.length) return '';

  // Zoek de software op ID of gedeeltelijke naam match
  const sw = capabilities.find(s =>
    s.id === softwareId ||
    s.name.toLowerCase().includes(softwareId.toLowerCase()) ||
    s.short.toLowerCase().includes(softwareId.toLowerCase())
  );
  if (!sw) return '';

  let ctx = `

=== SOFTWARE: ${sw.name} ===
`;
  ctx += `BELANGRIJK: De gebruiker werkt met ${sw.name}. Geef ALLEEN adviezen die uitvoerbaar zijn in deze software.
`;

  if (sw.not_possible && sw.not_possible.length) {
    ctx += `
NIET BESCHIKBAAR in ${sw.name} — noem deze NOOIT:
`;
    sw.not_possible.forEach(f => {
      const alt = sw.alternatives && sw.alternatives[f];
      ctx += `✗ ${f}${alt ? ` → gebruik in plaats daarvan: ${alt}` : ''}
`;
    });
  }

  if (sw.notes) {
    ctx += `
Belangrijke noten voor ${sw.name}: ${sw.notes}
`;
  }

  ctx += `=== EINDE SOFTWARE CONTEXT ===
`;
  return ctx;
}

// ── Kennisbank selectie ────────────────────────────────────────────────────
function selectRelevantKnowledge(knowledgeBase, genre, mood, light) {
  const scores = knowledgeBase.map(entry => {
    let score = 0;
    if (genre && entry.genre) {
      const match = entry.genre.some(g =>
        genre.toLowerCase().includes(g.toLowerCase()) ||
        g.toLowerCase().includes(genre.toLowerCase())
      );
      if (match) score += 3;
    }
    if (mood && entry.mood) {
      const match = entry.mood.some(m => mood.toLowerCase().includes(m.toLowerCase()));
      if (match) score += 2;
    }
    if (light && entry.light_conditions) {
      const match = entry.light_conditions.some(l => light.toLowerCase().includes(l.toLowerCase()));
      if (match) score += 2;
    }
    return { entry, score };
  });
  return scores
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(s => s.entry);
}

// ── Kennisbank context bouwen ──────────────────────────────────────────────
function buildKnowledgeContext(relevant) {
  if (!relevant.length) return '';

  const primary = relevant[0];
  const photographerName = primary.photographer_name || null;
  let ctx = '';

  if (photographerName) {
    const styleLabel = primary.style_description || (primary.genre||[]).join('/') || 'Geselecteerde stijl';
    ctx += `\n\n=== VERPLICHTE BEWERKINGSSTIJL: ${styleLabel} ===\n`;
    ctx += `Je MOET deze specifieke stijl toepassen in elk onderdeel van je advies. Dit is geen suggestie.\n`;
    ctx += `BELANGRIJK: Noem NOOIT de naam van een fotograaf in je advies. Verwijs alleen naar "deze stijl" of "deze aanpak".\n`;
    ctx += `\nKernfilosofie: ${primary.philosophy}\n`;
    if (primary.workflow_order && primary.workflow_order.length) {
      ctx += `\nBewerkingsvolgorde voor deze stijl:\n`;
      primary.workflow_order.slice(0,5).forEach(s => ctx += `  ${s}\n`);
    }
    if (primary.techniques && primary.techniques.length) {
      ctx += `\nVERPLICHTE TECHNIEKEN — noem deze expliciet bij naam in je advies:\n`;
      primary.techniques.slice(0,4).forEach(t => {
        ctx += `• ${t.name}: ${t.description}\n`;
        ctx += `  Toepassen bij: ${t.when_to_use}\n`;
        if (t.effect) ctx += `  Effect: ${t.effect}\n`;
      });
    }
    if (primary.color_approach) ctx += `\nKleurbenadering:\n${primary.color_approach}\n`;
    if (primary.local_adjustments) ctx += `\nLokale aanpassingen:\n${primary.local_adjustments}\n`;
    if (primary.what_to_avoid && primary.what_to_avoid.length) {
      ctx += `\nUITDRUKKELIJK VERMIJDEN:\n`;
      primary.what_to_avoid.forEach(w => ctx += `✗ ${w}\n`);
    }
    if (primary.unique_insights && primary.unique_insights.length) {
      ctx += `\nUnieke inzichten die je MOET verwerken:\n`;
      primary.unique_insights.forEach(ins => ctx += `★ ${ins}\n`);
    }
    ctx += `\n=== EINDE STIJLRICHTLIJNEN ===\n`;
    ctx += `\nBelangrijk: Verwerk deze stijl actief in ELKE stap. Noem NOOIT een fotografnaam.\n`;
  } else {
    ctx += `\n\nEXPERT STIJLRICHTLIJNEN — verwerk actief in je advies:\n`;
    relevant.forEach((entry, i) => {
      ctx += `\n[Expert ${i+1} (${(entry.genre||[]).join('/')})]:\n`;
      ctx += `Filosofie: ${entry.philosophy}\n`;
      if (entry.techniques && entry.techniques.length) {
        entry.techniques.slice(0,2).forEach(t => ctx += `• ${t.name}: ${t.description}\n`);
      }
      if (entry.unique_insights && entry.unique_insights.length) ctx += `Kerninsight: ${entry.unique_insights[0]}\n`;
      if (entry.what_to_avoid && entry.what_to_avoid.length) ctx += `Vermijd: ${entry.what_to_avoid[0]}\n`;
    });
    ctx += `\nPas bovenstaande filosofieën en technieken actief toe.\n`;
  }

  if (photographerName && relevant.length > 1) {
    ctx += `\nAanvullende context:\n`;
    relevant.slice(1).forEach((entry, i) => {
      ctx += `[Stijl ${i+2}]: ${entry.philosophy.substring(0,150)}...\n`;
    });
  }

  return ctx;
}

// ── Handler ────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { parts, systemPrompt, maxTokens, photoContext, software } = req.body;
    if (!parts || !systemPrompt) return res.status(400).json({ error: 'Ontbrekende velden' });

    // Laad kennisbank en software capabilities parallel
    const [knowledgeBase, softwareCapabilities] = await Promise.all([
      loadKnowledgeBase(),
      loadSoftwareCapabilities()
    ]);

    // Selecteer relevante kennisbank entries
    let relevant = [];
    if (photoContext && photoContext.forcedEntry) {
      const forced = Object.assign({}, photoContext.forcedEntry, { _forced: true });
      const extra = selectRelevantKnowledge(
        knowledgeBase.filter(e => e.video_title !== forced.video_title),
        photoContext.genre, photoContext.mood, photoContext.light
      ).slice(0, 2);
      relevant = [forced, ...extra];
    } else if (photoContext) {
      relevant = selectRelevantKnowledge(knowledgeBase, photoContext.genre, photoContext.mood, photoContext.light);
    }

    // Bouw prompts
    const knowledgeContext  = buildKnowledgeContext(relevant);
    const softwareContext   = buildSoftwareContext(software || photoContext?.software, softwareCapabilities);
    const enhancedPrompt    = systemPrompt + knowledgeContext + softwareContext;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Gemini API key niet geconfigureerd' });

    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: enhancedPrompt }] },
        contents: [{ parts }],
        generationConfig: { maxOutputTokens: maxTokens || 8192 }
      })
    });

    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message || d.error.status || JSON.stringify(d.error) });
    const text = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    if (!text) return res.status(200).json({ error: 'Geen antwoord ontvangen van Gemini. Probeer opnieuw.', text: '' });

    return res.status(200).json({
      text,
      expertSources: relevant.length,
      knowledgeUsed: relevant.map(e => ({
        title: e.video_title,
        photographer: e.photographer_name || null,
        url: e.youtube_url || null
      }))
    });

  } catch (err) {
    return res.status(500).json({ error: 'Server fout: ' + err.message });
  }
};
