const fs = require('fs');
const path = require('path');

function loadKnowledgeBase() {
  try {
    const filePath = path.join(process.cwd(), 'knowledge-base.json');
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch(e) {
    return [];
  }
}

function verifyToken(token) {
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    const parts = decoded.split(':');
    if (parts.length < 3) return false;
    const username = parts[0];
    const timestamp = parts[1];
    const secret = parts.slice(2).join(':');
    const validSecret = process.env.ADMIN_SECRET || 'snood-secret-2025';
    if (Date.now() - parseInt(timestamp) > 86400000) return false;
    return secret === validSecret && username === process.env.ADMIN_USERNAME;
  } catch { return false; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const kb = loadKnowledgeBase();
    return res.status(200).json({
      total: kb.length,
      entries: kb.map(e => ({
        video_title: e.video_title,
        genre: e.genre,
        light_conditions: e.light_conditions,
        mood: e.mood,
        techniques: e.techniques,
        philosophy: e.philosophy,
        unique_insights: e.unique_insights,
        what_to_avoid: e.what_to_avoid,
        best_for: e.best_for
      }))
    });
  }

  if (req.method === 'POST') {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!verifyToken(token)) {
      return res.status(401).json({ error: 'Niet ingelogd of sessie verlopen' });
    }
    const { action, entry } = req.body;
    if (action === 'validate') {
      const required = ['video_title', 'genre', 'techniques'];
      const missing = required.filter(k => !entry[k]);
      if (missing.length > 0) return res.status(400).json({ error: 'Ontbrekende velden: ' + missing.join(', ') });
      return res.status(200).json({ valid: true });
    }
    return res.status(200).json({ message: 'OK', entry });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
