import knowledgeBase from '../knowledge-base.json' assert { type: 'json' };

function verifyToken(token) {
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    const [username, timestamp, secret] = decoded.split(':');
    const validSecret = process.env.ADMIN_SECRET || 'snood-secret-2025';
    // Token valid for 24 hours
    if (Date.now() - parseInt(timestamp) > 86400000) return false;
    return secret === validSecret && username === process.env.ADMIN_USERNAME;
  } catch { return false; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET - return knowledge base (public, for expert app)
  if (req.method === 'GET') {
    return res.status(200).json({
      total: knowledgeBase.length,
      entries: knowledgeBase.map(e => ({
        video_title: e.video_title,
        genre: e.genre,
        light_conditions: e.light_conditions,
        mood: e.mood,
        software: e.software,
        best_for: e.best_for
      }))
    });
  }

  // POST - add new entry (admin only)
  if (req.method === 'POST') {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!verifyToken(token)) {
      return res.status(401).json({ error: 'Niet ingelogd of sessie verlopen' });
    }

    const { action, entry } = req.body;

    if (action === 'validate') {
      // Validate entry structure
      const required = ['video_title', 'genre', 'techniques', 'philosophy'];
      const missing = required.filter(k => !entry[k]);
      if (missing.length > 0) {
        return res.status(400).json({ error: `Ontbrekende velden: ${missing.join(', ')}` });
      }
      return res.status(200).json({ valid: true, message: 'Entry is geldig' });
    }

    return res.status(200).json({ 
      message: 'Entry ontvangen. Voeg handmatig toe aan knowledge-base.json op GitHub.',
      entry 
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
