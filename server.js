const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const AV_KEY = process.env.ALPHAVANTAGE_KEY || '';
const TD_KEY = process.env.TWELVEDATA_KEY || '';

app.use(cors());
app.use(express.static(path.join(__dirname)));

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 60 * 1000; // 1 min

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://finance.yahoo.com',
};

// ── SOURCE 1: Yahoo Finance — 1Y daily data (live price + 52W in one call) ───
async function fetchFromYahoo() {
  const urls = [
    'https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=1y',
    'https://query2.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=1y',
  ];
  let lastErr;
  for (const url of urls) {
    try {
      const res = await axios.get(url, { timeout: 12000, headers: YAHOO_HEADERS });
      const result = res.data.chart.result[0];
      const meta   = result.meta;
      const quotes = result.indicators.quote[0];
      const highs  = quotes.high.filter(v => v != null);
      const lows   = quotes.low.filter(v => v != null);
      const closes = quotes.close.filter(v => v != null);
      if (!closes.length) throw new Error('empty data');

      const current   = meta.regularMarketPrice || closes[closes.length - 1];
      const prevClose = meta.chartPreviousClose  || closes[closes.length - 2];
      const high52    = Math.max(...highs);
      const low52     = Math.min(...lows);
      if (!current || !high52) throw new Error('zero values');

      const change    = parseFloat((current - prevClose).toFixed(2));
      const changePct = parseFloat(((change / prevClose) * 100).toFixed(2));

      return {
        current, prevClose, high52, low52,
        open:    meta.regularMarketOpen    || prevClose,
        dayHigh: meta.regularMarketDayHigh || current,
        dayLow:  meta.regularMarketDayLow  || current,
        change, changePct,
        isMarketOpen: meta.marketState === 'REGULAR',
        liveSource: 'yahoo', histSource: 'yahoo',
      };
    } catch(e) { lastErr = e; await new Promise(r => setTimeout(r, 500)); }
  }
  throw new Error('Yahoo: ' + lastErr.message);
}

// ── SOURCE 2: Twelve Data (correct symbol) + Yahoo for 52W ───────────────────
async function fetchFromTwelveData() {
  if (!TD_KEY) throw new Error('No TD key');
  // Correct Twelve Data symbol for Nifty 50 index
  const url = `https://api.twelvedata.com/quote?symbol=NIFTY&exchange=NSE&type=index&apikey=${TD_KEY}`;
  const res = await axios.get(url, { timeout: 10000 });
  const d = res.data;
  if (d.status === 'error' || d.code) throw new Error('TD: ' + d.message);
  const current = parseFloat(d.close);
  if (!current || current === 0) throw new Error('TD: zero price');

  const prevClose = parseFloat(d.previous_close) || current;
  const change    = parseFloat((current - prevClose).toFixed(2));
  const changePct = parseFloat(((change / prevClose) * 100).toFixed(2));

  // Get 52W from Yahoo since TD free tier doesn't give historical
  const yahooData = await fetchFromYahoo();

  return {
    current, prevClose,
    open:    parseFloat(d.open)  || prevClose,
    dayHigh: parseFloat(d.high)  || current,
    dayLow:  parseFloat(d.low)   || current,
    change, changePct,
    high52: yahooData.high52,
    low52:  yahooData.low52,
    isMarketOpen: d.is_market_open || false,
    liveSource: 'twelvedata', histSource: 'yahoo',
  };
}

// ── SOURCE 3: Alpha Vantage (resets daily, good backup) ──────────────────────
async function fetchFromAlphaVantage() {
  if (!AV_KEY) throw new Error('No AV key');

  // GLOBAL_QUOTE = current price (free)
  const qRes = await axios.get(
    `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=NSEI.BSE&apikey=${AV_KEY}`,
    { timeout: 12000 }
  );
  const quote = qRes.data['Global Quote'];
  if (!quote || !quote['05. price']) throw new Error('AV: ' + JSON.stringify(qRes.data).slice(0, 100));

  const current   = parseFloat(quote['05. price']);
  const prevClose = parseFloat(quote['08. previous close']);
  const change    = parseFloat((current - prevClose).toFixed(2));
  const changePct = parseFloat(((change / prevClose) * 100).toFixed(2));

  // Get 52W from Yahoo
  const yahooData = await fetchFromYahoo();

  return {
    current, prevClose,
    open:    parseFloat(quote['02. open']),
    dayHigh: parseFloat(quote['03. high']),
    dayLow:  parseFloat(quote['04. low']),
    change, changePct,
    high52: yahooData.high52,
    low52:  yahooData.low52,
    isMarketOpen: false,
    liveSource: 'alphavantage', histSource: 'yahoo',
  };
}

async function fetchAllData() {
  // Try sources in order
  const sources = [fetchFromTwelveData, fetchFromAlphaVantage, fetchFromYahoo];
  let lastErr;
  for (const fn of sources) {
    try {
      console.log(`[fetch] trying ${fn.name}...`);
      const data = await fn();
      console.log(`[fetch] ${fn.name} OK | price:${data.current} 52H:${data.high52} 52L:${data.low52}`);
      return data;
    } catch(e) {
      console.error(`[fetch] ${fn.name} failed: ${e.message}`);
      lastErr = e;
    }
  }
  throw new Error('All sources failed: ' + lastErr.message);
}

app.get('/api/nifty', async (req, res) => {
  // Serve from cache if fresh
  if (cache && Date.now() - cacheTime < CACHE_TTL) {
    return res.json({ ...cache, cached: true });
  }

  try {
    const data = await fetchAllData();
    const { current, prevClose, open, dayHigh, dayLow, change, changePct,
            high52, low52, isMarketOpen, liveSource, histSource } = data;

    const result = {
      current, prevClose, open, dayHigh, dayLow,
      change:    parseFloat((current - prevClose).toFixed(2)),
      changePct: parseFloat(((current - prevClose) / prevClose * 100).toFixed(2)),
      high52, low52,
      pctFromHigh: Math.max(0, parseFloat(((high52 - current) / high52 * 100).toFixed(2))),
      pctFromLow:  Math.max(0, parseFloat(((current - low52)  / low52  * 100).toFixed(2))),
      isMarketOpen, liveSource, histSource,
      liveStale: false, histStale: false,
      timestamp: new Date().toISOString(),
    };

    cache = result;
    cacheTime = Date.now();
    res.json(result);
  } catch(e) {
    console.error('[api/nifty] fatal:', e.message);
    // Serve stale cache rather than error
    if (cache) return res.json({ ...cache, liveStale: true, histStale: true });
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  cached: !!cache,
  source: cache?.liveSource,
  price: cache?.current,
  cacheAge: cache ? Math.round((Date.now() - cacheTime) / 1000) + 's' : null,
  tdKeyConfigured: !!TD_KEY,
  avKeyConfigured: !!AV_KEY,
}));

app.get('/api/debug', async (req, res) => {
  const out = {};
  try {
    const r = await axios.get(`https://api.twelvedata.com/quote?symbol=NIFTY&exchange=NSE&type=index&apikey=${TD_KEY}`, { timeout: 10000 });
    out.twelvedata = { ok: r.data.status !== 'error', price: r.data.close, raw: r.data };
  } catch(e) { out.twelvedata = { ok: false, error: e.message }; }

  try {
    const r = await axios.get(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=NSEI.BSE&apikey=${AV_KEY}`, { timeout: 12000 });
    out.alphavantage = { ok: !!r.data['Global Quote']?.['05. price'], data: r.data['Global Quote'] || r.data };
  } catch(e) { out.alphavantage = { ok: false, error: e.message }; }

  try {
    const r = await axios.get('https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=1y', { timeout: 10000, headers: YAHOO_HEADERS });
    const meta = r.data.chart.result[0].meta;
    out.yahoo = { ok: true, price: meta.regularMarketPrice, prevClose: meta.chartPreviousClose, marketState: meta.marketState };
  } catch(e) { out.yahoo = { ok: false, error: e.message }; }

  res.json(out);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, () => console.log(`✅ Nifty Tracker on port ${PORT}`));
