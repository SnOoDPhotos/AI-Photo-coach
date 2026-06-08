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
  let ctx = '\n\nEXPERT KENNISBANK - gebruik deze professionele inzichten:\n';
  relevant.forEach((entry, i) => {
    const label = entry.photographer_name
      ? `${entry.photographer_name} - ${(entry.genre||[]).join('/')}`
      : (entry.genre||[]).join('/');
    ctx += `\n[Expert ${i+1} - ${label}]:\n`;
    ctx += `Filosofie: ${entry.philosophy}\n`;
    if (entry.techniques && entry.techniques.length) {
      entry.techniques.slice(0,3).forEach(t => {
        ctx += `- ${t.name}: ${t.description} (bij: ${t.when_to_use})\n`;
      });
    }
    if (entry.unique_insights && entry.unique_insights.length) {
      ctx += `Inzichten: ${entry.unique_insights.slice(0,2).join('. ')}\n`;
    }
    if (entry.what_to_avoid && entry.what_to_avoid.length) {
      ctx += `Vermijd: ${entry.what_to_avoid.slice(0,2).join(', ')}\n`;
    }
  });
  ctx += '\nPas toe waar relevant, forceer niets.\n';
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

    const knowledgeBase = loadKnowledgeBase();
    let relevant = [];
    if (photoContext && photoContext.forcedEntry) {
      // Admin heeft een specifieke stijl gekozen: die staat voorop
      relevant = [photoContext.forcedEntry];
      // Vul aan met andere relevante entries (max 2 extra)
      const extra = selectRelevantKnowledge(
        knowledgeBase.filter(e => e.video_title !== photoContext.forcedEntry.video_title),
        photoContext.genre, photoContext.mood, photoContext.light
      ).slice(0, 2);
      relevant = relevant.concat(extra);
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
