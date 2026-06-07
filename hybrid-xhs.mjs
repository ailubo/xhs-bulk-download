// hybrid-xhs.mjs — 混合方案：仅提取首页 xsec，xhs-reader 风格下载
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const [,, profileUrl, outputDir, chromeProfile] = process.argv;
if (!profileUrl || !outputDir) {
  console.error('Usage: node hybrid-xhs.mjs <profile_url> <output_dir> <chrome_profile>');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));
const log = (...args) => console.log(new Date().toLocaleTimeString(), ...args);

fs.mkdirSync(outputDir, { recursive: true });

// Extract UID
const uidMatch = profileUrl.match(/profile\/([a-f0-9]{24})/);
const uid = uidMatch[1];

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  userDataDir: chromeProfile,
  headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });

try {
  // Step 1: Open profile, extract xsec (NO scrolling!)
  log('Opening profile...');
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(4000);

  const xsecMap = await page.evaluate(() => {
    const m = {};
    document.querySelectorAll('section.note-item a').forEach(a => {
      const h = a.getAttribute('href');
      if (!h) return;
      const x = h.match(/\/user\/profile\/[^/]+\/([a-f0-9]{24})\?xsec_token=([^&]+)&/);
      if (x) m[x[1]] = x[2];
    });
    return m;
  });

  if (Object.keys(xsecMap).length === 0) {
    log('0 xsec - login required');
    process.exit(1);
  }
  log(`${Object.keys(xsecMap).length} notes found (no scroll)`);

  // Step 2: Filter already downloaded
  const done = new Set(
    fs.readdirSync(outputDir)
      .filter(f => /^[0-9a-f]+_\d+\.webp$/.test(f))
      .map(f => f.split('_')[0])
  );
  const todo = Object.entries(xsecMap).filter(([n]) => !done.has(n.slice(0,8)));
  log(`${todo.length} new to download, ${done.size} already done`);

  // Step 3: Download each note — xhs-reader style (__INITIAL_STATE__)
  // Abort images/media to save bandwidth
  await page.setRequestInterception(true);
  page.on('request', req => {
    const t = req.resourceType();
    if (t === 'image' || t === 'media' || t === 'font') req.abort().catch(() => {});
    else req.continue().catch(() => {});
  });

  let totalImgs = 0;
  for (let i = 0; i < todo.length; i++) {
    const [nid, xsec] = todo[i];
    const noteUrl = `https://www.xiaohongshu.com/user/profile/${uid}/${nid}?xsec_token=${xsec}&xsec_source=pc_user`;
    log(`[${i+1}/${todo.length}] ${nid.slice(0,8)}`);

    // Open note
    await page.goto(noteUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
    await sleep(3000);

    // xhs-reader style: read from __INITIAL_STATE__
    const imgs = await page.evaluate(() => {
      try {
        const state = window.__INITIAL_STATE__;
        if (!state?.note?.noteDetailMap) return [];
        const noteId = Object.keys(state.note.noteDetailMap)[0];
        const note = state.note.noteDetailMap[noteId].note;
        return (note.imageList || []).map(img => img.urlDefault || img.url || '').filter(u => u);
      } catch(e) { return []; }
    });

    const pref = nid.slice(0, 8);
    let cnt = 0;

    for (let j = 0; j < imgs.length; j++) {
      const fp = path.join(outputDir, `${pref}_${(j+1).toString().padStart(2,'0')}.webp`);
      if (fs.existsSync(fp) && fs.statSync(fp).size > 5000) { cnt++; continue; }

      // Fetch in page context for correct Referer
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
          try { fs.writeFileSync(fp, buf); cnt++; } catch(e) {}
        }
      }
    }

    totalImgs += cnt;
    log(`  → ${cnt} images (total: ${totalImgs})`);

    // Gentle delay: 15-25s between notes
    if (i < todo.length - 1) {
      const delay = rand(15000, 25000);
      log(`  ⏳ ${Math.round(delay/1000)}s pause...`);
      await sleep(delay);
    }
  }

  const all = fs.readdirSync(outputDir).filter(f => /^[0-9a-f]+_\d+\.webp$/.test(f));
  log(`\nDone! ${new Set(all.map(f => f.split('_')[0])).size} notes, ${all.length} images`);

} catch(e) {
  log('Error:', e.message);
} finally {
  await browser.close();
  log('Closed');
}
