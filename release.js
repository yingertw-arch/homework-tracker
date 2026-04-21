/**
 * release.js — 自動發布腳本
 * 用法：node release.js
 * 功能：① 找到打包好的 .exe ② 上傳到 Google Drive ③ 更新 Firebase 版本資訊
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const https = require('https');
const http = require('http');

// ══════════════════════════════════════════
//  設定區（你可以修改這裡）
// ══════════════════════════════════════════
const DRIVE_FOLDER_ID = '1Q27fK4jWmW4eRsUCtglHGA0-NlRH0KHn'; // 你的 Google Drive 資料夾 ID
const INSTALLER_DIR   = 'C:/Users/HSPS/Desktop/homework-installer';
const CREDENTIALS_FILE = path.join(__dirname, 'google-credentials.json'); // OAuth2 憑證檔
const TOKEN_FILE       = path.join(__dirname, 'google-token.json');        // 儲存授權 token

// Firebase 設定（更新版本資訊用）
const FIREBASE_PROJECT_ID = 'homework-tracker-5c6d3';
const FIREBASE_API_KEY    = 'AIzaSyBhLCqXSgF7pXAcSXkE3cIvLFn9x8nHJRs'; // 你的 Firebase API key

// ══════════════════════════════════════════

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

async function authorize() {
  if (!fs.existsSync(CREDENTIALS_FILE)) {
    console.error('\n❌ 找不到 google-credentials.json');
    console.error('請依照以下步驟取得憑證：');
    console.error('1. 前往 https://console.cloud.google.com/');
    console.error('2. 建立專案 → 啟用 Google Drive API');
    console.error('3. 建立 OAuth 2.0 用戶端 ID（桌面應用程式）');
    console.error('4. 下載 JSON 並改名為 google-credentials.json 放在此資料夾');
    process.exit(1);
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_FILE));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(TOKEN_FILE)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_FILE));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
  }

  // 第一次使用：啟動本機伺服器自動接收授權碼
  const { exec } = require('child_process');
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost:3000');
      const code = u.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>✅ 授權成功！請關閉此視窗，回到終端機繼續。</h2>');
      server.close();
      if (code) resolve(code);
      else reject(new Error('未收到授權碼'));
    });
    server.listen(3000, () => {
      const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline', scope: SCOPES,
        redirect_uri: 'http://localhost:3000'
      });
      console.log('\n🔐 瀏覽器即將開啟，請登入並授權...\n');
      exec(`start "" "${authUrl}"`);
    });
    server.on('error', reject);
  });

  const { tokens } = await oAuth2Client.getToken({ code, redirect_uri: 'http://localhost:3000' });
  oAuth2Client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens));
  console.log('✅ 授權成功，已儲存 token');
  return oAuth2Client;
}

async function findExe() {
  const files = fs.readdirSync(INSTALLER_DIR).filter(f => f.endsWith('.exe'));
  if (!files.length) throw new Error('找不到 .exe 安裝檔，請先執行 npm run build');
  // 取最新修改的
  files.sort((a, b) => {
    const ta = fs.statSync(path.join(INSTALLER_DIR, a)).mtimeMs;
    const tb = fs.statSync(path.join(INSTALLER_DIR, b)).mtimeMs;
    return tb - ta;
  });
  return path.join(INSTALLER_DIR, files[0]);
}

async function uploadToDrive(auth, filePath) {
  const drive = google.drive({ version: 'v3', auth });
  const fileName = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;

  console.log(`\n📤 上傳中：${fileName} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);

  // 刪除同名舊檔
  const existing = await drive.files.list({
    q: `name='${fileName}' and '${DRIVE_FOLDER_ID}' in parents and trashed=false`,
    fields: 'files(id,name)'
  });
  for (const f of existing.data.files || []) {
    await drive.files.delete({ fileId: f.id });
    console.log(`  🗑 已刪除舊版：${f.name}`);
  }

  // 上傳新檔
  let uploaded = 0;
  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [DRIVE_FOLDER_ID] },
    media: { mimeType: 'application/octet-stream', body: fs.createReadStream(filePath) },
    fields: 'id,name,webContentLink'
  }, {
    onUploadProgress: e => {
      const pct = Math.round((e.bytesRead / fileSize) * 100);
      if (pct !== uploaded) { uploaded = pct; process.stdout.write(`\r  進度：${pct}%   `); }
    }
  });
  console.log('\n✅ 上傳完成');

  // 設為公開可下載
  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: { role: 'reader', type: 'anyone' }
  });

  const downloadUrl = `https://drive.usercontent.google.com/download?id=${res.data.id}&export=download&confirm=t`;
  console.log(`  🔗 下載連結：${downloadUrl}`);
  return { fileId: res.data.id, downloadUrl, fileName };
}

async function updateFirebaseVersion(version, downloadUrl, fileName) {
  const body = JSON.stringify({
    fields: {
      version:     { stringValue: version },
      downloadUrl: { stringValue: downloadUrl },
      fileName:    { stringValue: fileName },
      notes:       { stringValue: '' }
    }
  });

  return new Promise((resolve, reject) => {
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/settings/appVersion?key=${FIREBASE_API_KEY}`;
    const req = https.request(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json')));
  const version = pkg.version;

  console.log(`\n🚀 作業缺交追蹤 v${version} 發布流程`);
  console.log('═'.repeat(40));

  // 1. 授權
  const auth = await authorize();

  // 2. 找 exe
  const exePath = await findExe();
  console.log(`\n📦 安裝檔：${path.basename(exePath)}`);

  // 3. 上傳
  const { downloadUrl, fileName } = await uploadToDrive(auth, exePath);

  // 4. 更新 Firebase
  console.log('\n🔥 更新 Firebase 版本資訊...');
  await updateFirebaseVersion(version, downloadUrl, fileName);
  console.log(`✅ Firebase 已更新：v${version}`);

  console.log('\n🎉 發布完成！App 下次啟動時會自動提示更新。\n');
}

main().catch(e => { console.error('\n❌ 錯誤：', e.message); process.exit(1); });
