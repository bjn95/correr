# Correr — AI Running Companion
### correr.app

A personalised running plan generator with Strava and Garmin integration.

---

## Project Structure

```
correr/
├── frontend/
│   ├── index.html        ← Deploy to Cloudflare Pages
│   └── _headers          ← Cloudflare Pages config (charset + security headers)
│
├── backend/
│   ├── server.js         ← Express app entry point
│   ├── db.js             ← SQLite schema (users, activities, plan_workouts)
│   ├── plan.js           ← Plan generation logic
│   ├── package.json
│   ├── .env.example      ← Copy to .env and fill in credentials
│   └── routes/
│       ├── strava.js     ← Strava OAuth 2.0 + webhook + activity sync
│       └── garmin.js     ← Garmin OAuth 1.0a + Training API workout push
│
├── .gitignore
└── README.md
```

---

## Quick Start

### Frontend (Cloudflare Pages)
1. Go to pages.cloudflare.com → Create project → Direct Upload
2. Upload **both** `frontend/index.html` and `frontend/_headers` together
3. Set custom domain to `correr.app`

### Backend (Railway)
```bash
cd backend
npm install
cp .env.example .env
# Fill in your credentials in .env
npm run dev
```

### Connect your domain
- `correr.app` → Cloudflare Pages (frontend)
- `api.correr.app` → Railway (backend)

Update the `const API = '...'` line in `frontend/index.html` to point to your Railway URL before deploying.

---

## Integrations

### Strava
1. Create app at https://www.strava.com/settings/api
2. Set Authorization Callback Domain to `correr.app`
3. Add `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET` to `.env`
4. Register webhook (one-time):
```bash
curl -X POST https://www.strava.com/api/v3/push_subscriptions \
  -F client_id=YOUR_ID \
  -F client_secret=YOUR_SECRET \
  -F callback_url=https://api.correr.app/webhook/strava \
  -F verify_token=correr_strava_webhook_2024
```

### Garmin
Apply for Training API access at:
https://developerportal.garmin.com/developer-programs/connect-developer-api

Approval takes 1–2 weeks. Add `GARMIN_CONSUMER_KEY` and `GARMIN_CONSUMER_SECRET` to `.env` once approved.

---

## Development with Claude Code
```bash
# Install Claude Code
npm install -g @anthropic/claude-code

# Open in your project root
cd correr
claude
```

Then just describe what you want to build or fix in plain English.

---

## Hosting
| Service | Purpose | Cost |
|---|---|---|
| Cloudflare Pages | Frontend hosting | Free |
| Railway | Backend (Node.js) | ~$5/month |
| Cloudflare Email Routing | info@correr.app forwarding | Free |
