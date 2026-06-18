// api/auth.js — admin login + token validatie
const crypto = require('crypto');

function generateAdminToken(username) {
  const secret = process.env.ADMIN_SECRET || 'snood-secret-2025';
  const ts = Date.now();
  return Buffer.from(`${username}:${ts}:${secret}`).toString('base64');
}

function verifyAdminToken(token) {
  try {
    const secret = process.env.ADMIN_SECRET || 'snood-secret-2025';
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const [username, ts, ...rest] = decoded.split(':');
    if (rest.join(':') !== secret) return false;
    // 7 dagen geldig
    if (Date.now() - parseInt(ts) > 7 * 24 * 60 * 60 * 1000) return false;
    return username === process.env.ADMIN_USERNAME;
  } catch (e) {
    return false;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { username, password, token, validate } = req.body;

    // Token validatie
    if (validate && token) {
      const valid = verifyAdminToken(token);
      return res.status(200).json({ success: valid, valid });
    }

    const validUser = process.env.ADMIN_USERNAME;
    const validPass = process.env.ADMIN_PASSWORD;
    if (!validUser || !validPass) return res.status(500).json({ error: 'Admin credentials niet geconfigureerd' });

    if (username === validUser && password === validPass) {
      const adminToken = generateAdminToken(username);
      return res.status(200).json({ success: true, token: adminToken, username });
    }

    return res.status(401).json({ error: 'Gebruikersnaam of wachtwoord onjuist' });
  } catch (err) {
    return res.status(500).json({ error: 'Server fout: ' + err.message });
  }
};
