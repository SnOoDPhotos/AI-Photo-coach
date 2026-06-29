const { kv } = require('@vercel/kv');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  if (req.method === 'POST') {
    const { action, token, entries } = req.body || {};

    // Verify admin token
    const storedToken = await kv.get('admin_token');
    const storedTs = await kv.get('admin_token_ts');
    if (!storedToken || token !== storedToken || Date.now() - storedTs > 7 * 24 * 60 * 60 * 1000) {
      return res.status(401).json({ error: 'Geen toegang' });
    }

    if (action === 'generate_previews') {
      // Get all knowledge entries
      const kb = await kv.get('snood_knowledge') || [];
      let generated = 0;
      let skipped = 0;
      const errors = [];

      // Group by unique photographer+style to avoid duplicate calls
      const processed = new Set();

      // Process entries (passed from client, max 50 at a time)
      const toProcess = (entries || []).filter(e => !e.style_preview || e.style_preview.length < 10);

      await Promise.all(toProcess.map(async function(entry) {
        const key = (entry.photographer_name + '|' + entry.style_description).toLowerCase();
        if (processed.has(key)) { skipped++; return; }
        processed.add(key);

        try {
          const prompt = `Je bent een fotografie-expert. Schrijf een stijlomschrijving van 3-5 zinnen voor de bewerkingsstijl van fotograaf ${entry.photographer_name} (stijl: "${entry.style_description}").

Beschrijf op basis van deze informatie:
Filosofie: ${(entry.philosophy||'').slice(0,300)}
Beste voor: ${entry.best_for||''}
Genre: ${(entry.genre||[]).join(', ')}

Beschrijf: (1) de visuele sfeer en toon, (2) de kernfilosofie in gewone taal, (3) voor welk type foto en lichtomstandigheden deze stijl het beste werkt, (4) het verwachte visuele effect. Schrijf vanuit het perspectief van een fotograaf die overweegt deze stijl te gebruiken. Geen opsomming, gewone lopende tekst.`;

          const r = await fetch(\`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=\${GEMINI_API_KEY}\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: 400, temperature: 0.4 }
            })
          });
          const d = await r.json();
          const text = d.candidates?.[0]?.content?.parts?.map(p => p.text||'').join('').trim();
          if (text && text.length > 20) {
            // Update all entries with same photographer+style in KB
            let updatedKb = await kv.get('snood_knowledge') || [];
            updatedKb = updatedKb.map(function(e) {
              if ((e.photographer_name||'').toLowerCase() === (entry.photographer_name||'').toLowerCase() &&
                  (e.style_description||'').toLowerCase() === (entry.style_description||'').toLowerCase()) {
                return Object.assign({}, e, { style_preview: text });
              }
              return e;
            });
            await kv.set('snood_knowledge', updatedKb);
            generated++;
          }
        } catch(e) {
          errors.push(entry.photographer_name + ': ' + e.message);
        }
      }));

      return res.status(200).json({ success: true, generated, skipped, errors: errors.slice(0,5) });
    }
  }

  return res.status(400).json({ error: 'Ongeldig verzoek' });
};
