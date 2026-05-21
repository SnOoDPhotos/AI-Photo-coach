export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { provider, parts, systemPrompt, maxTokens } = req.body;

    if (!parts || !systemPrompt) {
      return res.status(400).json({ error: 'Ontbrekende velden: parts en systemPrompt zijn verplicht' });
    }

    let text = '';

    // ── Gemini ──────────────────────────────────────────────────────────────
    if (provider === 'gemini') {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'Gemini API key niet geconfigureerd op server' });

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ parts }],
            generationConfig: { maxOutputTokens: maxTokens || 8192 }
          })
        }
      );

      const data = await response.json();
      if (data.error) return res.status(400).json({ error: data.error.message });
      text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';

    // ── Claude ──────────────────────────────────────────────────────────────
    } else if (provider === 'claude' || provider === 'claude-opus' || provider === 'claude-haiku') {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'Claude API key niet geconfigureerd op server' });

      const models = {
        claude: 'claude-sonnet-4-6',
        'claude-opus': 'claude-opus-4-6',
        'claude-haiku': 'claude-haiku-4-5-20251001'
      };

      // Convert Gemini-style parts to Anthropic format
      const claudeParts = parts.map(p => {
        if (p.inline_data) return {
          type: 'image',
          source: { type: 'base64', media_type: p.inline_data.mime_type, data: p.inline_data.data }
        };
        if (p.text) return { type: 'text', text: p.text };
        return null;
      }).filter(Boolean);

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: models[provider] || 'claude-sonnet-4-6',
          max_tokens: maxTokens || 8192,
          system: systemPrompt,
          messages: [{ role: 'user', content: claudeParts }]
        })
      });

      const data = await response.json();
      if (data.error) return res.status(400).json({ error: data.error.message });
      text = data.content?.map(b => b.text || '').join('') || '';

    // ── OpenAI ──────────────────────────────────────────────────────────────
    } else if (provider === 'gpt4o' || provider === 'gpt4o-mini') {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'OpenAI API key niet geconfigureerd op server' });

      const models = { gpt4o: 'gpt-4o', 'gpt4o-mini': 'gpt-4o-mini' };
      const openaiContent = parts.map(p => {
        if (p.inline_data) return { type: 'image_url', image_url: { url: `data:${p.inline_data.mime_type};base64,${p.inline_data.data}` } };
        if (p.text) return { type: 'text', text: p.text };
        return null;
      }).filter(Boolean);

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: models[provider],
          max_tokens: maxTokens || 8192,
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: openaiContent }]
        })
      });

      const data = await response.json();
      if (data.error) return res.status(400).json({ error: data.error.message });
      text = data.choices?.[0]?.message?.content || '';

    // ── Mistral ─────────────────────────────────────────────────────────────
    } else if (provider === 'pixtral') {
      const apiKey = process.env.MISTRAL_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'Mistral API key niet geconfigureerd op server' });

      const mistralContent = parts.map(p => {
        if (p.inline_data) return { type: 'image_url', image_url: { url: `data:${p.inline_data.mime_type};base64,${p.inline_data.data}` } };
        if (p.text) return { type: 'text', text: p.text };
        return null;
      }).filter(Boolean);

      const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'pixtral-large-latest',
          max_tokens: maxTokens || 8192,
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: mistralContent }]
        })
      });

      const data = await response.json();
      if (data.error) return res.status(400).json({ error: data.error.message });
      text = data.choices?.[0]?.message?.content || '';

    // ── Groq ────────────────────────────────────────────────────────────────
    } else if (provider === 'groq') {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'Groq API key niet geconfigureerd op server' });

      const groqContent = parts.map(p => {
        if (p.inline_data) return { type: 'image_url', image_url: { url: `data:${p.inline_data.mime_type};base64,${p.inline_data.data}` } };
        if (p.text) return { type: 'text', text: p.text };
        return null;
      }).filter(Boolean);

      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          max_tokens: maxTokens || 8192,
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: groqContent }]
        })
      });

      const data = await response.json();
      if (data.error) return res.status(400).json({ error: data.error.message });
      text = data.choices?.[0]?.message?.content || '';

    // ── SiliconFlow ──────────────────────────────────────────────────────────
    } else if (provider === 'siliconflow') {
      const apiKey = process.env.SILICONFLOW_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'SiliconFlow API key niet geconfigureerd op server' });

      const sfContent = parts.map(p => {
        if (p.inline_data) return { type: 'image_url', image_url: { url: `data:${p.inline_data.mime_type};base64,${p.inline_data.data}` } };
        if (p.text) return { type: 'text', text: p.text };
        return null;
      }).filter(Boolean);

      const response = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'Qwen/Qwen3-VL-32B-Instruct',
          max_tokens: maxTokens || 8192,
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: sfContent }]
        })
      });

      const data = await response.json();
      if (data.error) return res.status(400).json({ error: data.error.message });
      text = data.choices?.[0]?.message?.content || '';

    } else {
      return res.status(400).json({ error: 'Onbekende provider: ' + provider });
    }

    return res.status(200).json({ text });

  } catch (err) {
    console.error('API error:', err);
    return res.status(500).json({ error: 'Server fout: ' + err.message });
  }
}
