const { kv } = require('@vercel/kv');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'POST') {
      const { photographer, style, genre, rating, comment } = req.body;
      if (!photographer || !style || !genre || !rating) {
        return res.status(400).json({ error: 'Ontbrekende velden' });
      }

      const key = `rating:${photographer}:${style}:${genre}`.toLowerCase().replace(/[^a-z0-9:]/g, '_');
      const existing = await kv.get(key) || { total: 0, count: 0, comments: [] };

      existing.total += parseInt(rating);
      existing.count += 1;
      existing.avg = Math.round((existing.total / existing.count) * 10) / 10;
      if (comment && comment.trim()) {
        existing.comments.push({ text: comment.trim(), date: new Date().toISOString().split('T')[0] });
        if (existing.comments.length > 50) existing.comments = existing.comments.slice(-50);
      }

      await kv.set(key, existing);
      return res.status(200).json({ success: true, avg: existing.avg, count: existing.count });

    } else if (req.method === 'GET') {
      const { photographer, style, genre } = req.query;
      if (!photographer || !style || !genre) {
        // Return all ratings for admin
        const keys = await kv.keys('rating:*');
        const all = {};
        for (const k of keys) {
          all[k] = await kv.get(k);
        }
        return res.status(200).json(all);
      }

      const key = `rating:${photographer}:${style}:${genre}`.toLowerCase().replace(/[^a-z0-9:]/g, '_');
      const data = await kv.get(key) || { avg: 0, count: 0 };
      return res.status(200).json(data);
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
