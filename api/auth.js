module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { username, password } = req.body;
    const validUser = process.env.ADMIN_USERNAME;
    const validPass = process.env.ADMIN_PASSWORD;
    const secret = process.env.ADMIN_SECRET || 'snood-secret-2025';

    if (!validUser || !validPass) {
      return res.status(500).json({ error: 'Admin credentials niet geconfigureerd in Vercel' });
    }

    if (username === validUser && password === validPass) {
      const timestamp = Date.now();
      const token = Buffer.from(`${username}:${timestamp}:${secret}`).toString('base64');
      return res.status(200).json({ success: true, token, username });
    }

    return res.status(401).json({ error: 'Gebruikersnaam of wachtwoord onjuist' });
  } catch (err) {
    return res.status(500).json({ error: 'Server fout: ' + err.message });
  }
};
