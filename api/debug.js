// api/debug.js — tijdelijk debug endpoint, NA TESTEN VERWIJDEREN
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const url   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN  || process.env.UPSTASH_REDIS_REST_TOKEN;

  const results = {
    envVars: {
      KV_REST_API_URL:    process.env.KV_REST_API_URL    ? 'SET' : 'MISSING',
      KV_REST_API_TOKEN:  process.env.KV_REST_API_TOKEN  ? 'SET' : 'MISSING',
      UPSTASH_REDIS_REST_URL:   process.env.UPSTASH_REDIS_REST_URL   ? 'SET' : 'MISSING',
      UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN ? 'SET' : 'MISSING',
      ADMIN_SECRET: process.env.ADMIN_SECRET ? 'SET' : 'MISSING',
      ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'MISSING',
    },
    urlUsed: url ? url.substring(0, 40) + '...' : 'NONE',
    tests: {}
  };

  if (!url || !token) {
    return res.status(200).json({ error: 'Geen KV credentials', results });
  }

  try {
    // Test 1: PING
    const ping = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['PING'])
    });
    results.tests.ping = await ping.json();

    // Test 2: SMEMBERS users:all
    const members = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SMEMBERS', 'users:all'])
    });
    results.tests.usersAll = await members.json();

    // Test 3: SMEMBERS users:pending
    const pending = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SMEMBERS', 'users:pending'])
    });
    results.tests.usersPending = await pending.json();

    // Test 4: als er emails zijn, haal eerste user op
    const emails = results.tests.usersAll.result;
    if (Array.isArray(emails) && emails.length > 0) {
      const userGet = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['GET', `user:${emails[0]}`])
      });
      const userData = await userGet.json();
      results.tests.firstUser = {
        key: `user:${emails[0]}`,
        raw: userData.result ? userData.result.substring(0, 100) + '...' : null
      };
    }

  } catch (e) {
    results.tests.error = e.message;
  }

  return res.status(200).json(results);
};
