// batch_extract_prices.mjs — Light mode: single Chrome session, batch-extract 飞天 prices from 今日酒价 articles
// Usage: node batch_extract_prices.mjs <links.json> <data.json>
// Based on XHS light mode learnings: single browser, append-only, batch+rest, breakpoint-resumable

import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const [,, linksFile, dataFile] = process.argv;
if (!linksFile || !dataFile) {
  console.error('Usage: node batch_extract_prices.mjs <links.json> <data.json>');
  console.error('Example: node batch_extract_prices.mjs /tmp/todayjiujia_links.json data.json');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));
const log = (...args) => console.log(`[${new Date().toLocaleTimeString()}]`, ...args);

// Config
const BATCH_SIZE = 12;        // articles per batch
const REST_BETWEEN_BATCHES = 2 * 60 * 1000;  // 2 min rest between batches
const ARTICLE_WAIT = 3000;    // wait after page load for lazy content
const ARTICLE_LOAD_TIMEOUT = 15000;

// Parse links (handle both single and double-wrapped JSON from agent-browser)
let articles = JSON.parse(fs.readFileSync(linksFile, 'utf8'));
// If parsed result is a string (agent-browser double-wrapped), parse again
if (typeof articles === 'string') articles = JSON.parse(articles);
log(`Loaded ${articles.length} articles from ${linksFile}`);

// Load existing data
let existing = [];
let existingDates = new Set();
if (fs.existsSync(dataFile)) {
  existing = JSON.parse(fs.readFileSync(dataFile, 'utf8')).prices || [];
  existingDates = new Set(existing.map(p => p.date));
  log(`Existing data: ${existing.length} data points`);
}

// State file for breakpoint resume
const stateFile = dataFile.replace('.json', '_batch_state.json');
let processed = new Set();
if (fs.existsSync(stateFile)) {
  processed = new Set(JSON.parse(fs.readFileSync(stateFile, 'utf8')).processed || []);
  log(`Resuming: ${processed.size} already processed`);
}

// Save state
function saveState() {
  fs.writeFileSync(stateFile, JSON.stringify({ processed: [...processed], lastUpdate: new Date().toISOString() }));
}

// Extract date from article title: "今日酒价-XXXX 各大名酒批发参考价 M月D日" or "... 1月1日" style
function extractDate(title) {
  // Try to find "M月D日" pattern at end of title
  const m = title.match(/(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  const month = String(m[1]).padStart(2, '0');
  const day = String(m[2]).padStart(2, '0');
  return `2026-${month}-${day}`;
}

// Extract 飞天 prices from article HTML
function extractPrices(html) {
  const result = { sanping: null, yuanxiang: null };

  // Strategy: find the first 茅台飞天 table, look for 26年 or 25年 飞天(散)/(原) rows
  // Table structure: rows have <tr><td>品名</td><td>规格</td><td>昨日行情</td><td>今日行情</td></tr>
  
  // Find all table rows
  const trRe = /<tr[^>]*>(.*?)<\/tr>/gs;
  let inMaotaiTable = false;
  let foundTodayPrice = false;
  
  // Split into tables roughly
  const tables = html.split(/<table[^>]*>/);
  
  for (const table of tables) {
    if (!table.includes('飞天') && !table.includes('茅台飞天')) continue;
    inMaotaiTable = true;
    
    // Find today's price column header first to know col indices
    const headerRow = table.match(/<tr[^>]*>.*?<\/tr>/s);
    
    const rows = table.match(/<tr[^>]*>(.*?)<\/tr>/gs) || [];
    for (const row of rows) {
      const cells = [...row.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
      
      if (cells.length < 4) continue;
      
      const productName = cells[0] || '';
      const todayPrice = cells[cells.length - 1] || ''; // last cell = 今日行情
      
      // Clean price: remove arrows, spaces, non-numeric except digits
      const priceClean = todayPrice.replace(/[^\d]/g, '');
      if (!priceClean || priceClean.length < 3 || priceClean.length > 5) continue;
      const price = parseInt(priceClean, 10);
      if (isNaN(price) || price < 500 || price > 5000) continue;
      
      // Match 飞天(散) or 飞天(散瓶) — but NOT 原箱
      if ((productName.includes('飞天') && productName.includes('散')) || 
          productName.includes('飞天(散') || productName.includes('飞天（散')) {
        if (!result.sanping) {
          result.sanping = price;
        }
      }
      // Match 飞天(原) or 原箱
      else if ((productName.includes('飞天') && productName.includes('原')) ||
               productName.includes('原箱')) {
        if (!result.yuanxiang) {
          result.yuanxiang = price;
        }
      }
    }
    if (inMaotaiTable && result.sanping && result.yuanxiang) break;
    
    // If 26年 not found, try 25年
    if (inMaotaiTable) break;
  }
  
  return result;
}

// Launch Chrome once
log('Launching Chrome...');
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  userDataDir: 'C:/Users/PC/AppData/Roaming/baoyu-skills/chrome-profile',
  headless: false,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
});
log('Chrome launched');

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });

// Block images/media/fonts for speed (light mode)
await page.setRequestInterception(true);
page.on('request', req => {
  const t = req.resourceType();
  if (t === 'image' || t === 'media' || t === 'font') req.abort().catch(() => {});
  else req.continue().catch(() => {});
});

let newPoints = 0;
let totalProcessed = 0;

try {
  const todo = articles.filter(a => !processed.has(a.msgid));
  log(`${todo.length} articles to process, ${processed.size} already done`);
  
  for (let i = 0; i < todo.length; i++) {
    const article = todo[i];
    totalProcessed++;
    
    // Parse date from title
    const date = extractDate(article.title);
    if (!date) {
      log(`[${i+1}/${todo.length}] SKIP ${article.title.substring(0, 50)} — no date found`);
      processed.add(article.msgid);
      saveState();
      continue;
    }
    
    // Skip if already have data for this date
    if (existingDates.has(date)) {
      log(`[${i+1}/${todo.length}] SKIP ${date} — already in data.json`);
      processed.add(article.msgid);
      saveState();
      continue;
    }
    
    // Navigate to article (light: just get HTML, no full render wait)
    try {
      await page.goto(article.link, { waitUntil: 'domcontentloaded', timeout: ARTICLE_LOAD_TIMEOUT });
    } catch(e) {
      log(`[${i+1}/${todo.length}] FAIL ${date} — page load error: ${e.message}`);
      processed.add(article.msgid);
      saveState();
      continue;
    }
    
    await sleep(ARTICLE_WAIT);
    
    // Extract HTML content
    const html = await page.evaluate(() => document.body.innerHTML);
    
    // Try to extract prices
    let sanping = null, yuanxiang = null;
    
    // Strategy: find the first 茅台飞天 section, parse the price table
    // The pattern is: <table> ... <td>品名</td><td>规格</td><td>昨日行情</td><td>今日行情</td> ... rows
    const tableRegex = /<table[^>]*>[\s\S]*?飞天[\s\S]*?品名[\s\S]*?规格[\s\S]*?昨日行情[\s\S]*?今日行情[\s\S]*?<\/table>/i;
    const tableMatch = html.match(tableRegex);
    
    if (tableMatch) {
      const tableHtml = tableMatch[0];
      
      // Match all rows in this table
      const rowRegex = /<tr[^>]*>(.*?)<\/tr>/gs;
      const rows = [...tableHtml.matchAll(rowRegex)].map(m => m[1]);
      
      for (const row of rows) {
        // Extract cell content (remove HTML tags)
        const cellRegex = /<td[^>]*>(.*?)<\/td>/gs;
        const cells = [...row.matchAll(cellRegex)].map(m => m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim());
        
        if (cells.length < 4) continue;
        
        const productName = cells[0];
        const todayCol = cells[cells.length - 1]; // last column = 今日行情
        
        // Clean: remove arrows/symbols, extract number
        const priceMatch = todayCol.match(/(\d{3,5})/);
        if (!priceMatch) continue;
        const price = parseInt(priceMatch[1], 10);
        if (price < 500 || price > 5000) continue;
        
        // Match product
        if (productName.includes('飞天') && productName.includes('散') && !productName.includes('原')) {
          if (!sanping) sanping = price;
        } else if ((productName.includes('飞天') && productName.includes('原')) || productName.includes('原箱')) {
          if (!yuanxiang) yuanxiang = price;
        }
      }
    }
    
    // If current year (26年) not found, try older year (25年) — but only for early in the year
    if (!sanping && !yuanxiang) {
      // Try broader search: find any 飞天 row in any table
      const broadRegex = /<tr[^>]*>[\s\S]*?飞天[\s\S]*?(?:散|原)[\s\S]*?(\d{3,5})[\s\S]*?(\d{3,5})[\s\S]*?<\/tr>/i;
      // This is too imprecise, skip
    }
    
    if (sanping || yuanxiang) {
      const entry = {
        date,
        sanping: sanping || undefined,
        yuanxiang: yuanxiang || undefined,
        source: '今日酒价',
        note: article.title
      };
      
      // Determine guide price and signal
      const guidePrice = date >= '2026-03-31' ? 1539 : 1499;
      if (sanping) {
        entry.guide_price = guidePrice;
        entry.signal = sanping < guidePrice ? '🔴' : sanping <= 1800 ? '🟡' : '🟢';
      }
      
      existing.push(entry);
      existingDates.add(date);
      newPoints++;
      log(`[${i+1}/${todo.length}] ✅ ${date} 散=${sanping} 原=${yuanxiang} (${article.title.substring(0, 40)})`);
    } else {
      log(`[${i+1}/${todo.length}] ⚠️ ${date} — no price data extracted`);
    }
    
    processed.add(article.msgid);
    saveState();
    
    // Batch rest
    if (totalProcessed % BATCH_SIZE === 0 && i < todo.length - 1) {
      // Save data.json incrementally
      fs.writeFileSync(dataFile, JSON.stringify({ prices: existing }, null, 2));
      log(`💾 Batch checkpoint: ${existing.length} total, ${newPoints} new. Resting ${REST_BETWEEN_BATCHES/1000}s...`);
      await sleep(REST_BETWEEN_BATCHES);
    }
    
    // Small gap between articles
    await sleep(rand(2000, 4000));
  }
} finally {
  // Final save
  fs.writeFileSync(dataFile, JSON.stringify({ prices: existing }, null, 2));
  log(`\n=== DONE ===`);
  log(`Processed: ${totalProcessed} articles`);
  log(`New data points: ${newPoints}`);
  log(`Total in data.json: ${existing.length}`);
  log(`State: ${stateFile}`);
  
  // Clean up state on full completion
  if (processed.size >= articles.length) {
    try { fs.unlinkSync(stateFile); log('State file cleaned up'); } catch(e) {}
  }
  
  await browser.close();
  log('Browser closed');
}
