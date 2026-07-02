#!/usr/bin/env node
// Single XHS note downloader — no login, public explore page extraction
// Usage: node xhs-single-note.mjs <shortlink_or_url> <output_dir> [--chrome PATH]
//
// 从单条小红书笔记链接提取图片+元数据，保存为 Markdown + 图片文件。
// 不需要登录，通过 explore 页面公开数据提取。

import fs from 'fs';
import path from 'path';
import os from 'os';

// ──────────────── Args ────────────────
const args = process.argv.slice(2);
let ORIGINAL_LINK = null;
let OUT_DIR = null;
let CHROME_PATH = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--chrome' && args[i + 1]) { CHROME_PATH = path.resolve(args[++i]); }
  else if (!ORIGINAL_LINK) { ORIGINAL_LINK = args[i]; }
  else if (!OUT_DIR) { OUT_DIR = path.resolve(args[i]); }
}

if (!ORIGINAL_LINK || !OUT_DIR) {
  console.error('Usage: node xhs-single-note.mjs <url> <output_dir> [--chrome PATH]');
  console.error('Example: node xhs-single-note.mjs "https://xhslink.com/xxx" "./output"');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

// ──────────────── Chrome auto-detect ────────────────
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
    process.exit(1);
  }
}

// ──────────────── Import puppeteer ────────────────
let puppeteer;
if (os.platform() === 'win32') {
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
if (!puppeteer?.launch) {
  try {
    puppeteer = await import('puppeteer-core');
    if (puppeteer.default) puppeteer = puppeteer.default;
  } catch(e) {}
}
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
  console.error('puppeteer-core not found! Install: npm install puppeteer-core');
  process.exit(1);
}

// ──────────────── Main ────────────────
async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = await browser.newPage();

  // Step 1: Open the link, follow redirect chain, settle on final page
  log('Opening: ' + ORIGINAL_LINK.substring(0, 60) + '...');
  
  await page.goto(ORIGINAL_LINK, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 4000));
  
  let currentUrl = page.url();
  log('Current URL: ' + currentUrl.substring(0, 100));
  
  const noteIdMatch = currentUrl.match(/item\/([a-f0-9]{24})/);
  if (noteIdMatch) {
    const noteId = noteIdMatch[1];
    log('Note ID: ' + noteId + ' — navigating to explore page');
    await page.goto('https://www.xiaohongshu.com/explore/' + noteId, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForFunction(() => {
      const s = window.__INITIAL_STATE__;
      return s?.note?.noteDetailMap && Object.keys(s.note.noteDetailMap).length > 0;
    }, { timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
    log('Final URL: ' + page.url().substring(0, 100));
  }

  // Step 2: Safety check — ensure not logged in
  let safety;
  try {
    safety = await page.evaluate(() => {
    const signals = [];
    const text = document.body?.innerText || '';
    if (/退出登录|切换账号|账号设置/.test(text)) signals.push('logged-in-text');
    const sidebarText = [...document.querySelectorAll('aside, nav, [class*=side], [class*=sidebar]')]
      .map(el => el.innerText || '').join('\n');
    if (/(^|\n|\s)我($|\n|\s)/.test(sidebarText)) signals.push('sidebar-me-entry');
    if (document.querySelector('[class*=account][class*=avatar], [class*=user][class*=avatar]'))
      signals.push('account-avatar');
    return { loggedIn: signals.length > 0, signals };
  });
  } catch(e) {
    log('Safety check failed (page navigation): ' + e.message.substring(0, 50));
    safety = { loggedIn: false, signals: [] };
  }

  if (safety.loggedIn) {
    log('ACCOUNT LOGGED IN — stopping for safety');
    log('Signals: ' + safety.signals.join(', '));
    await browser.close();
    process.exit(1);
  }
  log('Safety check passed — not logged in');

  // Step 3: Close login modal if present
  await page.evaluate(() => {
    const closeBtn = document.querySelector('.close-button, [class*=close], [class*=login] [class*=close]');
    if (closeBtn) closeBtn.click();
  });
  await page.keyboard.press('Escape').catch(() => {});
  await new Promise(r => setTimeout(r, 1000));

  // Step 4: Extract note data from __INITIAL_STATE__
  const rawData = await page.evaluate(() => {
    const state = window.__INITIAL_STATE__;
    if (!state?.note?.noteDetailMap) return null;
    const noteId = Object.keys(state.note.noteDetailMap)[0];
    const note = state.note.noteDetailMap[noteId].note;
    return JSON.stringify({
      noteId,
      title: note.title || '',
      desc: note.desc || '',
      type: note.type,
      tags: (note.tagList || []).map(t => t.name),
      images: (note.imageList || []).map(img => img.urlDefault || img.url || ''),
      videoUrl: (note.video?.media?.stream?.h264?.[0]?.masterUrl) || '',
      author: note.user?.nickname || '',
      likes: note.interactInfo?.likedCount || '0',
      collects: note.interactInfo?.collectedCount || '0',
      commentCount: note.interactInfo?.commentCount || '0',
      ipLocation: note.ipLocation || '',
      time: note.time || 0,
    });
  });

  if (!rawData) {
    log('No note data on current page — trying redirect URL...');
    const redirectMatch = page.url().match(/item\/([a-f0-9]+)/);
    if (redirectMatch) {
      const noteId = redirectMatch[1];
      await page.goto('https://www.xiaohongshu.com/explore/' + noteId, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 5000));
      const retryData = await page.evaluate(() => {
        const state = window.__INITIAL_STATE__;
        if (!state?.note?.noteDetailMap) return null;
        const nid = Object.keys(state.note.noteDetailMap)[0];
        const note = state.note.noteDetailMap[nid].note;
        return JSON.stringify({
          noteId: nid,
          title: note.title || '',
          desc: note.desc || '',
          type: note.type,
          tags: (note.tagList || []).map(t => t.name),
          images: (note.imageList || []).map(img => img.urlDefault || img.url || ''),
          videoUrl: (note.video?.media?.stream?.h264?.[0]?.masterUrl) || '',
          author: note.user?.nickname || '',
          likes: note.interactInfo?.likedCount || '0',
          collects: note.interactInfo?.collectedCount || '0',
          commentCount: note.interactInfo?.commentCount || '0',
          ipLocation: note.ipLocation || '',
          time: note.time || 0,
        });
      });
      if (!retryData) {
        log('Cannot extract note data — page may have been deleted');
        await browser.close();
        process.exit(1);
      }
      const note = JSON.parse(retryData);
      log(`Note found: "${note.title}"`);
      await processNote(note, page);
    } else {
      log('Cannot extract note data');
      await browser.close();
      process.exit(1);
    }
  } else {
    const note = JSON.parse(rawData);
    log(`Note found: "${note.title}"`);
    await processNote(note, page);
  }

  async function processNote(note, page) {
    log(`  Type: ${note.type}, Images: ${note.images.length}, Author: ${note.author}`);
    log(`  Likes: ${note.likes}, Collects: ${note.collects}, Comments: ${note.commentCount}`);

    // Download images
    let imgCount = 0;
    for (let i = 0; i < note.images.length; i++) {
      const imgUrl = note.images[i];
      if (!imgUrl) continue;
      const ext = imgUrl.match(/\.(webp|jpg|jpeg|png|gif)/i)?.[1] || 'webp';
      const safeTitle = note.title.replace(/[\\/:*?"<>|]/g, '_').substring(0, 30);
      const fp = path.join(OUT_DIR, `${safeTitle}_${(i + 1).toString().padStart(2, '0')}.${ext}`);

      if (fs.existsSync(fp) && fs.statSync(fp).size > 5000) {
        imgCount++;
        continue;
      }

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
      }, imgUrl);

      if (b64) {
        const buf = Buffer.from(b64, 'base64');
        if (buf.length > 5000) {
          fs.writeFileSync(fp, buf);
          imgCount++;
          log(`  Downloaded image ${i + 1}/${note.images.length}: ${(buf.length / 1024).toFixed(1)} KB`);
        }
      }
    }

    // Save Markdown note
    const dateStr = note.time
      ? new Date(note.time).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0];
    const safeFileName = note.title.replace(/[\\/:*?"<>|]/g, '_').substring(0, 40);
    const mdPath = path.join(OUT_DIR, `${dateStr}_${safeFileName}.md`);

    const imageRefs = note.images.map((_, i) => {
      const ext = note.images[i]?.match(/\.(webp|jpg|jpeg|png|gif)/i)?.[1] || 'webp';
      return `![${note.title}_${i + 1}](${safeFileName}_${(i + 1).toString().padStart(2, '0')}.${ext})`;
    }).join('\n\n');

    const md = `---
date: ${dateStr}
author: ${note.author}
type: ${note.type}
tags: [${(note.tags || []).join(', ')}]
likes: ${note.likes}
collects: ${note.collects}
comments: ${note.commentCount}
url: ${ORIGINAL_LINK}
---

# ${note.title}

> 作者：${note.author} | 点赞 ${note.likes} | 收藏 ${note.collects} | 评论 ${note.commentCount}
${note.ipLocation ? '> 发布地：' + note.ipLocation : ''}

${note.desc}

---

## 图片 (${note.images.length}张)

${imageRefs}
`;

    fs.writeFileSync(mdPath, md, 'utf-8');
    log(`Markdown saved: ${mdPath}`);
    log(`${imgCount}/${note.images.length} images downloaded`);
  }

  await browser.close();
  log('Done.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
