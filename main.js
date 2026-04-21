const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain } = require('electron');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const { exec } = require('child_process');
const schedule = require('node-schedule');

let mainWindow = null;
let tray = null;
let scheduledJob = null;
let appIcon = null; // 共用圖示

// ── 單一執行個體 ──
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── 設定：每天幾點幾分自動開啟投影模式 ──
const AUTO_PROJECTOR_HOUR   = 7;  // 早上 7 點
const AUTO_PROJECTOR_MINUTE = 30; // 30 分
const AUTO_PROJECTOR_WEEKDAYS = '1-5'; // 週一到週五（改成 '*' 代表每天）

// ── 判斷現在是否在自動開啟的時間窗口內（±5分鐘）──
function isProjectorTime() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  return h === AUTO_PROJECTOR_HOUR && m <= AUTO_PROJECTOR_MINUTE + 5;
}

// ── 建立主視窗 ──
function createWindow(projectorMode = false) {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    if (projectorMode) enterProjectorMode();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 400,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    title: '作業缺交追蹤',
    icon: appIcon,
    autoHideMenuBar: true,
    show: false,
  });

  const indexPath = path.join(__dirname, 'index.html');
  const url = projectorMode
    ? `file://${indexPath}?projector=1`
    : `file://${indexPath}`;

  mainWindow.loadURL(url);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (projectorMode) {
      mainWindow.setFullScreen(true);
    }
  });

  mainWindow.on('close', (e) => {
    // 關閉時縮到系統匣，而不是直接離開
    e.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── 切換到投影模式 ──
function enterProjectorMode() {
  if (!mainWindow) { createWindow(true); return; }
  mainWindow.show();
  mainWindow.focus();
  mainWindow.setFullScreen(true);
  mainWindow.webContents.executeJavaScript('openProjectorMode && openProjectorMode()');
}

// ── 剪貼板圖示（透明背景 RGBA） ──
function createAppIcon() {
  const { deflateSync } = require('zlib');
  const S = 32;
  // RGBA colors
  const TR=[0,0,0,0];          // transparent (background)
  const BK=[15,15,15,255];     // near-black (clipboard border, clip)
  const WH=[255,255,255,255];  // white (clipboard body fill)
  const GY=[120,120,120,255];  // gray (text lines)
  const GN=[0,200,80,255];     // green (checkmark)

  const g = Array.from({length:S}, ()=>Array.from({length:S}, ()=>[...TR]));

  function rect(x1,y1,x2,y2,c) {
    for(let y=y1;y<=y2;y++) for(let x=x1;x<=x2;x++)
      if(y>=0&&y<S&&x>=0&&x<S) g[y][x]=[...c];
  }

  rect(6,7,25,28,WH);      // clipboard body (white fill)
  // black border around clipboard body
  for(let y=7;y<=28;y++){ g[y][6]=[...BK]; g[y][25]=[...BK]; }
  for(let x=6;x<=25;x++){ g[7][x]=[...BK]; g[28][x]=[...BK]; }
  rect(11,3,20,9,BK);      // clip top (black)
  rect(13,4,18,7,WH);      // clip hole (white)
  rect(9,12,22,13,GY);     // text line 1
  rect(9,16,22,17,GY);     // text line 2
  rect(9,20,18,21,GY);     // text line 3 (shorter)
  // checkmark (bottom right)
  [[21,23],[22,24],[23,25],[24,24],[25,23],[26,22]].forEach(([y,x])=>{ if(y<S&&x<S) g[y][x]=[...GN]; });
  [[22,23],[23,24],[24,25],[25,24],[26,23],[27,22]].forEach(([y,x])=>{ if(y<S&&x<S) g[y][x]=[...GN]; });

  const rowSize = 1 + S * 4; // filter byte + RGBA
  const raw = Buffer.alloc(rowSize * S);
  for(let y=0;y<S;y++){
    raw[y*rowSize]=0;
    for(let x=0;x<S;x++){
      const [r,gg,b,a]=g[y][x];
      raw[y*rowSize+1+x*4]=r; raw[y*rowSize+1+x*4+1]=gg; raw[y*rowSize+1+x*4+2]=b; raw[y*rowSize+1+x*4+3]=a;
    }
  }
  const idat=deflateSync(raw);
  const CRC=new Uint32Array(256);
  for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=(c&1)?0xEDB88320^(c>>>1):c>>>1;CRC[i]=c;}
  function crc32(buf){let c=0xFFFFFFFF;for(const b of buf)c=CRC[(c^b)&0xFF]^(c>>>8);return(c^0xFFFFFFFF)>>>0;}
  function mkchunk(type,data){
    const t=Buffer.from(type,'ascii'),lb=Buffer.alloc(4),td=Buffer.concat([t,data]),cb=Buffer.alloc(4);
    lb.writeUInt32BE(data.length);cb.writeUInt32BE(crc32(td));
    return Buffer.concat([lb,td,cb]);
  }
  const ihdr=Buffer.alloc(13);
  ihdr.writeUInt32BE(S,0);ihdr.writeUInt32BE(S,4);ihdr[8]=8;ihdr[9]=6; // color type 6 = RGBA
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),mkchunk('IHDR',ihdr),mkchunk('IDAT',idat),mkchunk('IEND',Buffer.alloc(0))]);
  return nativeImage.createFromBuffer(png);
}

// ── 產生 256x256 ICO 檔（三處圖示統一來源）──
function ensureIcon() {
  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  try {
    if (fs.existsSync(iconPath) && fs.statSync(iconPath).size > 50000) return;
    const assetsDir = path.join(__dirname, 'assets');
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

    const { deflateSync } = require('zlib');
    const S = 256, sm = 32, SCALE = 8;
    const TR=[0,0,0,0], BK=[15,15,15,255], WH=[255,255,255,255], GY=[120,120,120,255], GN=[0,200,80,255];
    const d = Array.from({length:sm}, ()=>Array.from({length:sm}, ()=>[...TR]));
    function dr(x1,y1,x2,y2,c){for(let y=y1;y<=y2;y++)for(let x=x1;x<=x2;x++)if(y>=0&&y<sm&&x>=0&&x<sm)d[y][x]=[...c];}
    dr(6,7,25,28,WH);
    for(let y=7;y<=28;y++){d[y][6]=[...BK];d[y][25]=[...BK];}
    for(let x=6;x<=25;x++){d[7][x]=[...BK];d[28][x]=[...BK];}
    dr(11,3,20,9,BK); dr(13,4,18,7,WH);
    dr(9,12,22,13,GY); dr(9,16,22,17,GY); dr(9,20,18,21,GY);
    [[21,23],[22,24],[23,25],[24,24],[25,23],[26,22]].forEach(([y,x])=>{if(y<sm&&x<sm)d[y][x]=[...GN];});
    [[22,23],[23,24],[24,25],[25,24],[26,23],[27,22]].forEach(([y,x])=>{if(y<sm&&x<sm)d[y][x]=[...GN];});

    const rowSize = 1 + S * 4;
    const raw = Buffer.alloc(rowSize * S);
    for(let y=0;y<S;y++){
      raw[y*rowSize]=0;
      const sy=Math.floor(y/SCALE);
      for(let x=0;x<S;x++){
        const sx=Math.floor(x/SCALE);
        const [r,g,b,a]=d[sy][sx];
        raw[y*rowSize+1+x*4]=r; raw[y*rowSize+1+x*4+1]=g; raw[y*rowSize+1+x*4+2]=b; raw[y*rowSize+1+x*4+3]=a;
      }
    }
    const idat=deflateSync(raw);
    const CRC=new Uint32Array(256);
    for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=(c&1)?0xEDB88320^(c>>>1):c>>>1;CRC[i]=c;}
    function crc32(buf){let c=0xFFFFFFFF;for(const b of buf)c=CRC[(c^b)&0xFF]^(c>>>8);return(c^0xFFFFFFFF)>>>0;}
    function mkchunk(type,data){const t=Buffer.from(type,'ascii'),lb=Buffer.alloc(4),td=Buffer.concat([t,data]),cb=Buffer.alloc(4);lb.writeUInt32BE(data.length);cb.writeUInt32BE(crc32(td));return Buffer.concat([lb,td,cb]);}
    const ihdr=Buffer.alloc(13);
    ihdr.writeUInt32BE(S,0);ihdr.writeUInt32BE(S,4);ihdr[8]=8;ihdr[9]=6;
    const pngData=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),mkchunk('IHDR',ihdr),mkchunk('IDAT',idat),mkchunk('IEND',Buffer.alloc(0))]);

    // 包成 ICO 格式（內嵌 PNG）
    const ico = Buffer.alloc(6 + 16 + pngData.length);
    ico.writeUInt16LE(0,0); ico.writeUInt16LE(1,2); ico.writeUInt16LE(1,4);
    ico[6]=0; ico[7]=0; ico[8]=0; ico[9]=0;
    ico.writeUInt16LE(1,10); ico.writeUInt16LE(32,12);
    ico.writeUInt32LE(pngData.length,14); ico.writeUInt32LE(22,18);
    pngData.copy(ico, 22);
    fs.writeFileSync(iconPath, ico);
  } catch(e) { console.error('ensureIcon failed:', e.message); }
}

// ── 系統匣圖示 ──
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  appIcon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : createAppIcon();
  tray = new Tray(appIcon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '開啟作業追蹤',
      click: () => { createWindow(false); if(mainWindow) mainWindow.show(); },
    },
    {
      label: '📺 投影模式',
      click: () => enterProjectorMode(),
    },
    { type: 'separator' },
    {
      label: `自動投影時間：${String(AUTO_PROJECTOR_HOUR).padStart(2,'0')}:${String(AUTO_PROJECTOR_MINUTE).padStart(2,'0')}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: '結束程式',
      click: () => {
        if (scheduledJob) scheduledJob.cancel();
        app.exit(0);
      },
    },
  ]);

  tray.setToolTip('作業缺交追蹤');
  tray.setContextMenu(contextMenu);
  // 單擊顯示／隱藏視窗
  tray.on('click', () => {
    if (!mainWindow) { createWindow(false); return; }
    if (mainWindow.isVisible()) { mainWindow.hide(); } else { mainWindow.show(); mainWindow.focus(); }
  });
}

// ── 排程：每天指定時間自動開啟投影模式 ──
function setupSchedule() {
  // cron 格式：秒 分 時 日 月 週
  const cronExpr = `0 ${AUTO_PROJECTOR_MINUTE} ${AUTO_PROJECTOR_HOUR} * * ${AUTO_PROJECTOR_WEEKDAYS}`;
  scheduledJob = schedule.scheduleJob(cronExpr, () => {
    createWindow(true);
  });
}

// ── IPC：取得目前版本 ──
ipcMain.handle('get-version', () => app.getVersion());

// ── IPC：下載並安裝更新 ──
ipcMain.handle('download-and-install', async (event, url, fileName) => {
  const tmpDir = app.getPath('temp');
  const savePath = path.join(tmpDir, fileName || 'homework-tracker-update.exe');

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(savePath);
    let downloaded = 0;
    let total = 0;

    function doRequest(reqUrl, redirectCount = 0) {
      if (redirectCount > 10) { reject(new Error('太多次重新導向')); return; }
      const mod = reqUrl.startsWith('https') ? https : http;
      mod.get(reqUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        // 追蹤重新導向
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307) {
          doRequest(res.headers.location, redirectCount + 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`下載失敗，HTTP ${res.statusCode}`));
          return;
        }
        total = parseInt(res.headers['content-length'] || '0', 10);
        res.on('data', chunk => {
          downloaded += chunk.length;
          file.write(chunk);
          if (mainWindow && total > 0) {
            mainWindow.webContents.send('update-progress', {
              percent: Math.round((downloaded / total) * 100),
              downloaded,
              total
            });
          }
        });
        res.on('end', () => {
          file.end();
          // 執行安裝檔
          exec(`"${savePath}"`, (err) => {
            if (err) { reject(err); return; }
            resolve({ success: true, path: savePath });
          });
        });
        res.on('error', reject);
      }).on('error', reject);
    }

    doRequest(url);
  });
});

// ── App 啟動 ──
app.whenReady().then(() => {
  // 開機自動執行
  app.setLoginItemSettings({ openAtLogin: true, path: app.getPath('exe') });

  ensureIcon();
  createTray();
  setupSchedule();

  // 啟動時如果是 8:00 前後，自動進入投影模式
  const autoProjector = isProjectorTime();
  createWindow(autoProjector);

  app.on('activate', () => {
    if (!mainWindow) createWindow(false);
  });
});

// 讓關閉所有視窗時 app 不退出（改為縮到系統匣）
app.on('window-all-closed', () => {
  // do nothing — stays in tray
});
