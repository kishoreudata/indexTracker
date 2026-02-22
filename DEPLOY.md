# 🚀 Deploy Nifty Tracker to Render.com + udata.in

## Step 1 — Upload to GitHub (free)
1. Go to https://github.com/new
2. Create a new repository named `nifty-tracker` (set to Public)
3. Upload all files: server.js, package.json, render.yaml, public/index.html
   - Click "uploading an existing file" on the repo page
   - Drag and drop all files
4. Click "Commit changes"

## Step 2 — Deploy on Render.com (free)
1. Go to https://render.com and sign up (free, no credit card)
2. Click "New +" → "Web Service"
3. Connect your GitHub account → select `nifty-tracker` repo
4. Render will auto-detect settings from render.yaml
   - Name: nifty-tracker
   - Build Command: npm install
   - Start Command: node server.js
   - Plan: Free
5. Click "Create Web Service"
6. Wait ~3 minutes for deploy
7. You'll get a URL like: https://nifty-tracker-xxxx.onrender.com
8. Open it — your tracker is live! ✅

## Step 3 — Point nifty.udata.in to Render (optional but nice)
1. In GoDaddy, go to DNS Management for udata.in
2. Add a new CNAME record:
   - Type: CNAME
   - Name: nifty  (this creates nifty.udata.in)
   - Value: nifty-tracker-xxxx.onrender.com  (your Render URL)
   - TTL: 1 hour
3. In Render dashboard → your service → Settings → Custom Domains
4. Add: nifty.udata.in
5. Wait 10-30 minutes for DNS to propagate
6. Done! Visit nifty.udata.in from any device 🎉

## ⚠️ Free Tier Note
Render free tier "spins down" after 15 min of inactivity.
First visit after inactivity may take ~30 seconds to load.
To avoid this, upgrade to Render's $7/month plan or use a free uptime monitor
like https://uptimerobot.com to ping your app every 5 minutes.
