const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const AV_KEY = process.env.ALPHAVANTAGE_KEY || '';

app.use(cors());
app.use(express.static(path.join(__dirname)));

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 60 * 1000;

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://finance.yahoo.com',
};

// ── Yahoo: fetch 1Y daily data — gives current price, prev close, 52W H/L ────
async function fetchFromYahoo() {
  const urls = [
    'https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=1y',
    'https://query2.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=1y',
  ];
  let lastErr;
  for (const url of urls) {
    try {
      const res = await axios.get(url, { timeout: 12000, headers: YAHOO_HEADERS });
      const result    = res.data.chart.result[0];
      const meta      = result.meta;
      const quotes    = result.indicators.quote[0];
      const closes    = quotes.close.filter(v => v != null);
      const highs     = quotes.high.filter(v => v != null);
      const lows      = quotes.low.filter(v => v != null);
      const opens     = quotes.open.filter(v => v != null);

      if (!closes.length) throw new Error('empty data');

      const current   = meta.regularMarketPrice || closes[closes.length - 1];

      // prevClose = second to last close in the daily series (actual previous day)
      const prevClose = closes[closes.length - 2];

      const high52    = Math.max(...highs);
      const low52     = Math.min(...lows);
      const open      = meta.regularMarketOpen || opens[opens.length - 1];
      const dayHigh   = meta.regularMarketDayHigh || Math.max(...quotes.high.slice(-1).filter(Boolean));
      const dayLow    = meta.regularMarketDayLow  || Math.min(...quotes.low.slice(-1).filter(Boolean));

      if (!current || !high52 || !prevClose) throw new Error('missing values');

      const change    = parseFloat((current - prevClose).toFixed(2));
      const changePct = parseFloat(((change / prevClose) * 100).toFixed(2));

      console.log(`[yahoo] OK | price:${current} prev:${prevClose} 52H:${high52} 52L:${low52} change:${change}(${changePct}%)`);

      return {
        current, prevClose, open, dayHigh, dayLow,
        change, changePct, high52, low52,
        isMarketOpen: meta.marketState === 'REGULAR',
        liveSource: 'yahoo', histSource: 'yahoo',
      };
    } catch(e) {
      lastErr = e;
      console.error(`[yahoo] failed: ${e.message}`);
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error('Yahoo failed: ' + lastErr.message);
}

// ── Alpha Vantage: better accuracy when rate limit resets ─────────────────────
async function fetchFromAlphaVantage() {
  if (!AV_KEY) throw new Error('No AV key');
  const qRes = await axios.get(
    `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=NSEI.BSE&apikey=${AV_KEY}`,
    { timeout: 12000 }
  );
  const quote = qRes.data['Global Quote'];
  if (!quote || !quote['05. price']) throw new Error('AV rate limit or no data');

  const current   = parseFloat(quote['05. price']);
  const prevClose = parseFloat(quote['08. previous close']);
  const change    = parseFloat((current - prevClose).toFixed(2));
  const changePct = parseFloat(((change / prevClose) * 100).toFixed(2));

  // Get 52W from Yahoo
  const yahoo = await fetchFromYahoo();

  console.log(`[AV] OK | price:${current} prev:${prevClose}`);
  return {
    current, prevClose,
    open:    parseFloat(quote['02. open']),
    dayHigh: parseFloat(quote['03. high']),
    dayLow:  parseFloat(quote['04. low']),
    change, changePct,
    high52: yahoo.high52,
    low52:  yahoo.low52,
    isMarketOpen: false,
    liveSource: 'alphavantage', histSource: 'yahoo',
  };
}

app.get('/api/nifty', async (req, res) => {
  if (cache && Date.now() - cacheTime < CACHE_TTL) {
    return res.json({ ...cache, cached: true });
  }

  try {
    // Try AV first (more accurate), fallback to Yahoo
    let data;
    try { data = await fetchFromAlphaVantage(); }
    catch(e) {
      console.log('[api] AV failed, using Yahoo:', e.message);
      data = await fetchFromYahoo();
    }

    const result = {
      ...data,
      pctFromHigh: Math.max(0, parseFloat(((data.high52 - data.current) / data.high52 * 100).toFixed(2))),
      pctFromLow:  Math.max(0, parseFloat(((data.current - data.low52)  / data.low52  * 100).toFixed(2))),
      liveStale: false, histStale: false,
      timestamp: new Date().toISOString(),
    };

    cache = result;
    cacheTime = Date.now();
    res.json(result);

  } catch(e) {
    console.error('[api/nifty] fatal:', e.message);
    if (cache) return res.json({ ...cache, liveStale: true, histStale: true });
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  cached: !!cache,
  source: cache?.liveSource,
  price: cache?.current,
  prevClose: cache?.prevClose,
  cacheAge: cache ? Math.round((Date.now() - cacheTime) / 1000) + 's' : null,
  avKeyConfigured: !!AV_KEY,
}));

app.get('/api/debug', async (req, res) => {
  const out = {};
  try {
    const r = await axios.get(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=NSEI.BSE&apikey=${AV_KEY}`, { timeout: 12000 });
    out.alphavantage = { ok: !!r.data['Global Quote']?.['05. price'], data: r.data['Global Quote'] || r.data };
  } catch(e) { out.alphavantage = { ok: false, error: e.message }; }

  try {
    const r = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=1y', { timeout: 10000, headers: YAHOO_HEADERS });
    const result = r.data.chart.result[0];
    const closes = result.indicators.quote[0].close.filter(Boolean);
    const highs  = result.indicators.quote[0].high.filter(Boolean);
    const lows   = result.indicators.quote[0].low.filter(Boolean);
    out.yahoo = {
      ok: true,
      current:   result.meta.regularMarketPrice,
      prevClose: closes[closes.length - 2],
      high52:    Math.max(...highs),
      low52:     Math.min(...lows),
      marketState: result.meta.marketState,
    };
  } catch(e) { out.yahoo = { ok: false, error: e.message }; }

  res.json(out);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, () => console.log(`✅ Nifty Tracker on port ${PORT}`));
