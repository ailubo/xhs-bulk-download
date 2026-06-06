#!/usr/bin/env node
// XHS Bulk Image Downloader v2.1 — Generic, portable, single-file
// Usage: node bulk-download.mjs <profile_url> <output_dir> [--chrome PATH] [--profile DIR] [--skip-login] [--max-notes N]
//
// v2.1 反爬 + 效率改进：
//   - 下载阶段拦截图片/媒体/字体的自动加载（图片字节改用页面内 fetch 单独拿，省一半网络）
//   - 详情页用 domcontentloaded（不再死等 networkidle2），更快
//   - 图片字节经 base64 回传（替代逐字节 JSON 数组，体积约 1/3、快很多）
//   - 笔记之间随机停顿 + 每 40 篇分批休息，打散等间隔高频翻页的检测特征
//   - 撞到风控（验证/频繁提示）自动停止以保护账号，配合断点续传下次接着下
//   - --max-notes N：本次最多处理 N 篇笔记后停止（分批下载用）
//
// Verified on: Windows 11 + Chrome + Node.js 22
// Requires: puppeteer-core (install: npm install puppeteer-core)

import fs from 'fs';
import path from 'path';
import os from 'os';

// ──────────────── Config ────────────────
const args = process.argv.slice(2);
let PROFILE_URL = null;
let OUTPUT_DIR = null;
let CHROME_PATH = null;
let USER_DATA_DIR = null;
let SKIP_LOGIN = false;
let MAX_NOTES = Infinity;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--chrome' && args[i + 1]) { CHROME_PATH = path.resolve(args[++i]); }
  else if (args[i] === '--profile' && args[i + 1]) { USER_DATA_DIR = path.resolve(args[++i]); }
  else if (args[i] === '--skip-login') { SKIP_LOGIN = true; }
  else if (args[i] === '--max-notes' && args[i + 1]) { MAX_NOTES = parseInt(args[++i], 10) || Infinity; }
  else if (!PROFILE_URL) { PROFILE_URL = args[i]; }
  else if (!OUTPUT_DIR) { OUTPUT_DIR = path.resolve(args[i]); }
}

if (!PROFILE_URL || !OUTPUT_DIR) {
  console.error('Usage: node bulk-download.mjs <profile_url> <output_dir> [--chrome PATH] [--profile DIR] [--skip-login]');
  console.error('Example: node bulk-download.mjs "https://xhslink.com/m/xxxxx" "./xhs_output" --skip-login');
  process.exit(1);
}

// Auto-detect Chrome (platform-aware)
if (!CHROME_PATH) {
  const candidates = (os.platform() === 'win32')
    ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
    : (os.platform() === 'darwin')
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
  
  for (const c of candidates) {
    if (fs.existsSync(c)) { CHROME_PATH = c; break; }
  }
  if (!CHROME_PATH) {
    console.error('Chrome not found! Use --chrome <path>');
    console.error('Tried:', candidates);
    process.exit(1);
  }
}

if (!USER_DATA_DIR) {
  USER_DATA_DIR = path.join(os.tmpdir(), 'xhs-bulk-download-profile');
}

// ──────────────── Import puppeteer ────────────────
// macOS/Linux: try npm global. Windows: use known absolute paths.
let puppeteer;

if (os.platform() === 'win32') {
  // Windows: try known WorkBuddy managed path first
  const winPaths = [
    path.join(os.homedir(), '.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js'),
    path.join(os.homedir(), '.workbuddy/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js'),
  ];
  for (const ppath of winPaths) {
    if (fs.existsSync(ppath)) {
      try {
        const url = 'file:///' + ppath.replace(/\\/g, '/');
        puppeteer = (await import(url)).default || (await import(url));
        break;
      } catch(e) { /* try next */ }
    }
  }
}

// Fallback: global npm
if (!puppeteer?.launch) {
  try {
    puppeteer = await import('puppeteer-core');
    if (puppeteer.default) puppeteer = puppeteer.default;
  } catch(e) { /* last resort below */ }
}

// Last resort: search npm global dirs
if (!puppeteer?.launch) {
  try {
    const npmRoot = os.platform() === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules')
      : '/usr/local/lib/node_modules';
    const ppath = path.join(npmRoot, 'puppeteer-core', 'lib', 'puppeteer', 'puppeteer-core.js');
    if (fs.existsSync(ppath)) {
      puppeteer = (await import('file:///' + ppath.replace(/\\/g, '/'))).default;
    }
  } catch(e) {}
}

if (!puppeteer?.launch) {
  console.error('puppeteer-core not found!');
  console.error('Install: npm install puppeteer-core');
  console.error('Or place it in: ~/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
  process.exit(1);
}

// ──────────────── Helpers ────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString();
const log = (...args) => console.log(stamp(), ...args);
const rand = (a, b) => a + Math.floor(Math.random() * (b - a)); // 反爬节奏：随机区间 [a, b)

async function isLoggedIn(page) {
  try {
    return await page.evaluate(() => {
      const user = window.__INITIAL_STATE__?.user?.userInfo;
      return { loggedIn: !!(user?.nickname), nickname: user?.nickname || null };
    });
  } catch(e) { return { loggedIn: false }; }
}

async function ensureLogin(page) {
  if (SKIP_LOGIN) { log('Skipping login check (--skip-login)'); return true; }
  
  await page.goto('https://www.xiaohongshu.com', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  await sleep(2000);
  
  const info = await isLoggedIn(page);
  if (info.loggedIn) { log(`Logged in: ${info.nickname}`); return true; }
  
  log('NOT LOGGED IN — opening login page...');
  await page.goto('https://www.xiaohongshu.com/login', { waitUntil: 'networkidle2' }).catch(() => {});
  log('SCAN QR CODE in the browser window. Waiting (max 5 min)...');
  
  for (let i = 0; i < 100; i++) {
    await sleep(3000);
    const status = await isLoggedIn(page);
    if (status.loggedIn) { log(`Logged in: ${status.nickname}`); return true; }
    if (i === 30) log('Still waiting...');
  }
  log('LOGIN TIMEOUT. Re-run when logged in, or use --skip-login if already logged in.');
  return false;
}

async function patientScroll(page) {
  log('Incremental scroll + xsec extraction...');
  let prev = 0, same = 0;
  // FIRST: extract xsec from current viewport (newest notes at top!)
  const xsecMap = await extractXsec(page);
  log(`  Initial view: ${Object.keys(xsecMap).length} xsec`);
  for (let r = 1; r <= 100; r++) {
    // Scroll ONE screen at a time, not jump-to-bottom
    await page.evaluate(() => window.scrollBy(0, 800));
    await sleep(2000);
    const before = Object.keys(xsecMap).length;
    Object.assign(xsecMap, await extractXsec(page));
    const added = Object.keys(xsecMap).length - before;
    const cnt = await page.evaluate(() => document.querySelectorAll('section.note-item').length);
    if (cnt === prev) { same++; if (same >= 5) break; }
    else { same = 0; prev = cnt; log(`  ${cnt} notes, +${added} xsec = ${Object.keys(xsecMap).length} total (round ${r})`); }
  }
  log(`Total: ${prev} notes, ${Object.keys(xsecMap).length} xsec tokens`);
  return xsecMap;
}

async function extractXsec(page) {
  return await page.evaluate(() => {
    const m = {};
    document.querySelectorAll('section.note-item a').forEach(a => {
      const h = a.getAttribute('href');
      if (!h) return;
      const x = h.match(/\/user\/profile\/[^/]+\/([a-f0-9]{24})\?xsec_token=([^&]+)&/);
      if (x) m[x[1]] = x[2];
    });
    return m;
  });
}

// 返回值：>=0 = 本篇成功下载的图片数；-1 = 检测到风控，主循环应立即停止
async function downloadNote(page, noteId, xsec, uid, outputDir) {
  const url = xsec
    ? `https://www.xiaohongshu.com/user/profile/${uid}/${noteId}?xsec_token=${xsec}&xsec_source=pc_user`
    : `https://www.xiaohongshu.com/explore/${noteId}`;

  // domcontentloaded 即可——图片字节后面单独 fetch，不必死等 networkidle2（更快、请求更少）
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 }); } catch(e) { return 0; }
  await page.waitForSelector('img', { timeout: 8000 }).catch(() => {});
  await sleep(rand(600, 1200));
  if (page.url().includes('error') || page.url().includes('404')) return 0;

  // 风控检测：撞到验证/频繁提示就停，别硬刚（保护账号）
  const blocked = await page.evaluate(() => {
    const t = ((document.body && document.body.innerText) || '').slice(0, 300);
    if (/验证码|滑动验证|操作过于频繁|访问异常|请完成|拼图/.test(t)) return true;
    return !!document.querySelector('.captcha, [class*="captcha"], [class*="verify-"], .vc-container');
  });
  if (blocked) return -1;

  // 抓笔记图片 URL（含懒加载 data-src）
  const imgs = await page.evaluate(() =>
    [...new Set(Array.from(document.querySelectorAll('img'))
      .map(i => i.src || i.getAttribute('data-src') || '')
      .filter(s => s && s.includes('xhscdn.com') && !s.includes('avatar') && !s.includes('fe-platform')))]
  );

  const pref = noteId.slice(0, 8);
  let cnt = 0;
  for (let j = 0; j < imgs.length; j++) {
    const fp = path.join(outputDir, `${pref}_${(j+1).toString().padStart(2,'0')}.webp`);
    if (fs.existsSync(fp) && fs.statSync(fp).size > 5000) { cnt++; continue; }

    // 页面内 fetch 拿正确 Referer；用 FileReader 转 base64 回传（比逐字节 JSON 数组小约 3 倍、快很多）
    // 注意：这里的 fetch 是 resourceType 'fetch'，不会被下载阶段的图片拦截命中
    const b64 = await page.evaluate(async (u) => {
      try {
        const r = await fetch(u);
        if (!r.ok) return null;
        const blob = await r.blob();
        return await new Promise(res => {
          const fr = new FileReader();
          fr.onloadend = () => res((fr.result || '').toString().split(',')[1] || null);
          fr.onerror = () => res(null);
          fr.readAsDataURL(blob);
        });
      } catch(e) { return null; }
    }, imgs[j]);

    if (b64) {
      const buf = Buffer.from(b64, 'base64');
      if (buf.length > 5000) {
        try { fs.writeFileSync(fp, buf); cnt++; } catch(e) { log(`  写盘失败 ${fp}: ${e.message}`); }
      }
    }
  }
  return cnt;
}

// ──────────────── Main ────────────────
async function main() {
  log('XHS Bulk Download v2');
  log(`Profile URL: ${PROFILE_URL.substring(0, 80)}...`);
  log(`Output:      ${OUTPUT_DIR}`);
  log(`Chrome:      ${CHROME_PATH}`);
  log(`Profile:     ${USER_DATA_DIR}`);
  log(`Skip login:  ${SKIP_LOGIN}`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Extract user ID from URL
  const uidMatch = PROFILE_URL.match(/profile\/([a-f0-9]{24})/);
  if (!uidMatch) { log('ERROR: Cannot extract user ID from URL'); process.exit(1); }
  const uid = uidMatch[1];

  // 桌面环境不必关浏览器沙箱；仅在 Linux（常见无沙箱的容器/CI）才加 --no-sandbox
  const launchArgs = ['--disable-blink-features=AutomationControlled', '--no-first-run'];
  if (os.platform() === 'linux') { launchArgs.push('--no-sandbox', '--disable-setuid-sandbox'); }

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    userDataDir: USER_DATA_DIR,
    headless: false,
    args: launchArgs,
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  try {
    if (!await ensureLogin(page)) { await browser.close(); process.exit(1); }

    log('Opening profile...');
    await page.goto(PROFILE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(5000);

    if (page.url().includes('error_code=300012')) {
      log('IP BLOCKED! xsec_token may be expired. Get a fresh share link.');
      await browser.close();
      process.exit(1);
    }

    const xsecMap = await patientScroll(page);
    const entries = Object.entries(xsecMap);
    log(`Extracted ${entries.length} xsec tokens`);

    const saved = new Set(
      fs.readdirSync(OUTPUT_DIR)
        .filter(f => /^[0-9a-f]+_\d+\.webp$/.test(f))
        .map(f => f.split('_')[0])
    );
    let todo = entries.filter(([n]) => !saved.has(n.slice(0, 8)));
    if (todo.length > MAX_NOTES) {
      log(`本次限 ${MAX_NOTES} 篇（--max-notes），其余下次断点续传`);
      todo = todo.slice(0, MAX_NOTES);
    }
    log(`New: ${todo.length}, Done: ${entries.length - todo.length}\n`);

    // 下载阶段才开启资源拦截：abort 图片/媒体/字体的自动加载（图片字节后面用 fetch 单独拿）。
    // 放在登录/滚动之后，避免影响二维码显示和主页缩略图懒加载。
    await page.setRequestInterception(true);
    page.on('request', req => {
      const t = req.resourceType();
      if (t === 'image' || t === 'media' || t === 'font') req.abort().catch(() => {});
      else req.continue().catch(() => {});
    });

    let total = 0;
    for (let i = 0; i < todo.length; i++) {
      const [nid, xsec] = todo[i];
      console.log(`[${i+1}/${todo.length}] ${nid.slice(0,8)}`);
      const cnt = await downloadNote(page, nid, xsec, uid, OUTPUT_DIR);

      if (cnt === -1) {
        log('⚠️ 触发小红书风控（验证/频繁提示），已停止以保护账号。');
        log('   建议歇一阵（数小时~一天）再跑；已下载的会自动跳过（断点续传）。');
        break;
      }

      total += cnt;
      console.log(`  → ${cnt} images (total: ${total})`);

      // 反爬节奏：笔记之间随机停顿，避免等间隔高频翻页
      await sleep(rand(2000, 5000));
      // 每 40 篇喝口水，进一步打散节奏
      if ((i + 1) % 40 === 0 && i + 1 < todo.length) {
        const restMs = rand(30000, 90000);
        log(`  已处理 ${i + 1} 篇，分批休息 ${Math.round(restMs / 1000)}s…`);
        await sleep(restMs);
      }
    }

    const all = fs.readdirSync(OUTPUT_DIR).filter(f => /^[0-9a-f]+_\d+\.webp$/.test(f));
    log(`\nDone! ${new Set(all.map(f => f.split('_')[0])).size} notes, ${all.length} images`);
    log(`Saved to: ${OUTPUT_DIR}`);

  } catch (err) {
    log('FATAL:', err.message);
    console.error(err.stack);
  } finally {
    await browser.close();
    log('Closed.');
  }
}

main();
