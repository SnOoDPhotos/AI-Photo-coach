// Helper: call Groq as fallback with vision
async function callGroqFallback(parts, systemPrompt, maxTokens) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const gc = parts.map(p => {
    if (p.inline_data) return { type: 'image_url', image_url: { url: `data:${p.inline_data.mime_type};base64,${p.inline_data.data}` } };
    if (p.text) return { type: 'text', text: p.text };
  }).filter(Boolean);

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      max_tokens: maxTokens || 8192,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: gc }]
    })
  });
  const d = await r.json();
  if (d.error) return null;
  return d.choices?.[0]?.message?.content || null;
}

// Check if error is Gemini quota/billing related
function isGeminiQuotaError(d) {
  const msg = d?.error?.message || '';
  return msg.includes('quota') || msg.includes('billing') || msg.includes('credits') ||
         msg.includes('RESOURCE_EXHAUSTED') || msg.includes('prepayment') || d?.error?.code === 429;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { provider, parts, systemPrompt, maxTokens } = req.body;
    if (!parts || !systemPrompt) return res.status(400).json({ error: 'Ontbrekende velden' });

    let text = '';
    let usedFallback = false;

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

      let geminiErrorDetail = null;

      // Fallback to Groq on quota/billing error
      if (d.error && isGeminiQuotaError(d)) {
        geminiErrorDetail = {
          message: d.error.message,
          code: d.error.code,
          status: d.error.status,
          details: d.error.details || null
        };
        const fallbackText = await callGroqFallback(parts, systemPrompt, maxTokens);
        if (fallbackText) {
          text = fallbackText;
          usedFallback = true;
        } else {
          return res.status(400).json({ error: d.error.message, geminiErrorDetail });
        }
      } else if (d.error) {
        return res.status(400).json({ error: d.error.message, geminiErrorRaw: d.error });
      } else {
        text = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      }

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
        body: JSON.stringify({ model: models[provider], max_tokens: maxTokens || 8192, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: oc }] })
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

    return res.status(200).json({ text, usedFallback, geminiErrorDetail: typeof geminiErrorDetail !== 'undefined' ? geminiErrorDetail : null });

  } catch (err) {
    return res.status(500).json({ error: 'Server fout: ' + err.message });
  }
};
