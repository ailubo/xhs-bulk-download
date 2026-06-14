// batch_extract_all.mjs — Light mode: extract ALL liquor prices from 今日酒价 articles
// Output: data.json (茅台 only, same format) + all_prices.jsonl (every product)
// Single Chrome session, batch+rest, append-only, breakpoint-resumable

import puppeteer from 'puppeteer-core';
import fs from 'fs';

const [,, linksFile, dataJsonFile] = process.argv;
if (!linksFile || !dataJsonFile) {
  console.error('Usage: node batch_extract_all.mjs <links.json> <data.json>');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));
const log = (...args) => console.log(`[${new Date().toLocaleTimeString()}]`, ...args);

const BATCH_SIZE = 12;
const REST_BETWEEN_BATCHES = 2 * 60 * 1000;
const ARTICLE_WAIT = 3000;
const ARTICLE_LOAD_TIMEOUT = 20000;

// Output file for all prices
const allPricesFile = dataJsonFile.replace('data.json', 'all_prices.jsonl');

// Parse links
let articles = JSON.parse(fs.readFileSync(linksFile, 'utf8'));
if (typeof articles === 'string') articles = JSON.parse(articles);
log(`Loaded ${articles.length} articles`);

// Load existing data.json
let existingPrices = [];
let existingDates = new Set();
if (fs.existsSync(dataJsonFile)) {
  existingPrices = JSON.parse(fs.readFileSync(dataJsonFile, 'utf8')).prices || [];
  existingDates = new Set(existingPrices.map(p => p.date));
  log(`Existing data.json: ${existingPrices.length} points`);
}

// Load existing all_prices dates to skip
let allDatesDone = new Set();
if (fs.existsSync(allPricesFile)) {
  const lines = fs.readFileSync(allPricesFile, 'utf8').trim().split('\n').filter(Boolean);
  lines.forEach(line => {
    try { const d = JSON.parse(line); if (d.date) allDatesDone.add(d.date); } catch {}
  });
  log(`Existing all_prices.jsonl: ${allDatesDone.size} dates`);
}

// State for breakpoint resume
const stateFile = dataJsonFile.replace('.json', '_all_state.json');
let processed = new Set();
if (fs.existsSync(stateFile)) {
  processed = new Set(JSON.parse(fs.readFileSync(stateFile, 'utf8')).processed || []);
  log(`Resuming: ${processed.size} already processed`);
}
function saveState() {
  fs.writeFileSync(stateFile, JSON.stringify({ processed: [...processed], last: new Date().toISOString() }));
}

function extractDate(title) {
  const m = title.match(/(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  return `2026-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
}

// Extract ALL product prices from article HTML
function extractAllPrices(html) {
  const products = [];
  
  // Find all table sections. Each brand section has:
  // <table> ... <td><img>category</td><td>brand name</td><td>date</td> ... header row ... product rows ... </table>
  
  // Strategy: split by <table> tags, find each product table
  const tableBlocks = html.split(/<table[^>]*>/).filter(b => b.includes('<tr'));
  
  for (const block of tableBlocks) {
    // Does this block have a category header? Look for brand name after a logo image
    const hasPriceTable = block.includes('品名') && block.includes('规格') && block.includes('行情');
    if (!hasPriceTable) continue;
    
    // Extract category name (brand name in the header row)
    const categoryMatch = block.match(/<span[^>]*>([^<]+(?:茅台|五粮液|泸州老窖|汾酒|洋河|剑南春|习酒|郎酒|古井|水井坊|酒鬼|舍得|口子|老白干|迎驾|今世缘|金徽|西凤|钓鱼台|国台|金沙|珍酒|董酒|仰韶|宝丰|杜康|丹泉|潭酒|安酒|双沟|白云边|赊店|衡昌|红星|牛栏山|景芝|孔府|扳倒井|琅琊|云门|花冠|趵突泉|张弓|富平春|卧龙|皇沟|宋河|豫酒|鸡公山|林河|沁河|棠河|朗陵|侯爵|百荣|拉菲|奔富|人头马|轩尼诗|马爹利|皇家礼炮|麦卡伦|格兰菲迪|百龄坛|芝华士|尊尼获加|个性茅台|系列酒|酱香经典|生肖|陈酿)[^<]*)<\/span>/i);
    const category = categoryMatch ? categoryMatch[1].trim() : '未知';
    
    // Parse rows. Each row: <tr>...<td>product</td><td>spec</td><td>yesterday</td><td>today</td>...</tr>
    const rowRegex = /<tr[^>]*>(.*?)<\/tr>/gs;
    const rows = [...block.matchAll(rowRegex)].map(m => m[1]);
    
    // Skip header row
    let headerSkipped = false;
    for (const row of rows) {
      const cellRegex = /<td[^>]*>(.*?)<\/td>/gs;
      const cells = [...row.matchAll(cellRegex)].map(m => 
        m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim().replace(/⬆|⬇|↑|↓/g, '')
      );
      
      if (cells.length < 3) continue;
      
      // Check if this is a header row
      if (cells[0] === '品名' || cells[0].includes('品名')) {
        headerSkipped = true;
        continue;
      }
      if (!headerSkipped) continue;
      
      const productName = cells[0];
      const spec = cells[1] || '';
      
      // Try to find yesterday and today prices (usually last 2 cells)
      let yesterday = null, today = null;
      
      // Scan cells for numeric prices
      const priceCells = [];
      for (let ci = 2; ci < Math.min(cells.length, 4); ci++) {
        const pm = cells[ci].match(/^(\d{2,5})/);
        if (pm) priceCells.push(parseInt(pm[1], 10));
      }
      
      if (priceCells.length >= 2) {
        yesterday = priceCells[0];
        today = priceCells[1];
      } else if (priceCells.length === 1) {
        today = priceCells[0];
      }
      
      if (!today && !yesterday) continue;
      if ((today || 0) < 1 && (yesterday || 0) < 1) continue;
      
      products.push({
        category,
        product: productName,
        spec,
        yesterday: yesterday || null,
        today: today || null,
        change: (today && yesterday) ? today - yesterday : null
      });
    }
  }
  
  return products;
}

// Launch Chrome
log('Launching Chrome...');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  userDataDir: 'C:/Users/PC/AppData/Roaming/baoyu-skills/chrome-profile',
  headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });

// Block images/media/fonts (light mode)
await page.setRequestInterception(true);
page.on('request', req => {
  const t = req.resourceType();
  if (t === 'image' || t === 'media' || t === 'font') req.abort().catch(() => {});
  else req.continue().catch(() => {});
});

let newMaotaiPoints = 0;
let totalProcessed = 0;
let allPricesWriter = fs.createWriteStream(allPricesFile, { flags: 'a' }); // append mode

try {
  const todo = articles.filter(a => !processed.has(a.msgid));
  log(`${todo.length} articles to process`);
  
  for (let i = 0; i < todo.length; i++) {
    const article = todo[i];
    totalProcessed++;
    
    const date = extractDate(article.title);
    if (!date) {
      log(`[${i+1}/${todo.length}] SKIP — no date: ${article.title.substring(0,50)}`);
      processed.add(article.msgid); saveState();
      continue;
    }
    
    // Skip if both data.json and all_prices already have this date
    const hasMaotai = existingDates.has(date);
    const hasAll = allDatesDone.has(date);
    if (hasMaotai && hasAll) {
      log(`[${i+1}/${todo.length}] SKIP ${date} — complete`);
      processed.add(article.msgid); saveState();
      continue;
    }
    
    // Navigate
    try {
      await page.goto(article.link, { waitUntil: 'domcontentloaded', timeout: ARTICLE_LOAD_TIMEOUT });
    } catch(e) {
      log(`[${i+1}/${todo.length}] FAIL ${date} — load error`);
      processed.add(article.msgid); saveState();
      continue;
    }
    await sleep(ARTICLE_WAIT);
    
    const html = await page.evaluate(() => document.body.innerHTML);
    
    // Extract ALL products
    const allProducts = extractAllPrices(html);
    
    if (allProducts.length > 0 && !allDatesDone.has(date)) {
      for (const p of allProducts) {
        allPricesWriter.write(JSON.stringify({ date, ...p }) + '\n');
      }
      allDatesDone.add(date);
      log(`[${i+1}/${todo.length}] 📊 ${date} — ${allProducts.length} products saved to all_prices.jsonl`);
    }
    
    // Extract Maotai prices from the same data
    const maotaiItems = allProducts.filter(p => p.category.includes('茅台') && p.product.includes('飞天'));
    let sanping = null, yuanxiang = null;
    for (const item of maotaiItems) {
      if (!item.today) continue;
      if (item.product.includes('散') && !item.product.includes('原')) {
        if (!sanping) sanping = item.today;
      } else if (item.product.includes('原')) {
        if (!yuanxiang) yuanxiang = item.today;
      }
    }
    
    if ((sanping || yuanxiang) && !existingDates.has(date)) {
      const guidePrice = date >= '2026-03-31' ? 1539 : 1499;
      const entry = {
        date,
        source: '今日酒价',
        guide_price: guidePrice
      };
      if (sanping) { entry.sanping = sanping; entry.signal = sanping < guidePrice ? '🔴' : sanping <= 1800 ? '🟡' : '🟢'; }
      if (yuanxiang) entry.yuanxiang = yuanxiang;
      
      existingPrices.push(entry);
      existingDates.add(date);
      newMaotaiPoints++;
      log(`[${i+1}/${todo.length}] 🔴 散=${sanping} 原=${yuanxiang}`);
    }
    
    processed.add(article.msgid);
    saveState();
    
    // Batch checkpoint
    if (totalProcessed % BATCH_SIZE === 0 && i < todo.length - 1) {
      fs.writeFileSync(dataJsonFile, JSON.stringify({ prices: existingPrices }, null, 2));
      allPricesWriter.end();
      allPricesWriter = fs.createWriteStream(allPricesFile, { flags: 'a' });
      log(`💾 Batch ${Math.floor(totalProcessed/BATCH_SIZE)}: ${existingPrices.length} maotai, ${allDatesDone.size} dates all_prices. Resting...`);
      await sleep(REST_BETWEEN_BATCHES);
    }
    
    await sleep(rand(2000, 4000));
  }
  
  // Final save
  fs.writeFileSync(dataJsonFile, JSON.stringify({ prices: existingPrices }, null, 2));
  allPricesWriter.end();
  
  log(`\n=== DONE ===`);
  log(`Articles: ${totalProcessed}`);
  log(`New Maotai: ${newMaotaiPoints} (total: ${existingPrices.length})`);
  log(`All products dates: ${allDatesDone.size}`);
  log(`all_prices.jsonl: ${allPricesFile}`);
  
  try { fs.unlinkSync(stateFile); } catch {}
  
  await browser.close();
} catch(e) {
  log(`ERROR: ${e.message}`);
  fs.writeFileSync(dataJsonFile, JSON.stringify({ prices: existingPrices }, null, 2));
  allPricesWriter.end();
  await browser.close();
}
