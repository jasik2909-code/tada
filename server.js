const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio'); // якщо використовуєш

const app = express();
app.use(cors());

// --- (за бажанням) HEALTH ---
app.get('/health', (req, res) => res.json({ ok: true }));

// ——— helpers ———
function toAbsoluteUrl(possiblyRelative, base) {
  try { if (!possiblyRelative) return null; return new URL(possiblyRelative, base).href; } catch { return null; }
}
function normalizePrice(p) {
  if (!p) return null;
  return String(p).replace(/\u00A0/g, '').replace(/\s+/g, '').replace(',', '.').replace(/[^\d.]/g, '') || null;
}
function numbersNearCurrency(txt) {
  if (!txt) return [];
  const t = txt.replace(/\u00A0/g, ' ');
  const nums = [];
  let m;
  const reAfter = /(\d[\d\s.,]*)\s*(?:грн|₴)\b/gi;
  const reBefore = /\b(?:грн|₴)\s*(\d[\d\s.,]*)/gi;
  while ((m = reAfter.exec(t))) { const n = normalizePrice(m[1]); if (n) nums.push(n); }
  while ((m = reBefore.exec(t))) { const n = normalizePrice(m[1]); if (n) nums.push(n); }
  return nums;
}
function parseJsonLd($) {
  const out = [];
  $('script[type="application/ld+json"]').each(function (_, el) {
    try {
      const text = $(el).text().trim();
      if (!text) return;
      const data = JSON.parse(text);
      if (Array.isArray(data)) out.push(...data); else out.push(data);
    } catch {}
  });
  return out;
}
function pickProductFromJsonLd(jsonLds) {
  for (const obj of jsonLds) {
    if (!obj) continue;
    if (obj['@graph'] && Array.isArray(obj['@graph'])) {
      const p = obj['@graph'].find(n => {
        const t = n['@type']; return t === 'Product' || (Array.isArray(t) && t.includes('Product'));
      });
      if (p) return p;
    }
    const t = obj['@type']; if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) return obj;
  }
  return null;
}
function extractPriceFromOffers(offers) {
  if (!offers) return {};
  const arr = Array.isArray(offers) ? offers : [offers];
  for (const o of arr) {
    const price = (o && (o.price || o.lowPrice || o.highPrice)) || null;
    const currency = (o && o.priceCurrency) || null;
    if (price) return { price: String(price), currency: currency || null };
  }
  return {};
}
function extractFromMeta($, baseUrl) {
  const meta = (sel, attr = 'content') => {
    const el = $(sel).first(); return el && el.attr(attr) ? el.attr(attr).trim() : null;
  };
  return {
    title: meta('meta[property="og:title"]') || null,
    description: meta('meta[name="description"]') || meta('meta[property="og:description"]') || null,
    price: meta('meta[property="product:price:amount"]') || meta('meta[itemprop="price"]') || null,
    image: toAbsoluteUrl(meta('meta[property="og:image"]'), baseUrl)
  };
}
function extractCode($) {
  const skuText = $('[itemprop="sku"]').first().text().trim();
  const skuAttr = $('[itemprop="sku"]').attr('content');
  const sku = (skuText || skuAttr || '').trim();
  if (sku) return sku;
  const t = $('body').text() || '';
  const m = t.match(/\b(Артикул|Код(?: товару)?):?\s*([A-Za-zА-Яа-я0-9\-]+)/i);
  return m ? m[2] : null;
}

// ——— DOM: точні селектори ta-da.ua ———
function extractTaDaPricesFromHtml($) {
  let newPrice = null, oldPrice = null;

  const getPrice = (sel) => {
    const main = $(sel).clone().children().remove().end().text().trim();
    const cents = $(sel).find('span').first().text().trim();
    let combined = main;
    if (cents && /^[.,]\d+/.test(cents)) {
      combined += cents; // додаємо копійки, якщо вони починаються з . або ,
    }
    return normalizePrice(combined);
  };

  if ($('[class*="price_current_price__"]').length) {
    newPrice = getPrice('[class*="price_current_price__"]');
  }
  if ($('[class*="price_old_price__"]').length) {
    oldPrice = getPrice('[class*="price_old_price__"]');
  }

  return { newPrice, oldPrice, currency: 'грн' };
}

// ——— Puppeteer fallback (коли ціна рендериться JS) ———
async function tryPuppeteer(url) {
  let puppeteer;
  try { puppeteer = require('puppeteer'); } catch { return null; }
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    // чекаємо появи блоків ціни
    await page.waitForFunction(() => {
      return document.querySelector('[class*="price_current_price__"]') || document.querySelector('[class*="price_old_price__"]');
    }, { timeout: 8000 }).catch(() => {});

    const texts = await page.evaluate(() => {
      const getTxt = sel => {
        const el = document.querySelector(sel);
        return el ? el.textContent : '';
      };
      return {
        curr: getTxt('[class*="price_current_price__"]'),
        old:  getTxt('[class*="price_old_price__"]')
      };
    });
    const numsCurr = numbersNearCurrency(texts.curr || '');
    const numsOld  = numbersNearCurrency(texts.old || '');
    const newPrice = numsCurr[0] || null;
    const oldPrice = numsOld[0] || null;
    if (newPrice || oldPrice) return { newPrice, oldPrice, currency: 'грн' };
    return null;
  } finally {
    await browser.close().catch(() => {});
  }

  function numbersNearCurrency(txt) {
    if (!txt) return [];
    const t = txt.replace(/\u00A0/g, ' ');
    const out = [];
    let m;
    const reAfter = /(\d[\d\s.,]*)\s*(?:грн|₴)\b/gi;
    const reBefore = /\b(?:грн|₴)\s*(\d[\d\s.,]*)/gi;
    while ((m = reAfter.exec(t))) { const n = (m[1]||'').replace(/\u00A0/g,'').replace(/\s+/g,'').replace(',','.').replace(/[^\d.]/g,''); if (n) out.push(n); }
    while ((m = reBefore.exec(t))) { const n = (m[1]||'').replace(/\u00A0/g,'').replace(/\s+/g,'').replace(',','.').replace(/[^\d.]/g,''); if (n) out.push(n); }
    return out;
  }
}

// ——— main parsing ———
async function parseProduct(url) {
  // 1) сирий HTML
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36',
      'Accept-Language': 'uk,ru;q=0.9,en;q=0.8'
    },
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`Upstream status ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();

  // 2) метадані/JSON-LD
  const jsonLds = parseJsonLd($);
  const productLD = pickProductFromJsonLd(jsonLds) || null;

  let title = productLD?.name || null;
  let description = productLD?.description || null;
  const { price: ldPrice, currency: ldCur } = extractPriceFromOffers(productLD?.offers);
  let priceFromLd = normalizePrice(ldPrice);
  let currency = ldCur && String(ldCur).toUpperCase() === 'UAH' ? 'грн' : (ldCur || null);

  const meta = extractFromMeta($, url);
  title = title || meta.title || $('title').text().trim() || null;
  description = description || meta.description || null;
  if (!priceFromLd && meta.price) priceFromLd = normalizePrice(meta.price);

  // images
  let images = [];
  if (productLD?.image) images = Array.isArray(productLD.image) ? productLD.image : [productLD.image];
  if (!images.length && meta.image) images = [meta.image];
  images = images.map(i => toAbsoluteUrl(i, url)).filter(Boolean);

  // 3) ціни з DOM (точно для ta-da.ua)
  let newPrice = null, oldPrice = null;
  if (host.endsWith('ta-da.ua')) {
    const domPrices = extractTaDaPricesFromHtml($);
    newPrice = domPrices.newPrice || null;
    oldPrice = domPrices.oldPrice || null;
    currency = 'грн';
  }

  // 4) Якщо акційну ціну не знайшли у HTML — пробуємо Puppeteer (рендер JS)
  if (host.endsWith('ta-da.ua') && !newPrice) {
    const pptr = await tryPuppeteer(url);
    if (pptr) {
      newPrice = pptr.newPrice || newPrice;
      oldPrice = pptr.oldPrice || oldPrice;
      currency = 'грн';
    }
  }

  const finalPrice = normalizePrice(newPrice || priceFromLd);

  return {
    url,
    title: title || null,
    description: description || null,
    code: productLD?.sku || productLD?.mpn || extractCode($) || null,
    price: finalPrice || null,              // акційна/поточна
    oldPrice: normalizePrice(oldPrice),     // стара
    currency: currency || 'грн',
    images
  };
}

// ——— routes ———
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/product', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'No URL provided. Use ?url=https://ta-da.ua/products/...' });
  try {
    const data = await parseProduct(url);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get('/image', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('No url');
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' } });
    if (!r.ok) return res.status(r.status).send(`Upstream ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(buf);
  } catch (e) {
    res.status(500).send(e.message || 'image proxy error');
  }
});

// Корінь і health (залиш один раз)
app.get('/', (req, res) => res.send('OK. Use /health or /product?url=...'));
app.get('/health', (req, res) => res.json({ ok: true }));

// Запуск сервера (лише один раз)
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxy running on ${PORT}`);
});