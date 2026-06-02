import fs from 'fs';
import path from 'path';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // 1. Haal de variabelen op uit de request body (inclusief de nieuwe genre en tags)
    let { provider, parts, systemPrompt, maxTokens, genre, tags } = req.body;
    if (!parts || !systemPrompt) return res.status(400).json({ error: 'Ontbrekende velden' });

    // 2. EXPORT MATCH ENGINE: Pas de systeemprompt aan als er een genre en tags zijn meegegeven
    if (genre && tags && Array.isArray(tags)) {
      try {
        const jsonPath = path.join(process.cwd(), 'photo_coach_workflows.json');
        if (fs.existsSync(jsonPath)) {
          const fileData = fs.readFileSync(jsonPath, 'utf8');
          const workflowDatabase = JSON.parse(fileData);

          const expertList = workflowDatabase.genres[genre]?.experts || [];
          let bestExpert = null;
          let highestScore = -1;

          expertList.forEach(expert => {
            const matches = expert.trigger_tags.filter(tag => tags.includes(tag)).length;
            if (matches > highestScore) {
              highestScore = matches;
              bestExpert = expert;
            }
          });

          // Fallback naar de eerste expert van het genre als er geen specifieke tag-match is
          if (!bestExpert && expertList.length > 0) {
            bestExpert = expertList[0];
          }

          if (bestExpert) {
            // Breid de binnenkomende systemPrompt dynamisch uit met de expert-data
            systemPrompt += `\n\n[SNOOD ENGINE CONFIGURATION]
De backend heeft de specifieke nabewerkingsfilosofie van expert '${bestExpert.name}' geselecteerd (Stijl: ${bestExpert.focus}). Dit is jouw strikte bron van waarheid voor de technische sliders, maskers en kleurbehandeling.

Gebruik deze JSON-instructies dwingend om je advies op te bouwen:
${JSON.stringify(bestExpert.workflow, null, 2)}

Sluit je advies ALTIJD af met een apart, ongewijzigd blok genaamd 'Pro Insight' waarin je de volgende filosofie op een inspirerende manier uitlegt:
"${bestExpert.pro_insight}"`;
          }
        }
      } catch (jsonErr) {
        console.error("Fout bij het verwerken van photo_coach_workflows.json:", jsonErr);
        // De code gaat gewoon door met de originele systeemprompt als de JSON faalt
      }
    }

    let text = '';

    if (provider === 'gemini') {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'Gemini API key niet geconfigureerd' });
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts }],
          generationConfig: { maxOutputTokens: maxTokens || 8192 }
        })
      });
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message });
      text = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';

    } else if (['claude', 'claude-opus', 'claude-haiku'].includes(provider)) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'Claude API key niet geconfigureerd' });
      const models = { claude: 'claude-sonnet-4-6', 'claude-opus': 'claude-opus-4-6', 'claude-haiku': 'claude-haiku-4-5-20251001' };
      const cp = parts.map(p => {
        if (p.inline_data) return { type: 'image', source: { type: 'base64', media_type: p.inline_data.mime_type, data: p.inline_data.data } };
        if (p.text) return { type: 'text', text: p.text };
      }).filter(Boolean);
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: models[provider], max_tokens: maxTokens || 8192, system: systemPrompt, messages: [{ role: 'user', content: cp }] })
      });
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message });
      text = d.content?.map(b => b.text || '').join('') || '';

    } else if (['gpt4o', 'gpt4o-mini'].includes(provider)) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'OpenAI API key niet geconfigureerd' });
      const models = { gpt4o: 'gpt-4o', 'gpt4o-mini': 'gpt-4o-mini' };
      const oc = parts.map(p => {
        if (p.inline_data) return { type: 'image_url', image_url: { url: `data:${p.inline_data.mime_type};base64,${p.inline_data.data}` } };
        if (p.text) return { type: 'text', text: p.text };
      }).filter(Boolean);
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: models[provider], max_tokens: maxTokens || 8192, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: mc = oc }] }) // herstel typo van origineel
      });
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message });
      text = d.choices?.[0]?.message?.content || '';

    } else if (provider === 'pixtral') {
      const apiKey = process.env.MISTRAL_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'Mistral API key niet geconfigureerd' });
      const mc = parts.map(p => {
        if (p.inline_data) return { type: 'image_url', image_url: { url: `data:${p.inline_data.mime_type};base64,${p.inline_data.data}` } };
        if (p.text) return { type: 'text', text: p.text };
      }).filter(Boolean);
      const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'pixtral-large-latest', max_tokens: maxTokens || 8192, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: mc }] })
      });
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message });
      text = d.choices?.[0]?.message?.content || '';

    } else if (provider === 'groq') {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'Groq API key niet geconfigureerd' });
      const gc = parts.map(p => {
        if (p.inline_data) return { type: 'image_url', image_url: { url: `data:${p.inline_data.mime_type};base64,${p.inline_data.data}` } };
        if (p.text) return { type: 'text', text: p.text };
      }).filter(Boolean);
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'meta-llama/llama-4-scout-17b-16e-instruct', max_tokens: maxTokens || 8192, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: gc }] })
      });
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message });
      text = d.choices?.[0]?.message?.content || '';

    } else if (provider === 'siliconflow') {
      const apiKey = process.env.SILICONFLOW_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'SiliconFlow API key niet geconfigureerd' });
      const sc = parts.map(p => {
        if (p.inline_data) return { type: 'image_url', image_url: { url: `data:${p.inline_data.mime_type};base64,${p.inline_data.data}` } };
        if (p.text) return { type: 'text', text: p.text };
      }).filter(Boolean);
      const r = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'Qwen/Qwen3-VL-32B-Instruct', max_tokens: maxTokens || 8192, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: sc }] })
      });
      const d = await r.json();
      if (d.error) return res.status(400).json({ error: d.error.message });
      text = d.choices?.[0]?.message?.content || '';

    } else {
      return res.status(400).json({ error: 'Onbekende provider: ' + provider });
    }

    return res.status(200).json({ text });

  } catch (err) {
    return res.status(500).json({ error: 'Server fout: ' + err.message });
  }
}