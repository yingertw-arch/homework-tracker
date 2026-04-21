/**
 * setup-web.js
 * 1. 啟用 Firebase Authentication Google 登入
 * 2. 部署 web/ 到 Firebase Hosting
 * 執行方式：node setup-web.js
 */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const zlib   = require('zlib');

const PROJECT_ID          = 'homework-tracker-5c6d3';
const SITE_ID             = 'homework-tracker-5c6d3';
const CREDENTIALS_PROJECT = '45420798788'; // OAuth 憑證所屬的 GCP 專案號碼
const CREDS               = JSON.parse(fs.readFileSync(path.join(__dirname, 'google-credentials.json'))).installed;
const TOKEN_FILE          = path.join(__dirname, 'firebase-token.json');

// ── OAuth ──
async function getToken() {
  if (fs.existsSync(TOKEN_FILE)) {
    const t = JSON.parse(fs.readFileSync(TOKEN_FILE));
    try {
      const refreshed = await refreshToken(t.refresh_token);
      fs.writeFileSync(TOKEN_FILE, JSON.stringify({ ...t, ...refreshed }));
      return refreshed.access_token;
    } catch(e) {
      console.log('Token refresh 失敗，重新授權...');
    }
  }
  return await authorize();
}

function refreshToken(rt) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id: CREDS.client_id, client_secret: CREDS.client_secret,
      refresh_token: rt, grant_type: 'refresh_token',
    }).toString();
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { const j = JSON.parse(d); if (j.error) reject(new Error(j.error)); else resolve(j); });
    });
    req.write(body); req.end();
  });
}

function authorize() {
  return new Promise((resolve, reject) => {
    const scope = encodeURIComponent(
      'https://www.googleapis.com/auth/firebase ' +
      'https://www.googleapis.com/auth/cloud-platform ' +
      'https://www.googleapis.com/auth/identitytoolkit'
    );
    const authUrl = `https://accounts.google.com/o/oauth2/auth?client_id=${CREDS.client_id}&redirect_uri=http://localhost:3001&response_type=code&scope=${scope}&access_type=offline&prompt=consent`;
    console.log('\n請在瀏覽器開啟以下網址授權：\n');
    console.log(authUrl + '\n');
    require('child_process').exec(`start "" "${authUrl}"`);
    const server = http.createServer(async (req, res) => {
      const code = new URL(req.url, 'http://localhost:3001').searchParams.get('code');
      if (!code) { res.end('Error'); return; }
      res.end('<h2>✅ 授權完成，請關閉此視窗</h2>');
      server.close();
      try { const token = await exchangeCode(code); fs.writeFileSync(TOKEN_FILE, JSON.stringify(token)); resolve(token.access_token); }
      catch(e) { reject(e); }
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
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { const j = JSON.parse(d); if (j.error) reject(new Error(j.error_description || j.error)); else resolve(j); });
    });
    req.write(body); req.end();
  });
}

// ── HTTP helper ──
function apiReq(hostname, method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request({
      hostname, path: urlPath, method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': data.length } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(raw), headers: res.headers }); }
        catch(e) { resolve({ status: res.statusCode, body: raw, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// 上傳二進位檔案（不使用 Content-Encoding 讓 Firebase 收到原始 gzip bytes）
function uploadFileRaw(uploadBaseUrl, hash, gzippedData, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(uploadBaseUrl + '/' + hash);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': gzippedData.length
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, body: raw });
      });
    });
    req.on('error', reject);
    req.write(gzippedData);
    req.end();
  });
}

// ── Enable APIs via Service Usage ──
async function enableApi(token, apiName, projectId) {
  const res = await apiReq(
    'serviceusage.googleapis.com', 'POST',
    `/v1/projects/${projectId}/services/${apiName}:enable`,
    token, {}
  );
  const ok = res.status === 200 || res.status === 204 || (res.body && (res.body.name || res.body.done));
  if (!ok) {
    console.log(`  ⚠️  啟用 ${apiName} 回應：`, res.status, JSON.stringify(res.body).slice(0, 150));
  }
  return ok;
}

// ── Enable Google Sign-in ──
async function enableGoogleSignIn(token) {
  console.log('\n🔐 設定 Google 登入...');

  // 先在憑證專案啟用 Identity Toolkit API
  await enableApi(token, 'identitytoolkit.googleapis.com', CREDENTIALS_PROJECT);
  await new Promise(r => setTimeout(r, 2000));

  // 嘗試 GET 現有設定
  const getRes = await apiReq(
    'identitytoolkit.googleapis.com', 'GET',
    `/admin/v2/projects/${PROJECT_ID}/defaultSupportedIdpConfigs/google.com`,
    token
  );

  if (getRes.status === 200) {
    if (getRes.body.enabled) {
      console.log('✅ Google 登入已啟用，略過');
      return;
    }
    // 已存在但未啟用 → PATCH
    const patchRes = await apiReq(
      'identitytoolkit.googleapis.com', 'PATCH',
      `/admin/v2/projects/${PROJECT_ID}/defaultSupportedIdpConfigs/google.com?updateMask=enabled`,
      token, { enabled: true }
    );
    if (patchRes.status === 200) { console.log('✅ Google 登入已啟用'); return; }
    console.log('⚠️  PATCH 回應：', patchRes.status, JSON.stringify(patchRes.body).slice(0, 200));
    return;
  }

  // 不存在 → POST 建立（帶 query param defaultSupportedIdpConfigId）
  const postRes = await apiReq(
    'identitytoolkit.googleapis.com', 'POST',
    `/admin/v2/projects/${PROJECT_ID}/defaultSupportedIdpConfigs?defaultSupportedIdpConfigId=google.com`,
    token,
    { enabled: true, clientId: CREDS.client_id, clientSecret: CREDS.client_secret }
  );

  if (postRes.status === 200) {
    console.log('✅ Google 登入已啟用');
  } else {
    // 最後嘗試：用 v1 API
    const v1Res = await apiReq(
      'identitytoolkit.googleapis.com', 'POST',
      `/v1/projects/${PROJECT_ID}:updateConfig`,
      token,
      { signIn: { google: { enabled: true } } }
    );
    if (v1Res.status === 200) {
      console.log('✅ Google 登入已啟用（v1）');
    } else {
      console.log('⚠️  Google 登入無法自動啟用，狀態碼：', postRes.status);
      console.log('   請手動到 Firebase Console → Authentication → Sign-in method → Google → 啟用');
    }
  }
}

// ── Firebase Hosting Deploy ──
async function deployHosting(token) {
  console.log('\n🚀 部署 Firebase Hosting...');

  const htmlPath = path.join(__dirname, 'web', 'index.html');
  const rawContent = fs.readFileSync(htmlPath);
  // Firebase Hosting 的 hash 是 gzip 後的 SHA256
  const gzipped = zlib.gzipSync(rawContent, { level: 9 });
  const fileHash = crypto.createHash('sha256').update(gzipped).digest('hex');

  // 確保 Firebase Hosting API 已在憑證專案啟用
  console.log('  🔧 啟用 Firebase Hosting API...');
  await enableApi(token, 'firebasehosting.googleapis.com', CREDENTIALS_PROJECT);
  await new Promise(r => setTimeout(r, 3000));

  // 1. 建立版本
  console.log('  📦 建立版本...');
  const createRes = await apiReq(
    'firebasehosting.googleapis.com', 'POST',
    `/v1beta1/sites/${SITE_ID}/versions`,
    token,
    { config: { rewrites: [{ glob: '**', path: '/index.html' }] } }
  );
  if (createRes.status !== 200) {
    console.error('  ❌ 建立版本失敗：', JSON.stringify(createRes.body).slice(0, 300));
    process.exit(1);
  }
  const versionName = createRes.body.name;
  const versionId   = versionName.split('/').pop();
  console.log('  ✅ 版本建立：', versionId);

  // 2. 列出需上傳的檔案
  console.log('  📋 清單比對...');
  const populateRes = await apiReq(
    'firebasehosting.googleapis.com', 'POST',
    `/v1beta1/sites/${SITE_ID}/versions/${versionId}:populateFiles`,
    token,
    { files: { '/index.html': fileHash } }
  );
  if (populateRes.status !== 200) {
    console.error('  ❌ 清單比對失敗：', JSON.stringify(populateRes.body).slice(0, 300));
    process.exit(1);
  }

  const uploadUrl  = populateRes.body.uploadUrl;
  const uploadList = populateRes.body.uploadRequiredHashes || [];

  // 3. 上傳需要的檔案（直接傳 gzip bytes，不加 Content-Encoding header）
  if (uploadList.includes(fileHash)) {
    console.log('  📤 上傳 index.html...');
    const uploadRes = await uploadFileRaw(uploadUrl, fileHash, gzipped, token);
    if (uploadRes.status !== 200) {
      console.error('  ❌ 上傳失敗：', uploadRes.status, uploadRes.body.slice(0, 200));
      process.exit(1);
    }
    console.log('  ✅ 上傳完成');
  } else {
    console.log('  ✅ 檔案無變更，略過上傳');
  }

  // 4. 完成版本
  console.log('  🔒 完成版本...');
  const finalizeRes = await apiReq(
    'firebasehosting.googleapis.com', 'PATCH',
    `/v1beta1/sites/${SITE_ID}/versions/${versionId}?updateMask=status`,
    token, { status: 'FINALIZED' }
  );
  if (finalizeRes.status !== 200) {
    console.error('  ❌ 完成版本失敗：', JSON.stringify(finalizeRes.body).slice(0, 300));
    process.exit(1);
  }

  // 5. 發布
  console.log('  🌐 發布...');
  const releaseRes = await apiReq(
    'firebasehosting.googleapis.com', 'POST',
    `/v1beta1/sites/${SITE_ID}/releases?versionName=${encodeURIComponent(versionName)}`,
    token, {}
  );
  if (releaseRes.status !== 200) {
    console.error('  ❌ 發布失敗：', JSON.stringify(releaseRes.body).slice(0, 300));
    process.exit(1);
  }

  console.log('\n🎉 部署完成！');
  console.log('  🔗 網址：https://' + SITE_ID + '.web.app');
}

// ── Main ──
async function main() {
  console.log('════════════════════════════════════════');
  console.log('  作業缺交追蹤 — 網頁版部署');
  console.log('════════════════════════════════════════');

  console.log('\n🔐 取得授權...');
  const token = await getToken();
  console.log('✅ 授權成功');

  await enableGoogleSignIn(token);
  await deployHosting(token);

  console.log('\n────────────────────────────────────────');
  console.log('📱 手機開啟以下網址即可使用：');
  console.log('   https://' + SITE_ID + '.web.app');
  console.log('────────────────────────────────────────\n');
}

main().catch(e => { console.error('\n❌ 錯誤：', e.message); process.exit(1); });
