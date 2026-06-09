module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN  || process.env.UPSTASH_REDIS_REST_TOKEN;

  async function kv(...args) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    });
    return r.json();
  }

  const results = {};

  // Check knowledge:db key
  const kb = await kv('GET', 'knowledge:db');
  if (kb.result) {
    try {
      const parsed = JSON.parse(kb.result);
      results.knowledgeDb = Array.isArray(parsed)
        ? `${parsed.length} entries, eerste: ${parsed[0]?.video_title}`
        : 'geen array';
    } catch(e) {
      results.knowledgeDb = 'parse error: ' + e.message;
    }
  } else {
    results.knowledgeDb = 'LEEG of niet gevonden — result: ' + JSON.stringify(kb.result);
  }

  // Check what keys exist
  const keys = await kv('KEYS', 'knowledge*');
  results.knowledgeKeys = keys.result;

  return res.status(200).json(results);
};
