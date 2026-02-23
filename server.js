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

// Two separate caches:
// 1. liveCache — intraday current price (TTL 60s)
// 2. histCache — 52W high/low from daily data (TTL 1 hour)
let liveCache = null;
let liveCacheTime = 0;
const LIVE_TTL = 60 * 1000; // 1 min

let histCache = null;
let histCacheTime = 0;
const HIST_TTL = 60 * 60 * 1000; // 1 hour

// ── LIVE PRICE: Twelve Data ──────────────────────────────────────────────────
async function fetchLiveFromTwelveData() {
  if (!TD_KEY) throw new Error('No Twelve Data key');
  const url = `https://api.twelvedata.com/quote?symbol=NIFTY&exchange=NSE&apikey=${TD_KEY}`;
  const res = await axios.get(url, { timeout: 10000 });
  const d = res.data;
  if (d.status === 'error' || d.code) throw new Error('TwelveData: ' + (d.message || JSON.stringify(d)));

  const current   = parseFloat(d.close);
  const prevClose = parseFloat(d.previous_close);
  const open      = parseFloat(d.open);
  const dayHigh   = parseFloat(d.high);
  const dayLow    = parseFloat(d.low);
  const change    = parseFloat((current - prevClose).toFixed(2));
  const changePct = parseFloat(((change / prevClose) * 100).toFixed(2));
  const isMarketOpen = d.is_market_open;

  return { current, prevClose, open, dayHigh, dayLow, change, changePct, isMarketOpen, liveSource: 'twelvedata' };
}

// ── LIVE PRICE FALLBACK: Yahoo Finance ───────────────────────────────────────
async function fetchLiveFromYahoo() {
  const urls = [
    'https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1m&range=1d',
    'https://query2.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1m&range=1d',
  ];
  let lastErr;
  for (const url of urls) {
    try {
      const res = await axios.get(url, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com' },
      });
      const meta = res.data.chart.result[0].meta;
      const current   = meta.regularMarketPrice;
      const prevClose = meta.chartPreviousClose;
      const change    = parseFloat((current - prevClose).toFixed(2));
      const changePct = parseFloat(((change / prevClose) * 100).toFixed(2));
      return {
        current,
        prevClose,
        open:      meta.regularMarketOpen    || prevClose,
        dayHigh:   meta.regularMarketDayHigh || current,
        dayLow:    meta.regularMarketDayLow  || current,
        change,
        changePct,
        isMarketOpen: meta.marketState === 'REGULAR',
        liveSource: 'yahoo',
      };
    } catch(e) { lastErr = e; await new Promise(r => setTimeout(r, 400)); }
  }
  throw lastErr;
}

// ── HISTORICAL 52W: Alpha Vantage ────────────────────────────────────────────
async function fetchHistFromAlphaVantage() {
  if (!AV_KEY) throw new Error('No Alpha Vantage key');
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=NSEI.BSE&outputsize=full&apikey=${AV_KEY}`;
  const res = await axios.get(url, { timeout: 15000 });
  const ts = res.data['Time Series (Daily)'];
  if (!ts) throw new Error('AV: ' + (res.data['Note'] || res.data['Information'] || 'No data'));

  const dates     = Object.keys(ts).sort().reverse();
  const yearDates = dates.slice(0, 252);
  const high52    = Math.max(...yearDates.map(d => parseFloat(ts[d]['2. high'])));
  const low52     = Math.min(...yearDates.map(d => parseFloat(ts[d]['3. low'])));
  const prevClose = parseFloat(ts[dates[0]]['4. close']); // latest EOD close as fallback

  return { high52, low52, prevClose, histSource: 'alphavantage' };
}

// ── HISTORICAL 52W FALLBACK: Stooq ───────────────────────────────────────────
async function fetchHistFromStooq() {
  const res = await axios.get('https://stooq.com/q/d/l/?s=^nsei&i=d', {
    timeout: 10000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const lines = res.data.trim().split('\n').filter(l => l.trim() && !l.startsWith('Date'));
  if (lines.length < 2) throw new Error('Stooq: not enough data');

  const parse   = line => line.split(',').map(v => v.trim());
  const last    = parse(lines[lines.length - 1]);
  const prevClose = parseFloat(last[4]);
  if (!prevClose) throw new Error('Stooq: invalid data');

  const yearLines = lines.slice(-252);
  const high52 = Math.max(...yearLines.map(l => parseFloat(parse(l)[2])).filter(Boolean));
  const low52  = Math.min(...yearLines.map(l => parseFloat(parse(l)[3])).filter(Boolean));

  return { high52, low52, prevClose, histSource: 'stooq' };
}

// ── COMBINED FETCH ────────────────────────────────────────────────────────────
async function getHistData() {
  // Return cache if fresh
  if (histCache && Date.now() - histCacheTime < HIST_TTL) return histCache;

  const fns = [fetchHistFromAlphaVantage, fetchHistFromStooq];
  for (const fn of fns) {
    try {
      const data = await fn();
      histCache = data;
      histCacheTime = Date.now();
      console.log(`[hist] ${fn.name} OK — 52W H:${data.high52} L:${data.low52}`);
      return data;
    } catch(e) { console.error(`[hist] ${fn.name} failed: ${e.message}`); }
  }
  // Return stale hist cache rather than fail
  if (histCache) { console.warn('[hist] all failed, using stale cache'); return { ...histCache, histStale: true }; }
  throw new Error('Could not fetch 52W historical data');
}

async function getLiveData(fallbackPrevClose) {
  // Return cache if fresh
  if (liveCache && Date.now() - liveCacheTime < LIVE_TTL) return liveCache;

  const fns = [fetchLiveFromTwelveData, fetchLiveFromYahoo];
  for (const fn of fns) {
    try {
      const data = await fn();
      liveCache = data;
      liveCacheTime = Date.now();
      console.log(`[live] ${fn.name} OK — price:${data.current} marketOpen:${data.isMarketOpen}`);
      return data;
    } catch(e) { console.error(`[live] ${fn.name} failed: ${e.message}`); }
  }

  // All live sources failed — build a fallback from hist prevClose
  if (fallbackPrevClose) {
    console.warn('[live] all failed, using prevClose as current');
    return {
      current: fallbackPrevClose,
      prevClose: fallbackPrevClose,
      open: fallbackPrevClose,
      dayHigh: fallbackPrevClose,
      dayLow: fallbackPrevClose,
      change: 0,
      changePct: 0,
      isMarketOpen: false,
      liveSource: 'prev_close_fallback',
    };
  }

  // Return stale live cache
  if (liveCache) { console.warn('[live] all failed, using stale live cache'); return { ...liveCache, liveStale: true }; }
  throw new Error('Could not fetch live price');
}

// ── MAIN API ──────────────────────────────────────────────────────────────────
app.get('/api/nifty', async (req, res) => {
  try {
    // Fetch hist and live in parallel for speed
    const [hist, live] = await Promise.all([
      getHistData(),
      getLiveData(null),
    ]).catch(async () => {
      // If parallel fails, try sequentially
      const h = await getHistData();
      const l = await getLiveData(h.prevClose);
      return [h, l];
    });

    const { high52, low52, histSource, histStale } = hist;
    const { current, prevClose, open, dayHigh, dayLow, change, changePct, isMarketOpen, liveSource, liveStale } = live;

    const pctFromHigh = parseFloat(((high52 - current) / high52 * 100).toFixed(2));
    const pctFromLow  = parseFloat(((current - low52)  / low52  * 100).toFixed(2));

    res.json({
      current, prevClose, open, dayHigh, dayLow,
      change: parseFloat((current - prevClose).toFixed(2)),
      changePct: parseFloat(((current - prevClose) / prevClose * 100).toFixed(2)),
      high52, low52,
      pctFromHigh: Math.max(0, pctFromHigh), // never negative display
      pctFromLow:  Math.max(0, pctFromLow),
      isMarketOpen,
      liveSource,
      histSource,
      liveStale: !!liveStale,
      histStale: !!histStale,
      timestamp: new Date().toISOString(),
    });

  } catch(e) {
    console.error('[api/nifty] fatal:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  liveCache: !!liveCache,
  histCache: !!histCache,
  liveSource: liveCache?.liveSource,
  histSource: histCache?.histSource,
  liveCacheAge: liveCache ? Math.round((Date.now() - liveCacheTime) / 1000) + 's' : null,
  histCacheAge: histCache ? Math.round((Date.now() - histCacheTime) / 60000) + 'min' : null,
  tdKeyConfigured: !!TD_KEY,
  avKeyConfigured: !!AV_KEY,
}));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`✅ Nifty Tracker running on port ${PORT}`));
