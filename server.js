const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const AV_KEY = process.env.ALPHAVANTAGE_KEY || '';

app.use(cors());
app.use(express.static(path.join(__dirname)));

// Cache — serve stale data rather than fail
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 60 * 1000; // 1 min

// ── SOURCE 1: Stooq (no key, no auth, server-friendly) ──────────────────────
async function fetchFromStooq() {
  // Stooq CSV endpoint for Nifty 50
  const url = 'https://stooq.com/q/d/l/?s=^nsei&i=d';
  const res = await axios.get(url, {
    timeout: 10000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  // Parse CSV: Date,Open,High,Low,Close,Volume
  const lines = res.data.trim().split('\n').filter(l => l && !l.startsWith('Date'));
  if (!lines.length) throw new Error('Stooq returned empty data');

  // Last line = most recent trading day
  const last = lines[lines.length - 1].split(',');
  const prev = lines[lines.length - 2]?.split(',');

  const current   = parseFloat(last[4]); // Close
  const dayHigh   = parseFloat(last[2]);
  const dayLow    = parseFloat(last[3]);
  const open      = parseFloat(last[1]);
  const prevClose = prev ? parseFloat(prev[4]) : current;
  const change    = parseFloat((current - prevClose).toFixed(2));
  const changePct = parseFloat(((change / prevClose) * 100).toFixed(2));

  // Compute 52W high/low from last 252 trading days (~1 year)
  const yearLines = lines.slice(-252);
  const highs  = yearLines.map(l => parseFloat(l.split(',')[2])).filter(Boolean);
  const lows   = yearLines.map(l => parseFloat(l.split(',')[3])).filter(Boolean);
  const high52 = Math.max(...highs);
  const low52  = Math.min(...lows);

  return {
    current, change, changePct, high52, low52,
    pctFromHigh: parseFloat(((high52 - current) / high52 * 100).toFixed(2)),
    pctFromLow:  parseFloat(((current - low52)  / low52  * 100).toFixed(2)),
    dayHigh, dayLow, open, prevClose,
    source: 'stooq',
    timestamp: new Date().toISOString(),
  };
}

// ── SOURCE 2: Alpha Vantage (free key required) ──────────────────────────────
async function fetchFromAlphaVantage() {
  if (!AV_KEY) throw new Error('No Alpha Vantage key configured');
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=NSEI.BSE&outputsize=full&apikey=${AV_KEY}`;
  const res = await axios.get(url, { timeout: 15000 });
  const ts = res.data['Time Series (Daily)'];
  if (!ts) throw new Error('Alpha Vantage: ' + (res.data['Note'] || res.data['Information'] || 'No data'));

  const dates  = Object.keys(ts).sort().reverse(); // newest first
  const latest = ts[dates[0]];
  const prev   = ts[dates[1]];

  const current   = parseFloat(latest['4. close']);
  const prevClose = parseFloat(prev['4. close']);
  const change    = parseFloat((current - prevClose).toFixed(2));
  const changePct = parseFloat(((change / prevClose) * 100).toFixed(2));

  // 52W = last 252 trading days
  const yearDates = dates.slice(0, 252);
  const highs = yearDates.map(d => parseFloat(ts[d]['2. high']));
  const lows  = yearDates.map(d => parseFloat(ts[d]['3. low']));
  const high52 = Math.max(...highs);
  const low52  = Math.min(...lows);

  return {
    current, change, changePct, high52, low52,
    pctFromHigh: parseFloat(((high52 - current) / high52 * 100).toFixed(2)),
    pctFromLow:  parseFloat(((current - low52)  / low52  * 100).toFixed(2)),
    dayHigh:   parseFloat(latest['2. high']),
    dayLow:    parseFloat(latest['3. low']),
    open:      parseFloat(latest['1. open']),
    prevClose,
    source: 'alphavantage',
    timestamp: new Date().toISOString(),
  };
}

// ── SOURCE 3: Yahoo Finance (last resort) ────────────────────────────────────
async function fetchFromYahoo() {
  const urls = [
    'https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=1y',
    'https://query2.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=1y',
  ];
  let lastErr;
  for (const url of urls) {
    try {
      const res = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/json',
          'Referer': 'https://finance.yahoo.com',
        },
      });
      const result  = res.data.chart.result[0];
      const meta    = result.meta;
      const quotes  = result.indicators.quote[0];
      const highs   = quotes.high.filter(Boolean);
      const lows    = quotes.low.filter(Boolean);
      const current    = meta.regularMarketPrice;
      const high52     = Math.max(...highs);
      const low52      = Math.min(...lows);
      const prevClose  = meta.chartPreviousClose;
      const change     = parseFloat((current - prevClose).toFixed(2));
      const changePct  = parseFloat(((change / prevClose) * 100).toFixed(2));
      return {
        current, change, changePct, high52, low52,
        pctFromHigh: parseFloat(((high52 - current) / high52 * 100).toFixed(2)),
        pctFromLow:  parseFloat(((current - low52)  / low52  * 100).toFixed(2)),
        dayHigh: meta.regularMarketDayHigh || current,
        dayLow:  meta.regularMarketDayLow  || current,
        open:    meta.regularMarketOpen    || current,
        prevClose,
        source: 'yahoo',
        timestamp: new Date().toISOString(),
      };
    } catch(e) { lastErr = e; await new Promise(r => setTimeout(r, 500)); }
  }
  throw lastErr;
}

// ── MAIN API ENDPOINT ────────────────────────────────────────────────────────
app.get('/api/nifty', async (req, res) => {
  // Serve fresh cache
  if (cache && Date.now() - cacheTime < CACHE_TTL) {
    return res.json({ ...cache, cached: true });
  }

  const sources = [fetchFromStooq, fetchFromAlphaVantage, fetchFromYahoo];
  const errors  = [];

  for (const fn of sources) {
    try {
      console.log(`[${new Date().toISOString()}] Trying ${fn.name}...`);
      const data = await fn();
      cache = data;
      cacheTime = Date.now();
      console.log(`[OK] ${fn.name} succeeded`);
      return res.json(data);
    } catch(e) {
      console.error(`[FAIL] ${fn.name}: ${e.message}`);
      errors.push(`${fn.name}: ${e.message}`);
    }
  }

  // All failed — return stale cache if available
  if (cache) {
    console.warn('All sources failed, serving stale cache');
    return res.json({ ...cache, stale: true });
  }

  res.status(500).json({ error: 'All sources failed', details: errors });
});

app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  cached: !!cache,
  source: cache?.source,
  cacheAge: cache ? Math.round((Date.now() - cacheTime) / 1000) + 's' : null,
  avKeyConfigured: !!AV_KEY,
}));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`✅ Nifty Tracker running on port ${PORT}`));
