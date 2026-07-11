// api/rollback.js — herstel index.html vanuit expert.html backup
const https = require('https');

function verifyAdminToken(token) {
  try {
    const secret = process.env.ADMIN_SECRET || 'snood-secret-2025';
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length < 3) return false;
    const ts = parseInt(parts[1]);
    if (Date.now() - ts > 7 * 24 * 60 * 60 * 1000) return false;
    return parts.slice(2).join(':') === secret;
  } catch(e) { return false; }
}

function githubRequest(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'SNOOD-PhotoCoach',
        'Content-Type': 'application/json',
        ...(data ? {'Content-Length': Buffer.byteLength(data)} : {})
      }
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => resolve(JSON.parse(raw)));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST vereist' });

  const { token } = req.body || {};
  if (!verifyAdminToken(token)) return res.status(403).json({ error: 'Geen toegang' });

  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return res.status(500).json({ error: 'GH_TOKEN niet geconfigureerd' });

  const repo = process.env.GH_REPO || 'SnOoDPhotos/AI-Photo-coach';
  const basePath = `/repos/${repo}/contents`;

  try {
    // Haal expert.html op (de backup)
    const expertData = await githubRequest('GET', `${basePath}/expert.html`, null, ghToken);
    if (!expertData.content) return res.status(404).json({ error: 'expert.html niet gevonden' });

    // Haal huidige SHA van index.html op
    const indexData = await githubRequest('GET', `${basePath}/index.html`, null, ghToken);
    const indexSha = indexData.sha;

    // Haal versienummer uit expert.html
    const expertContent = Buffer.from(expertData.content, 'base64').toString('utf8');
    const vMatch = expertContent.match(/v(\d+\.\d+\.\d+)/);
    const version = vMatch ? vMatch[1] : '?';

    // Schrijf expert.html terug als index.html
    await githubRequest('PUT', `${basePath}/index.html`, {
      message: `Rollback: index.html teruggezet naar backup v${version}`,
      content: expertData.content.replace(/\n/g, ''),
      sha: indexSha
    }, ghToken);

    return res.status(200).json({
      success: true,
      message: `Rollback geslaagd — index.html teruggezet naar v${version}. Wacht 2 minuten op deployment.`
    });
  } catch(e) {
    return res.status(500).json({ error: 'Rollback mislukt: ' + e.message });
  }
};
