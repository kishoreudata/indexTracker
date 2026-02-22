const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://www.nseindia.com/',
  'Origin': 'https://www.nseindia.com',
  'Connection': 'keep-alive',
  'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
};

let sessionCookies = '';

async function refreshSession() {
  try {
    const res = await axios.get('https://www.nseindia.com', {
      headers: NSE_HEADERS,
      timeout: 10000,
    });
    const cookies = res.headers['set-cookie'];
    if (cookies) {
      sessionCookies = cookies.map(c => c.split(';')[0]).join('; ');
      console.log('✅ NSE session refreshed');
    }
  } catch (e) {
    console.error('❌ Session refresh failed:', e.message);
  }
}

async function fetchNiftyData() {
  if (!sessionCookies) await refreshSession();
  const res = await axios.get(
    'https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%2050',
    { headers: { ...NSE_HEADERS, Cookie: sessionCookies }, timeout: 10000 }
  );
  return res.data;
}

app.get('/api/nifty', async (req, res) => {
  try {
    let data = await fetchNiftyData();
    const nifty = data.data?.find(d => d.index === 'NIFTY 50') || data.data?.[0];
    if (!nifty) throw new Error('Nifty 50 not found');
    res.json({
      success: true,
      current: parseFloat(nifty.last),
      high52: parseFloat(nifty.yearHigh),
      low52: parseFloat(nifty.yearLow),
      change: parseFloat(nifty.change),
      changePct: parseFloat(nifty.percentChange),
      open: parseFloat(nifty.open),
      prevClose: parseFloat(nifty.previousClose),
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    if (e.response?.status === 401 || e.response?.status === 403) {
      await refreshSession();
      try {
        const data = await fetchNiftyData();
        const nifty = data.data?.find(d => d.index === 'NIFTY 50') || data.data?.[0];
        res.json({
          success: true,
          current: parseFloat(nifty.last),
          high52: parseFloat(nifty.yearHigh),
          low52: parseFloat(nifty.yearLow),
          change: parseFloat(nifty.change),
          changePct: parseFloat(nifty.percentChange),
          open: parseFloat(nifty.open),
          prevClose: parseFloat(nifty.previousClose),
          timestamp: new Date().toISOString(),
        });
      } catch (e2) {
        res.status(500).json({ success: false, error: e2.message });
      }
    } else {
      res.status(500).json({ success: false, error: e.message });
    }
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

refreshSession();
setInterval(refreshSession, 30 * 60 * 1000);

app.listen(PORT, () => console.log(`🚀 Nifty Tracker running at http://localhost:${PORT}`));
