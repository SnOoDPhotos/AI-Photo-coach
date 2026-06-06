import knowledgeBase from '../knowledge-base.json' assert { type: 'json' };

function selectRelevantKnowledge(photoGenre, photoMood, photoLight) {
  const scores = knowledgeBase.map(entry => {
    let score = 0;
    // Genre match
    if (photoGenre && entry.genre) {
      const genreMatch = entry.genre.some(g => 
        photoGenre.toLowerCase().includes(g.toLowerCase()) || 
        g.toLowerCase().includes(photoGenre.toLowerCase())
      );
      if (genreMatch) score += 3;
    }
    // Mood match
    if (photoMood && entry.mood) {
      const moodMatch = entry.mood.some(m => 
        photoMood.toLowerCase().includes(m.toLowerCase())
      );
      if (moodMatch) score += 2;
    }
    // Light match
    if (photoLight && entry.light_conditions) {
      const lightMatch = entry.light_conditions.some(l => 
        photoLight.toLowerCase().includes(l.toLowerCase())
      );
      if (lightMatch) score += 2;
    }
    return { entry, score };
  });

  // Return top 3 most relevant entries
  return scores
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(s => s.entry);
}

function buildKnowledgeContext(relevant) {
  if (!relevant.length) return '';
  
  let context = '\n\nEXPERT KENNISBANK - gebruik deze professionele inzichten om je adviezen te verrijken:\n';
  
  relevant.forEach((entry, i) => {
    context += `\n[Expert ${i+1} - ${entry.genre?.join('/')}]:\n`;
    context += `Filosofie: ${entry.philosophy}\n`;
    
    if (entry.techniques?.length) {
      const topTechniques = entry.techniques.slice(0, 3);
      context += 'Technieken:\n';
      topTechniques.forEach(t => {
        context += `- ${t.name}: ${t.description} (gebruik bij: ${t.when_to_use})\n`;
      });
    }
    
    if (entry.unique_insights?.length) {
      context += `Unieke inzichten: ${entry.unique_insights.slice(0, 2).join('. ')}\n`;
    }
    
    if (entry.what_to_avoid?.length) {
      context += `Vermijd: ${entry.what_to_avoid.slice(0, 2).join(', ')}\n`;
    }
  });
  
  context += '\nPas deze inzichten toe waar relevant voor de foto, maar forceer niets.\n';
  return context;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { provider, parts, systemPrompt, maxTokens, photoContext } = req.body;
    if (!parts || !systemPrompt) return res.status(400).json({ error: 'Ontbrekende velden' });

    // Select relevant knowledge based on photo context
    const relevant = photoContext 
      ? selectRelevantKnowledge(photoContext.genre, photoContext.mood, photoContext.light)
      : [];

    const knowledgeContext = buildKnowledgeContext(relevant);
    const enhancedPrompt = systemPrompt + knowledgeContext;

    let text = '';
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) return res.status(500).json({ error: 'API key niet geconfigureerd' });

    // Default to Gemini for expert version
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
    text = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';

    return res.status(200).json({ 
      text,
      expertSources: relevant.length,
      knowledgeUsed: relevant.map(e => e.video_title)
    });

  } catch (err) {
    return res.status(500).json({ error: 'Server fout: ' + err.message });
  }
}
