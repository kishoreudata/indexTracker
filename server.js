const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Serve index.html from root directory
app.use(express.static(path.join(__dirname)));

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://www.nseindia.com/',
  'Origin': 'https://www.nseindia.com',
  'Connection': 'keep-alive',
};

async function getNSECookies() {
  const res = await axios.get('https://www.nseindia.com', {
    headers: NSE_HEADERS,
    timeout: 10000,
  });
  const cookies = res.headers['set-cookie'];
  return cookies ? cookies.map(c => c.split(';')[0]).join('; ') : '';
}

async function fetchNiftyData(cookies) {
  const res = await axios.get('https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%2050', {
    headers: { ...NSE_HEADERS, 'Cookie': cookies },
    timeout: 10000,
  });
  return res.data;
}

app.get('/api/nifty', async (req, res) => {
  try {
    const cookies = await getNSECookies();
    const data = await fetchNiftyData(cookies);
    const nifty = data.data.find(item => item.index === 'NIFTY 50');
    if (!nifty) throw new Error('NIFTY 50 not found in response');
    res.json({
      current: nifty.last,
      change: nifty.variation,
      changePct: nifty.percentChange,
      high52: nifty.yearHigh,
      low52: nifty.yearLow,
      dayHigh: nifty.high,
      dayLow: nifty.low,
      open: nifty.open,
      prevClose: nifty.previousClose,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Fallback — serve index.html for any unknown route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log(`Nifty Tracker running on port ${PORT}`));
