export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { username, password } = req.body;
  const validUser = process.env.ADMIN_USERNAME;
  const validPass = process.env.ADMIN_PASSWORD;
  const secret = process.env.ADMIN_SECRET || 'snood-secret-2025';

  if (!validUser || !validPass) {
    return res.status(500).json({ error: 'Admin credentials not configured' });
  }

  if (username === validUser && password === validPass) {
    // Simple token: base64(username:timestamp:secret_hash)
    const timestamp = Date.now();
    const token = Buffer.from(`${username}:${timestamp}:${secret}`).toString('base64');
    return res.status(200).json({ 
      success: true, 
      token,
      username,
      message: 'Login succesvol'
    });
  }

  return res.status(401).json({ error: 'Gebruikersnaam of wachtwoord onjuist' });
}
