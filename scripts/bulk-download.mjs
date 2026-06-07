#!/usr/bin/env node
// XHS Bulk Image Downloader v2.3 — Universal skill for any XHS blogger
// Usage: node bulk-download.mjs <profile_url> <output_dir> [--chrome PATH] [--profile DIR] [--skip-login] [--max-notes N]
//
// v2.3 通用化改进（2026-06-07）：
//   - xsec 缓存：滚动结果存 .xhs-xsec-cache.json，下次跳过滚动直接下载
//   - 已尝试追踪：.xhs-attempted.json 记录已尝试笔记（含纯文字），避免重复浪费请求
//   - 滚动中检测风控：300013 / 访问频繁等立即停止
//   - 滚动节奏放缓：3-6s 随机间隔，最大 30 轮
//   - 下载节奏放缓：12-20s 间隔，每 10 篇休息 4-6 分钟
//   - 默认 --max-notes 50（防止一次性全量触发风控）
//   - 支持断点续传：已下载图片自动跳过
//
// v2.1 反爬 + 效率改进：
//   - 下载阶段拦截图片/媒体/字体的自动加载
//   - 详情页用 domcontentloaded
//   - 图片字节经 base64 回传

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
let MAX_NOTES = 50;  // 默认每次最多 50 篇，避免触发风控

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
  // 多维度检测登录态：INITIAL_STATE 不可靠（首页经常未填充），
  // 优先用 Cookie 检测（a1 + web_session 同时存在 = 已登录）
  try {
    const cookies = await page.cookies();
    const hasA1 = cookies.some(c => c.name === 'a1');
    const hasWebSession = cookies.some(c => c.name === 'web_session');
    const hasXhsId = cookies.some(c => c.name.startsWith('xhs-pc-web.'));
    if (hasA1 && hasWebSession) { return { loggedIn: true, nickname: 'cookie detected' }; }
    if (hasXhsId) { return { loggedIn: true, nickname: 'cookie detected' }; }
  } catch(e) {}
  
  // Fallback: INITIAL_STATE
  try {
    return await page.evaluate(() => {
      const user = window.__INITIAL_STATE__?.user?.userInfo;
      return { loggedIn: !!(user?.nickname), nickname: user?.nickname || null };
    });
  } catch(e) { return { loggedIn: false }; }
}

async function ensureLogin(page) {
  // --skip-login: still verify that profile loads with xsec (guest mode = 0 xsec = effectively not logged in)
  if (SKIP_LOGIN) {
    log('--skip-login: verifying profile access...');
    await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(3000);
    const xsecMap = await extractXsec(page);
    if (Object.keys(xsecMap).length > 0) {
      log(`Profile accessible (${Object.keys(xsecMap).length} xsec). Continuing.`);
      return true;
    }
    log('0 xsec — likely guest mode. Try without --skip-login to log in first.');
    return false;
  }
  
  // 直接打开个人主页（带 xsec_token），这是最准确的检测方式：
  // 能提取到 xsec = 页面正常工作 = 无需额外登录
  log('Checking access via profile page...');
  await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await sleep(3000);
  
  // 检测1：URL 是否被重定向到登录页
  const url = page.url();
  if (url.includes('/login')) {
    log('Redirected to login page — need to log in.');
  } else {
    // 检测2：能否提取到 xsec token（最直接的"能用"指标）
    const xsecMap = await extractXsec(page);
    if (Object.keys(xsecMap).length > 0) {
      const info = await isLoggedIn(page);
      log(`Profile accessible (${Object.keys(xsecMap).length} xsec). ${info.nickname ? 'User: ' + info.nickname : ''}`);
      return true;
    }
    log('Profile loaded but 0 xsec tokens — likely guest mode.');
  }
  
  // 需要登录：打开登录页，等待扫码（用 waitForNavigation 检测登录成功，不轮询页面）
  log('Opening login page. SCAN QR CODE in the browser window (5 min timeout).');
  await page.goto('https://www.xiaohongshu.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await sleep(3000);  // 等二维码渲染完

  // 等待登录后的页面跳转（最长 5 分钟），不轮询不触发刷新
  try {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 300000 });
    log('Page navigated — checking login...');
  } catch(e) { /* timeout, check cookie anyway */ }

  const status = await isLoggedIn(page);
  if (status.loggedIn) {
    log(`Login detected: ${status.nickname}`);
    await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(3000);
    const verifyMap = await extractXsec(page);
    if (Object.keys(verifyMap).length > 0) {
      log(`Verified: ${Object.keys(verifyMap).length} xsec available`);
      return true;
    }
    log('Login detected but profile still in guest mode');
  }
  log('LOGIN FAILED. Please log in manually and re-run.');
  return false;
}

async function patientScroll(page) {
  log('Gentle scroll (3-6s delay) + xsec extraction...');
  let prev = 0, same = 0, blocked = false;
  const xsecMap = await extractXsec(page);
  log(`  Initial view: ${Object.keys(xsecMap).length} xsec`);
  for (let r = 1; r <= 30 && !blocked; r++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    // 反爬：滚动间隔 3-6 秒随机，不打散等间隔特征
    await sleep(rand(3000, 6000));
    // 滚动过程中检测风控
    blocked = await page.evaluate(() => {
      const t = ((document.body && document.body.innerText) || '').slice(0, 200);
      return /安全验证|访问频繁|操作过于频繁|访问异常/.test(t)
        || /error_code=/.test(window.location.href);
    });
    if (blocked) { log('  ⚠️ 滚动中触发风控，停止翻页'); break; }
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

  // domcontentloaded 之后等 React 渲染完笔记内容再抓图（networkidle2 太慢，domcontentloaded 太早）
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 }); } catch(e) { return 0; }
  // 等笔记详情容器出现（比等任意 img 更可靠）
  await page.waitForSelector('.note-scroller, [class*="note-"], #detail-desc', { timeout: 10000 }).catch(() => {});
  // 再给 React 一点时间渲染图片
  await sleep(2000);
  if (page.url().includes('error') || page.url().includes('404')) return 0;

  // 风控检测：撞到验证/频繁提示就停（实测 XHS 会显示 "安全验证" / "请勿频繁操作" / "访问频繁"）
  const blocked = await page.evaluate(() => {
    const t = ((document.body && document.body.innerText) || '').slice(0, 300);
    if (/安全验证|请勿频繁操作|操作过于频繁|访问异常|验证码|访问频繁/.test(t)) return true;
    if (/\/captcha|\/sec_/.test(window.location.href)) return true;
    if (/error_code=/.test(window.location.href)) return true;
    return !!document.querySelector('.captcha, [class*="captcha"], [class*="verify-"]');
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

  // --no-sandbox 是必需的，所有平台无条件保留：实测部分 Windows 环境（含 Git Bash）
  // 不加它 Chrome 无法启动；原脚本所有笔记也都是带此参数在 Windows 上跑通的。请勿移除。
  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
  ];

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

    // ensureLogin already navigated to profile page and verified xsec
    if (page.url().includes('error_code=300012')) {
      log('IP BLOCKED! xsec_token may be expired. Get a fresh share link.');
      await browser.close();
      process.exit(1);
    }

    // ── xsec 缓存：优先用上次滚动的结果，跳过滚动阶段 ──
    const xsecCacheFile = path.join(OUTPUT_DIR, '.xhs-xsec-cache.json');
    let xsecMap, cached = null;
    if (fs.existsSync(xsecCacheFile)) {
      try {
        cached = JSON.parse(fs.readFileSync(xsecCacheFile, 'utf-8'));
        if (cached && typeof cached === 'object' && Object.keys(cached).length > 0) {
          xsecMap = cached;
          log(`Loaded ${Object.keys(xsecMap).length} cached xsec tokens, skipping scroll`);
        }
      } catch(e) { /* fall through to scroll */ }
    }
    if (!xsecMap) {
      xsecMap = await patientScroll(page);
    }
    // 保存滚动结果到缓存（合并新旧）
    try { fs.writeFileSync(xsecCacheFile, JSON.stringify(xsecMap)); } catch(e) {}
    const entries = Object.entries(xsecMap);
    log(`Extracted ${entries.length} xsec tokens`);

    // 断点续传：已下载图片 + 已尝试过的笔记（含纯文字笔记）都跳过
    const saved = new Set(
      fs.readdirSync(OUTPUT_DIR)
        .filter(f => /^[0-9a-f]+_\d+\.webp$/.test(f))
        .map(f => f.split('_')[0])
    );
    // 加载"已尝试"记录（纯文字笔记也有记录，避免每次重试浪费请求）
    const attemptedFile = path.join(OUTPUT_DIR, '.xhs-attempted.json');
    let attempted = saved; // 有图片的肯定已尝试
    if (fs.existsSync(attemptedFile)) {
      try {
        const arr = JSON.parse(fs.readFileSync(attemptedFile, 'utf-8'));
        arr.forEach(n => attempted.add(n));
        log(`Loaded ${arr.length} attempted notes from .xhs-attempted.json`);
      } catch(e) { /* ignore corrupted file */ }
    }
    let todo = entries.filter(([n]) => !attempted.has(n.slice(0, 8)));
    if (todo.length > MAX_NOTES) {
      log(`本次限 ${MAX_NOTES} 篇（--max-notes），其余下次断点续传`);
      todo = todo.slice(0, MAX_NOTES);
    }
    log(`New: ${todo.length}, Done: ${entries.length - todo.length}\n`);

    // 如果用了缓存但没有新笔记待处理，可能是博主发了新内容，重新滚动获取新 xsec
    if (todo.length === 0 && xsecMap === cached) {
      log('Cached xsec has 0 new notes — re-scrolling to discover new content...');
      xsecMap = await patientScroll(page);
      try { fs.writeFileSync(xsecCacheFile, JSON.stringify(xsecMap)); } catch(e) {}
      const entries2 = Object.entries(xsecMap);
      log(`Re-scroll: ${entries2.length} xsec tokens`);
      todo = entries2.filter(([n]) => !attempted.has(n.slice(0, 8)));
      log(`New after re-scroll: ${todo.length}\n`);
    }

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
        // 也记录本次触发风控的笔记，避免下次又重试它触发相同风控
        attempted.add(nid.slice(0, 8));
        try { fs.writeFileSync(attemptedFile, JSON.stringify([...attempted])); } catch(e) {}
        log('⚠️ 触发小红书风控（验证/频繁提示），已停止以保护账号。');
        log('   建议歇一阵（数小时~一天）再跑；已下载的会自动跳过（断点续传）。');
        break;
      }

      total += cnt;
      console.log(`  → ${cnt} images (total: ${total})`);

      // 记录已尝试（纯文字笔记也记录，避免下次重试浪费请求）
      attempted.add(nid.slice(0, 8));
      try { fs.writeFileSync(attemptedFile, JSON.stringify([...attempted])); } catch(e) {}

      // 反爬节奏：笔记之间 12-20s 随机停顿 + 每 10 篇休息 4-6 分钟
      await sleep(rand(12000, 20000));
      if ((i + 1) % 10 === 0 && i + 1 < todo.length) {
        const restMs = rand(240000, 360000);
        log(`  🍵 ${i + 1} 篇完成，休息 ${Math.round(restMs / 1000 / 60)} 分钟…`);
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
