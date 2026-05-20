#!/usr/bin/env node
/**
 * Probe Cursor usage APIs — run from cursor-daily-budget directory.
 */
const { execSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

function readToken() {
  const db = process.env.HOME + '/.config/Cursor/User/globalStorage/state.vscdb';
  const script = `
import sqlite3, json, base64
conn = sqlite3.connect("${db}")
cur = conn.cursor()
cur.execute("SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken'")
row = cur.fetchone()
raw = row[0]
payload = json.loads(base64.urlsafe_b64decode(raw.split('.')[1] + '=='))
uid = payload['sub'].split('|')[1]
print(json.dumps({"userId": uid, "jwt": raw, "session": uid + "%3A%3A" + raw}))
`;
  return JSON.parse(execSync(`python3 -c '${script.replace(/'/g, "'\"'\"'")}'`, { encoding: 'utf-8' }));
}

function req(url, headers, method = 'GET', body = null) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const opts = { hostname: u.hostname, path: u.pathname + u.search, method, headers };
    const r = https.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let parsed = d;
        try { parsed = JSON.parse(d); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: d.slice(0, 2000) });
      });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.message }));
    r.setTimeout(12000, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (body) r.write(body);
    r.end();
  });
}

async function main() {
  const { userId, jwt, session } = readToken();
  const authVariants = [
    { Cookie: `WorkosCursorSessionToken=${session}` },
    { Cookie: `WorkosCursorSessionToken=${jwt}` },
    { Authorization: `Bearer ${jwt}` },
    { Authorization: `Bearer ${session}` },
    {
      Cookie: `WorkosCursorSessionToken=${session}`,
      Authorization: `Bearer ${jwt}`,
    },
  ];

  const urls = [
    `https://cursor.com/api/usage?user=${userId}`,
    `https://cursor.com/api/usage-summary`,
    `https://cursor.com/api/usage-summary?user=${userId}`,
    `https://www.cursor.com/api/usage-summary`,
    `https://cursor.com/api/dashboard/usage`,
    `https://cursor.com/api/dashboard/get-user-analytics`,
    `https://cursor.com/api/dashboard/get-user-privacy-mode`,
    `https://cursor.com/api/auth/stripe`,
    `https://cursor.com/api/auth/me`,
    `https://cursor.com/api/auth/profile`,
    `https://cursor.com/api/billing/usage`,
    `https://cursor.com/api/billing/subscription`,
    `https://cursor.com/api/usage/limits`,
    `https://cursor.com/api/user/usage`,
    `https://api2.cursor.sh/auth/full_stripe_profile`,
    `https://api2.cursor.sh/auth/usage`,
    `https://api2.cursor.sh/aiserver.v1.AiService/GetUsage`,
  ];

  const out = [];
  for (const url of urls) {
    for (let i = 0; i < authVariants.length; i++) {
      const h = {
        ...authVariants[i],
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        Origin: 'https://cursor.com',
        Referer: 'https://cursor.com/dashboard',
        Accept: 'application/json',
      };
      const r = await req(url, h);
      if (r.status === 200 && r.body && typeof r.body === 'object') {
        out.push({ url, authIdx: i, status: r.status, body: r.body });
        console.log('OK', url, 'auth', i, JSON.stringify(r.body).slice(0, 500));
        break;
      }
      if (r.status && r.status !== 401 && r.status !== 404 && r.status !== 405) {
        console.log('?', url, 'auth', i, r.status, r.raw?.slice(0, 120));
      }
    }
  }

  fs.writeFileSync(
    path.join(__dirname, '../probe-results.json'),
    JSON.stringify(out, null, 2),
  );
  console.log('\nWrote', out.length, 'successful endpoints to probe-results.json');
}

main().catch(console.error);
