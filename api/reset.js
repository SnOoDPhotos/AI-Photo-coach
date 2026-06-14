// api/reset.js — wachtwoord reset via Resend e-mail
const crypto = require('crypto');

// ── Redis helpers ──────────────────────────────────────────────────────────
async function kv(...args) {
  const url   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN  || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('KV niet geconfigureerd');
  const r = await fetch(url, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(args)
  });
  const d = await r.json();
  if (d.error) throw new Error('Redis: ' + d.error);
  return d.result;
}
const kvSet = (k, v, ex) => ex ? kv('SET', k, JSON.stringify(v), 'EX', ex) : kv('SET', k, JSON.stringify(v));
const kvGet = async (k) => { const r = await kv('GET', k); return r ? JSON.parse(r) : null; };
const kvDel = (k) => kv('DEL', k);

function hashPassword(password) {
  const secret = process.env.ADMIN_SECRET || 'snood-secret-2025';
  return crypto.createHmac('sha256', secret).update(password).digest('hex');
}

// ── Reset token genereren (random hex, 1 uur geldig) ──────────────────────
function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ── E-mail sturen via Resend ───────────────────────────────────────────────
async function sendResetEmail(email, token, appUrl) {
  const resetUrl = `${appUrl}/reset-password.html?token=${token}&email=${encodeURIComponent(email)}`;
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) throw new Error('RESEND_API_KEY niet geconfigureerd');

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'SNOOD Photo Coach <onboarding@resend.dev>',
      to: [email],
      subject: 'Wachtwoord resetten — SNOOD Photo Coach',
      html: `
        <div style="font-family:monospace;max-width:480px;margin:0 auto;background:#0d0d0d;color:#e8e0d4;padding:32px;border-left:3px solid #e8c547">
          <img src="https://snoodphotos.com/logo.png" style="height:48px;margin-bottom:24px" alt="SNOOD Photography">
          <h2 style="font-family:sans-serif;color:#e8c547;letter-spacing:3px;font-size:18px;margin-bottom:8px">WACHTWOORD RESETTEN</h2>
          <p style="color:#9e9690;font-size:13px;line-height:1.6;margin-bottom:24px">
            Je hebt een wachtwoord reset aangevraagd voor je SNOOD Photo Coach account.<br>
            Klik op de knop hieronder om een nieuw wachtwoord in te stellen.
          </p>
          <a href="${resetUrl}" style="display:inline-block;background:#e8c547;color:#0d0d0d;padding:14px 28px;text-decoration:none;font-family:monospace;font-size:13px;letter-spacing:2px;font-weight:bold">
            NIEUW WACHTWOORD INSTELLEN
          </a>
          <p style="color:#6b6762;font-size:11px;margin-top:24px;line-height:1.6">
            Deze link is 1 uur geldig. Als je geen reset hebt aangevraagd, kun je deze e-mail negeren.<br>
            Of kopieer deze link: <span style="color:#e8c547">${resetUrl}</span>
          </p>
          <p style="color:#6b6762;font-size:10px;margin-top:16px;border-top:1px solid #1a1a1a;padding-top:16px">
            SNOOD Photography · photocoach.snoodphotos.com
          </p>
        </div>
      `
    })
  });

  const d = await r.json();
  if (d.statusCode && d.statusCode >= 400) throw new Error(d.message || 'E-mail versturen mislukt');
  return d;
}

// ── Handler ────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body || {};

  try {

    // ── RESET AANVRAGEN ────────────────────────────────────────────────
    if (action === 'request') {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: 'E-mailadres vereist' });

      const user = await kvGet(`user:${email.toLowerCase()}`);

      // Altijd hetzelfde antwoord om e-mailadressen niet te lekken
      if (!user) {
        return res.status(200).json({ success: true, message: 'Als dit e-mailadres bekend is, ontvang je een reset link.' });
      }

      // Genereer token en sla op in Redis (1 uur geldig = 3600 seconden)
      const token = generateResetToken();
      await kvSet(`reset:${token}`, { email: email.toLowerCase(), createdAt: Date.now() }, 3600);

      // Bepaal app URL
      const appUrl = req.headers.origin || req.headers.referer?.replace(/\/$/, '') || 'https://photocoach.snoodphotos.com';
      const baseUrl = appUrl.replace(/\/[^/]*$/, ''); // verwijder pad indien aanwezig

      await sendResetEmail(email.toLowerCase(), token, baseUrl);

      return res.status(200).json({ success: true, message: 'Als dit e-mailadres bekend is, ontvang je een reset link.' });
    }

    // ── RESET UITVOEREN ────────────────────────────────────────────────
    if (action === 'confirm') {
      const { token, email, password } = req.body;
      if (!token || !email || !password) return res.status(400).json({ error: 'Token, e-mail en nieuw wachtwoord vereist' });
      if (password.length < 8) return res.status(400).json({ error: 'Wachtwoord minimaal 8 tekens' });

      // Haal token op uit Redis
      const resetData = await kvGet(`reset:${token}`);
      if (!resetData) return res.status(400).json({ error: 'Reset link is ongeldig of verlopen. Vraag een nieuwe aan.' });
      if (resetData.email !== email.toLowerCase()) return res.status(400).json({ error: 'Reset link klopt niet bij dit e-mailadres.' });

      // Haal gebruiker op en update wachtwoord
      const user = await kvGet(`user:${email.toLowerCase()}`);
      if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden.' });

      user.passwordHash = hashPassword(password);
      await kvSet(`user:${email.toLowerCase()}`, user);

      // Verwijder gebruikte reset token
      await kvDel(`reset:${token}`);

      return res.status(200).json({ success: true, message: 'Wachtwoord succesvol gewijzigd. Je kunt nu inloggen.' });
    }

    return res.status(400).json({ error: 'Onbekende actie' });

  } catch (err) {
    console.error('[reset.js]', err.message);
    return res.status(500).json({ error: 'Server fout: ' + err.message });
  }
};
