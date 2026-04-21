/**
 * fix-rules.js
 * 自動更新 Firestore 安全規則為允許所有讀寫
 * 執行方式：node fix-rules.js
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'homework-tracker-5c6d3';
const CREDS = JSON.parse(fs.readFileSync(path.join(__dirname, 'google-credentials.json'))).installed;
const TOKEN_FILE = path.join(__dirname, 'firebase-token.json');

// Firestore 安全規則內容（允許所有讀寫）
const RULES_SOURCE = `
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}
`.trim();

// ── OAuth 取得 token ──
async function getToken() {
  if (fs.existsSync(TOKEN_FILE)) {
    const t = JSON.parse(fs.readFileSync(TOKEN_FILE));
    // 嘗試 refresh
    try {
      const refreshed = await refreshToken(t.refresh_token);
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(refreshed));
      return refreshed.access_token;
    } catch(e) {
      console.log('Token refresh 失敗，重新授權...');
    }
  }
  return await authorize();
}

function refreshToken(refreshToken) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id: CREDS.client_id,
      client_secret: CREDS.client_secret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString();
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const json = JSON.parse(d);
        if (json.error) reject(new Error(json.error));
        else resolve(json);
      });
    });
    req.write(body); req.end();
  });
}

function authorize() {
  return new Promise((resolve, reject) => {
    const scope = encodeURIComponent('https://www.googleapis.com/auth/firebase https://www.googleapis.com/auth/cloud-platform');
    const authUrl = `https://accounts.google.com/o/oauth2/auth?client_id=${CREDS.client_id}&redirect_uri=http://localhost:3001&response_type=code&scope=${scope}&access_type=offline&prompt=consent`;

    console.log('\n請在瀏覽器開啟以下網址授權：\n');
    console.log(authUrl + '\n');

    // 開啟瀏覽器
    require('child_process').exec(`start "" "${authUrl}"`);

    // 本地 server 接收授權碼
    const server = http.createServer(async (req, res) => {
      const code = new URL(req.url, 'http://localhost:3001').searchParams.get('code');
      if (!code) { res.end('Error'); return; }
      res.end('<h2>✅ 授權完成，請關閉此視窗</h2>');
      server.close();
      try {
        const token = await exchangeCode(code);
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(token));
        resolve(token.access_token);
      } catch(e) { reject(e); }
    });
    server.listen(3001);
  });
}

function exchangeCode(code) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      code, client_id: CREDS.client_id, client_secret: CREDS.client_secret,
      redirect_uri: 'http://localhost:3001', grant_type: 'authorization_code',
    }).toString();
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const json = JSON.parse(d);
        if (json.error) reject(new Error(json.error_description || json.error));
        else resolve(json);
      });
    });
    req.write(body); req.end();
  });
}

// ── Firebase Rules API ──
function apiRequest(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'firebaserules.googleapis.com',
      path,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch(e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  console.log('🔐 取得授權...');
  const token = await getToken();
  console.log('✅ 授權成功\n');

  // 1. 建立新 ruleset
  console.log('📝 建立新規則...');
  const createRes = await apiRequest('POST',
    `/v1/projects/${PROJECT_ID}/rulesets`,
    token,
    { source: { files: [{ name: 'firestore.rules', content: RULES_SOURCE }] } }
  );

  if (createRes.status !== 200) {
    console.error('建立規則失敗：', JSON.stringify(createRes.body, null, 2));
    process.exit(1);
  }

  const rulesetName = createRes.body.name;
  console.log('✅ 規則已建立：', rulesetName);

  // 2. 更新 release 指向新 ruleset
  console.log('🔄 套用規則...');
  const releaseRes = await apiRequest('PATCH',
    `/v1/projects/${PROJECT_ID}/releases/cloud.firestore`,
    token,
    { release: { name: `projects/${PROJECT_ID}/releases/cloud.firestore`, rulesetName } }
  );

  if (releaseRes.status !== 200) {
    console.error('套用規則失敗：', JSON.stringify(releaseRes.body, null, 2));
    process.exit(1);
  }

  console.log('\n🎉 Firestore 安全規則已更新！所有裝置現在都可以同步資料了。');
}

main().catch(e => { console.error('錯誤：', e.message); process.exit(1); });
