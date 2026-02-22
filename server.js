const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname)));

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Referer': 'https://www.nseindia.com/',
  'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
};

let cachedCookies = '';
let cookieExpiry = 0;

async function getNSECookies() {
  // Reuse cookies for 4 minutes to avoid hammering NSE
  if (cachedCookies && Date.now() < cookieExpiry) return cachedCookies;

  const res = await axios.get('https://www.nseindia.com', {
    headers: { ...NSE_HEADERS },
    timeout: 15000,
    maxRedirects: 5,
  });

  const setCookie = res.headers['set-cookie'] || [];
  cachedCookies = setCookie.map(c => c.split(';')[0]).join('; ');
  cookieExpiry = Date.now() + 4 * 60 * 1000;
  return cachedCookies;
}

async function fetchFromNSE(cookies) {
  const res = await axios.get(
    'https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%2050',
    {
      headers: { ...NSE_HEADERS, Cookie: cookies },
      timeout: 15000,
    }
  );
  return res.data;
}

app.get('/api/nifty', async (req, res) => {
  try {
    const cookies = await getNSECookies();
    // Small delay to mimic real browser
    await new Promise(r => setTimeout(r, 500));
    const data = await fetchFromNSE(cookies);

    const nifty = data.data.find(item => item.index === 'NIFTY 50');
    if (!nifty) throw new Error('NIFTY 50 row not found');

    const current  = parseFloat(nifty.last);
    const high52   = parseFloat(nifty.yearHigh);
    const low52    = parseFloat(nifty.yearLow);
    const change   = parseFloat(nifty.variation);
    const changePct= parseFloat(nifty.percentChange);

    const pctFromHigh = ((high52 - current) / high52 * 100).toFixed(2);
    const pctFromLow  = ((current - low52)  / low52  * 100).toFixed(2);

    res.json({
      current,
      change,
      changePct,
      high52,
      low52,
      pctFromHigh: parseFloat(pctFromHigh),
      pctFromLow:  parseFloat(pctFromLow),
      dayHigh:  parseFloat(nifty.high),
      dayLow:   parseFloat(nifty.low),
      open:     parseFloat(nifty.open),
      prevClose:parseFloat(nifty.previousClose),
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    console.error('NSE fetch error:', err.message);
    // Try fallback: Yahoo Finance
    try {
      const yRes = await axios.get(
        'https://query2.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=1y',
        { timeout: 10000 }
      );
      const meta   = yRes.data.chart.result[0].meta;
      const quotes = yRes.data.chart.result[0].indicators.quote[0];
      const highs  = quotes.high.filter(Boolean);
      const lows   = quotes.low.filter(Boolean);
      const current  = meta.regularMarketPrice;
      const high52   = Math.max(...highs);
      const low52    = Math.min(...lows);
      const prevClose= meta.chartPreviousClose;
      const change   = current - prevClose;
      const changePct= (change / prevClose * 100);

      res.json({
        current,
        change,
        changePct,
        high52,
        low52,
        pctFromHigh: parseFloat(((high52 - current) / high52 * 100).toFixed(2)),
        pctFromLow:  parseFloat(((current - low52)  / low52  * 100).toFixed(2)),
        dayHigh: meta.regularMarketDayHigh || current,
        dayLow:  meta.regularMarketDayLow  || current,
        open:    meta.regularMarketOpen    || current,
        prevClose,
        timestamp: new Date().toISOString(),
        source: 'yahoo',
      });
    } catch (fallbackErr) {
      console.error('Yahoo fallback error:', fallbackErr.message);
      res.status(500).json({ error: 'Both NSE and Yahoo Finance failed. Try again in a moment.' });
    }
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`Nifty Tracker running on port ${PORT}`));
