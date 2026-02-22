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

async function fetchFromAlphaVantage() {
  if (!AV_KEY) throw new Error('No Alpha Vantage key');
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=NSEI.BSE&outputsize=full&apikey=${AV_KEY}`;
  const res = await axios.get(url, { timeout: 15000 });
  const ts = res.data['Time Series (Daily)'];
  if (!ts) throw new Error('AV: ' + (res.data['Note'] || res.data['Information'] || JSON.stringify(res.data)));

  const dates = Object.keys(ts).sort().reverse();
  const latest = ts[dates[0]];
  const prev   = ts[dates[1]];

  const current   = parseFloat(latest['4. close']);
  const prevClose = parseFloat(prev['4. close']);
  const change    = parseFloat((current - prevClose).toFixed(2));
  const changePct = parseFloat(((change / prevClose) * 100).toFixed(2));

  const yearDates = dates.slice(0, 252);
  const high52 = Math.max(...yearDates.map(d => parseFloat(ts[d]['2. high'])));
  const low52  = Math.min(...yearDates.map(d => parseFloat(ts[d]['3. low'])));

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
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com' },
      });
      const result  = res.data.chart.result[0];
      const meta    = result.meta;
      const quotes  = result.indicators.quote[0];
      const highs   = quotes.high.filter(Boolean);
      const lows    = quotes.low.filter(Boolean);
      const current   = meta.regularMarketPrice;
      const high52    = Math.max(...highs);
      const low52     = Math.min(...lows);
      const prevClose = meta.chartPreviousClose;
      const change    = parseFloat((current - prevClose).toFixed(2));
      const changePct = parseFloat(((change / prevClose) * 100).toFixed(2));
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

async function fetchFromStooq() {
  const url = 'https://stooq.com/q/d/l/?s=^nsei&i=d';
  const res = await axios.get(url, {
    timeout: 10000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  const lines = res.data.trim().split('\n').filter(l => l.trim() && !l.startsWith('Date'));
  if (lines.length < 2) throw new Error('Stooq: not enough data');

  // CSV: Date,Open,High,Low,Close,Volume
  const parse = line => line.split(',').map(v => v.trim());
  const last = parse(lines[lines.length - 1]);
  const prev = parse(lines[lines.length - 2]);

  const current   = parseFloat(last[4]);
  const prevClose = parseFloat(prev[4]);
  if (!current || !prevClose) throw new Error('Stooq: invalid close values');

  const change    = parseFloat((current - prevClose).toFixed(2));
  const changePct = parseFloat(((change / prevClose) * 100).toFixed(2));

  const yearLines = lines.slice(-252);
  const high52 = Math.max(...yearLines.map(l => parseFloat(parse(l)[2])).filter(Boolean));
  const low52  = Math.min(...yearLines.map(l => parseFloat(parse(l)[3])).filter(Boolean));

  return {
    current, change, changePct, high52, low52,
    pctFromHigh: parseFloat(((high52 - current) / high52 * 100).toFixed(2)),
    pctFromLow:  parseFloat(((current - low52)  / low52  * 100).toFixed(2)),
    dayHigh: parseFloat(last[2]),
    dayLow:  parseFloat(last[3]),
    open:    parseFloat(last[1]),
    prevClose,
    source: 'stooq',
    timestamp: new Date().toISOString(),
  };
}

app.get('/api/nifty', async (req, res) => {
  if (cache && Date.now() - cacheTime < CACHE_TTL) {
    return res.json({ ...cache, cached: true });
  }

  const sources = [fetchFromAlphaVantage, fetchFromStooq, fetchFromYahoo];
  const errors = [];

  for (const fn of sources) {
    try {
      console.log(`Trying ${fn.name}...`);
      const data = await fn();
      cache = data;
      cacheTime = Date.now();
      console.log(`Success: ${fn.name} | Nifty: ${data.current}`);
      return res.json(data);
    } catch(e) {
      console.error(`Failed ${fn.name}: ${e.message}`);
      errors.push(`${fn.name}: ${e.message}`);
    }
  }

  if (cache) {
    console.warn('All failed, serving stale cache');
    return res.json({ ...cache, stale: true });
  }

  res.status(500).json({ error: 'All sources failed', details: errors });
});

app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  cached: !!cache,
  source: cache?.source,
  nifty: cache?.current,
  cacheAge: cache ? Math.round((Date.now() - cacheTime) / 1000) + 's' : null,
  avKeyConfigured: !!AV_KEY,
}));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`Nifty Tracker running on port ${PORT}`));
