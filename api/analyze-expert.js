const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

function loadKnowledgeBase() {
  try {
    const filePath = path.join(process.cwd(), 'knowledge-base.json');
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch(e) {
    console.error('Could not load knowledge base:', e.message);
    return [];
  }
}

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

function buildKnowledgeContext(relevant) {
  if (!relevant.length) return '';

  const primary = relevant[0];
  const photographerName = primary.photographer_name || null;

  let ctx = '';

  if (photographerName) {
    // Specifieke fotograaf geselecteerd — dwingende stijlrichtlijnen
    ctx += `\n\n=== VERPLICHTE BEWERKINGSSTIJL: ${photographerName} ===\n`;
    ctx += `Je MOET deze specifieke stijl toepassen in elk onderdeel van je advies. Dit is geen suggestie.\n`;
    ctx += `\nKernfilosofie: ${primary.philosophy}\n`;
    if (primary.workflow_order && primary.workflow_order.length) {
      ctx += `\nBewerkingsvolgorde van ${photographerName}:\n`;
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
    if (primary.color_approach) {
      ctx += `\nKleurbenadering van ${photographerName}:\n${primary.color_approach}\n`;
    }
    if (primary.local_adjustments) {
      ctx += `\nLokale aanpassingen volgens ${photographerName}:\n${primary.local_adjustments}\n`;
    }
    if (primary.what_to_avoid && primary.what_to_avoid.length) {
      ctx += `\nUITDRUKKELIJK VERMIJDEN (${photographerName} vermijdt dit altijd):\n`;
      primary.what_to_avoid.forEach(w => ctx += `✗ ${w}\n`);
    }
    if (primary.unique_insights && primary.unique_insights.length) {
      ctx += `\nUnieke inzichten van ${photographerName} die je MOET verwerken:\n`;
      primary.unique_insights.forEach(ins => ctx += `★ ${ins}\n`);
    }
    ctx += `\n=== EINDE STIJL ${photographerName} ===\n`;
    ctx += `\nBelangrijk: Verwijs in je advies actief naar de bovenstaande technieken. `;
    ctx += `Geef adviezen die specifiek passen bij de bewerkingsfilosofie van ${photographerName}. `;
    ctx += `Een gebruiker moet na het lezen begrijpen dat dit advies gebaseerd is op een specifieke fotografenstijl.\n`;
  } else {
    // Geen specifieke fotograaf — gebruik relevante entries als richtlijnen
    ctx += `\n\nEXPERT STIJLRICHTLIJNEN — verwerk actief in je advies:\n`;
    relevant.forEach((entry, i) => {
      const label = `Expert ${i+1} (${(entry.genre||[]).join('/')})`;
      ctx += `\n[${label}]:\n`;
      ctx += `Filosofie: ${entry.philosophy}\n`;
      if (entry.techniques && entry.techniques.length) {
        entry.techniques.slice(0,2).forEach(t => {
          ctx += `• ${t.name}: ${t.description}\n`;
        });
      }
      if (entry.unique_insights && entry.unique_insights.length) {
        ctx += `Kerninsight: ${entry.unique_insights[0]}\n`;
      }
      if (entry.what_to_avoid && entry.what_to_avoid.length) {
        ctx += `Vermijd: ${entry.what_to_avoid[0]}\n`;
      }
    });
    ctx += `\nPas bovenstaande filosofieën en technieken actief toe in je bewerkingsadvies.\n`;
  }

  // Aanvullende experts als er meerdere zijn
  if (photographerName && relevant.length > 1) {
    ctx += `\nAanvullende context:\n`;
    relevant.slice(1).forEach(entry => {
      if (entry.photographer_name) {
        ctx += `[${entry.photographer_name}]: ${entry.philosophy.substring(0,150)}...\n`;
      }
    });
  }

  return ctx;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { provider, parts, systemPrompt, maxTokens, photoContext } = req.body;
    if (!parts || !systemPrompt) return res.status(400).json({ error: 'Ontbrekende velden' });

    const knowledgeBase = await loadKnowledgeBase();
    let relevant = [];
    if (photoContext && photoContext.forcedEntry) {
      // Specifieke stijl gekozen: gebruik die als primair met _forced flag
      const forced = Object.assign({}, photoContext.forcedEntry, { _forced: true });
      const extra = selectRelevantKnowledge(
        knowledgeBase.filter(e => e.video_title !== forced.video_title),
        photoContext.genre, photoContext.mood, photoContext.light
      ).slice(0, 2);
      relevant = [forced, ...extra];
    } else if (photoContext) {
      relevant = selectRelevantKnowledge(knowledgeBase, photoContext.genre, photoContext.mood, photoContext.light);
    }
    const knowledgeContext = buildKnowledgeContext(relevant);
    const enhancedPrompt = systemPrompt + knowledgeContext;

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
    if (d.error) return res.status(400).json({ error: d.error.message });
    const text = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';

    return res.status(200).json({
      text,
      expertSources: relevant.length,
      knowledgeUsed: relevant.map(e => e.video_title)
    });

  } catch (err) {
    return res.status(500).json({ error: 'Server fout: ' + err.message });
  }
};
