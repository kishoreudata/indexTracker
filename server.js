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

let liveCache = null, liveCacheTime = 0;
let histCache = null, histCacheTime = 0;
const LIVE_TTL = 60 * 1000;
const HIST_TTL = 60 * 60 * 1000;

// ── FIX 1: Twelve Data — correct symbol for Nifty 50 ─────────────────────────
async function fetchLiveFromTwelveData() {
  if (!TD_KEY) throw new Error('No TD key');
  // Try multiple symbol formats
  const symbols = [
    'NIFTY50:NSE',
    'NIFTY_50:NSE', 
    'NIFTY 50:NSE',
  ];
  let lastErr;
  for (const symbol of symbols) {
    try {
      const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&apikey=${TD_KEY}`;
      const res = await axios.get(url, { timeout: 10000 });
      const d = res.data;
      if (d.status === 'error' || d.code) throw new Error(d.message || JSON.stringify(d));
      const current = parseFloat(d.price);
      if (!current || current === 0) throw new Error('zero price');

      // Get more details
      const quoteUrl = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${TD_KEY}`;
      const qRes = await axios.get(quoteUrl, { timeout: 10000 });
      const q = qRes.data;
      const prevClose = parseFloat(q.previous_close) || current;
      const change    = parseFloat((current - prevClose).toFixed(2));
      const changePct = parseFloat(((change / prevClose) * 100).toFixed(2));

      console.log(`[TD] symbol ${symbol} worked! price:${current}`);
      return {
        current, prevClose,
        open:    parseFloat(q.open)  || prevClose,
        dayHigh: parseFloat(q.high)  || current,
        dayLow:  parseFloat(q.low)   || current,
        change, changePct,
        isMarketOpen: q.is_market_open || false,
        liveSource: 'twelvedata',
      };
    } catch(e) {
      lastErr = e;
      console.error(`[TD] symbol ${symbol} failed: ${e.message}`);
    }
  }
  throw new Error('TD all symbols failed: ' + lastErr.message);
}

// ── LIVE FALLBACK: Yahoo Finance ──────────────────────────────────────────────
async function fetchLiveFromYahoo() {
  const urls = [
    'https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=5d',
    'https://query2.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=5d',
  ];
  let lastErr;
  for (const url of urls) {
    try {
      const res = await axios.get(url, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.yahoo.com' },
      });
      const meta   = res.data.chart.result[0].meta;
      const quotes = res.data.chart.result[0].indicators.quote[0];
      const closes = quotes.close.filter(Boolean);
      const current   = meta.regularMarketPrice || closes[closes.length - 1];
      const prevClose = meta.chartPreviousClose  || closes[closes.length - 2];
      if (!current || current === 0) throw new Error('zero price');
      const change    = parseFloat((current - prevClose).toFixed(2));
      const changePct = parseFloat(((change / prevClose) * 100).toFixed(2));
      return {
        current, prevClose,
        open:    meta.regularMarketOpen    || prevClose,
        dayHigh: meta.regularMarketDayHigh || current,
        dayLow:  meta.regularMarketDayLow  || current,
        change, changePct,
        isMarketOpen: meta.marketState === 'REGULAR',
        liveSource: 'yahoo',
      };
    } catch(e) { lastErr = e; await new Promise(r => setTimeout(r, 400)); }
  }
  throw lastErr;
}

// ── FIX 2: Alpha Vantage — use GLOBAL_QUOTE + TIME_SERIES_WEEKLY (both free) ─
async function fetchHistFromAlphaVantage() {
  if (!AV_KEY) throw new Error('No AV key');

  // GLOBAL_QUOTE is free and gives current price + prev close
  const quoteRes = await axios.get(
    `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=NSEI.BSE&apikey=${AV_KEY}`,
    { timeout: 12000 }
  );
  const quote = quoteRes.data['Global Quote'];
  if (!quote || !quote['05. price']) {
    throw new Error('AV GLOBAL_QUOTE: ' + JSON.stringify(quoteRes.data).slice(0, 150));
  }

  const eodClose  = parseFloat(quote['05. price']);
  const prevClose = parseFloat(quote['08. previous close']);
  const eodOpen   = parseFloat(quote['02. open']);
  const eodHigh   = parseFloat(quote['03. high']);
  const eodLow    = parseFloat(quote['04. low']);

  // Add delay to avoid rate limit (1 req/sec on free tier)
  await new Promise(r => setTimeout(r, 1200));

  // TIME_SERIES_WEEKLY is free and gives us 52W range
  const weeklyRes = await axios.get(
    `https://www.alphavantage.co/query?function=TIME_SERIES_WEEKLY&symbol=NSEI.BSE&apikey=${AV_KEY}`,
    { timeout: 15000 }
  );
  const weeklyTs = weeklyRes.data['Weekly Time Series'];
  if (!weeklyTs) {
    throw new Error('AV WEEKLY: ' + JSON.stringify(weeklyRes.data).slice(0, 150));
  }

  const weeks  = Object.keys(weeklyTs).sort().reverse().slice(0, 52);
  const high52 = Math.max(...weeks.map(w => parseFloat(weeklyTs[w]['2. high'])));
  const low52  = Math.min(...weeks.map(w => parseFloat(weeklyTs[w]['3. low'])));

  console.log(`[AV] OK | EOD:${eodClose} 52H:${high52} 52L:${low52}`);
  return { eodClose, prevClose, eodOpen, eodHigh, eodLow, high52, low52, histSource: 'alphavantage' };
}

// ── FIX 3: Stooq — use monthly interval which returns more data ───────────────
async function fetchHistFromStooq() {
  // Use monthly data which has enough rows even on free tier
  const res = await axios.get('https://stooq.com/q/d/l/?s=^nsei&i=m', {
    timeout: 12000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });

  const lines = res.data.trim().split('\n').filter(l => l.trim() && !l.startsWith('Date'));
  console.log(`[Stooq] monthly lines: ${lines.length}`);
  if (lines.length < 13) throw new Error(`Stooq: only ${lines.length} lines`);

  const parse     = line => line.split(',').map(v => v.trim());
  const last      = parse(lines[lines.length - 1]);
  const prev      = parse(lines[lines.length - 2]);
  const eodClose  = parseFloat(last[4]);
  const prevClose = parseFloat(prev[4]);
  if (!eodClose)  throw new Error('Stooq: invalid close');

  // 52W = last 12 monthly rows
  const yearLines = lines.slice(-13);
  const high52 = Math.max(...yearLines.map(l => parseFloat(parse(l)[2])).filter(Boolean));
  const low52  = Math.min(...yearLines.map(l => parseFloat(parse(l)[3])).filter(Boolean));

  console.log(`[Stooq] OK | EOD:${eodClose} 52H:${high52} 52L:${low52}`);
  return {
    eodClose, prevClose,
    eodOpen:  parseFloat(last[1]),
    eodHigh:  parseFloat(last[2]),
    eodLow:   parseFloat(last[3]),
    high52, low52,
    histSource: 'stooq',
  };
}

async function getHistData() {
  if (histCache && Date.now() - histCacheTime < HIST_TTL) return histCache;
  for (const fn of [fetchHistFromAlphaVantage, fetchHistFromStooq]) {
    try {
      const data = await fn();
      histCache = data; histCacheTime = Date.now();
      return data;
    } catch(e) { console.error(`[hist] ${fn.name} failed: ${e.message}`); }
  }
  if (histCache) { console.warn('[hist] stale cache'); return { ...histCache, histStale: true }; }
  throw new Error('All hist sources failed');
}

async function getLiveData() {
  if (liveCache && Date.now() - liveCacheTime < LIVE_TTL) return liveCache;
  for (const fn of [fetchLiveFromTwelveData, fetchLiveFromYahoo]) {
    try {
      const data = await fn();
      liveCache = data; liveCacheTime = Date.now();
      return data;
    } catch(e) { console.error(`[live] ${fn.name} failed: ${e.message}`); }
  }
  if (liveCache) { console.warn('[live] stale cache'); return { ...liveCache, liveStale: true }; }
  return null;
}

// ── MAIN API ──────────────────────────────────────────────────────────────────
app.get('/api/nifty', async (req, res) => {
  try {
    const [hist, live] = await Promise.all([getHistData(), getLiveData()]);

    const { high52, low52, eodClose, prevClose: histPrev, eodOpen, eodHigh, eodLow, histSource, histStale } = hist;

    // Use live if available, fallback to EOD
    const current      = live?.current      || eodClose;
    const prevClose    = live?.prevClose     || histPrev;
    const open         = live?.open          || eodOpen;
    const dayHigh      = live?.dayHigh       || eodHigh;
    const dayLow       = live?.dayLow        || eodLow;
    const isMarketOpen = live?.isMarketOpen  || false;
    const liveSource   = live?.liveSource    || 'eod_fallback';
    const liveStale    = live?.liveStale     || !live;

    const change    = parseFloat((current - prevClose).toFixed(2));
    const changePct = parseFloat(((change / prevClose) * 100).toFixed(2));

    res.json({
      current, prevClose, open, dayHigh, dayLow,
      change, changePct, high52, low52,
      pctFromHigh: Math.max(0, parseFloat(((high52 - current) / high52 * 100).toFixed(2))),
      pctFromLow:  Math.max(0, parseFloat(((current - low52)  / low52  * 100).toFixed(2))),
      isMarketOpen, liveSource, histSource,
      liveStale: !!liveStale, histStale: !!histStale,
      timestamp: new Date().toISOString(),
    });
  } catch(e) {
    console.error('[api/nifty] fatal:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  liveCache: !!liveCache, histCache: !!histCache,
  liveSource: liveCache?.liveSource, histSource: histCache?.histSource,
  liveCacheAge: liveCache ? Math.round((Date.now() - liveCacheTime) / 1000) + 's' : null,
  histCacheAge: histCache ? Math.round((Date.now() - histCacheTime) / 60000) + 'min' : null,
  tdKeyConfigured: !!TD_KEY, avKeyConfigured: !!AV_KEY,
}));

app.get('/api/debug', async (req, res) => {
  const results = {};
  try {
    const r = await axios.get(`https://api.twelvedata.com/price?symbol=NIFTY50:NSE&apikey=${TD_KEY}`, { timeout: 10000 });
    results.twelvedata = { ok: !r.data.status || r.data.status !== 'error', data: r.data };
  } catch(e) { results.twelvedata = { ok: false, error: e.message }; }

  try {
    const r = await axios.get(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=NSEI.BSE&apikey=${AV_KEY}`, { timeout: 12000 });
    results.alphavantage = { ok: !!r.data['Global Quote'], data: r.data['Global Quote'] || r.data };
  } catch(e) { results.alphavantage = { ok: false, error: e.message }; }

  try {
    const r = await axios.get('https://stooq.com/q/d/l/?s=^nsei&i=m', { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const lines = r.data.trim().split('\n').filter(l => l && !l.startsWith('Date'));
    results.stooq = { ok: lines.length > 12, lines: lines.length, lastLine: lines[lines.length - 1] };
  } catch(e) { results.stooq = { ok: false, error: e.message }; }

  res.json(results);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, () => console.log(`✅ Nifty Tracker on port ${PORT}`));
