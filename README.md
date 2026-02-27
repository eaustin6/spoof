# Telegram Torrent Spoofer (Cloudflare Worker)

A serverless Telegram Bot built on Cloudflare Workers that spoofs BitTorrent tracker announces. It allows you to simulate uploading to trackers without actually running a torrent client.

## Features
- Completely serverless (Runs on Cloudflare Workers)
- Spoofs as `qBittorrent/5.1.4`
- Multi-user support (Isolated state per Telegram Chat ID)
- Maintains tracker state via Cloudflare KV
- Respects tracker interval times and lifecycle events (`started`, `stopped`)

## Prerequisites
- A Cloudflare account
- Node.js and npm installed locally
- A Telegram Bot Token (Get one from [@BotFather](https://t.me/BotFather))

## Deployment Guide

### 1. Install Dependencies
Clone this repository and install the required dependencies:
```bash
npm install
```

### 2. Configure Cloudflare KV
The bot uses a Cloudflare KV namespace to store active torrent states. Create a new namespace:
```bash
npx wrangler kv:namespace create TORRENTS_KV
```
Copy the `id` from the output and paste it into your `wrangler.toml` file under `[[kv_namespaces]]`.

### 3. Set Up Secrets
The worker requires two secret environment variables:
- `BOT_TOKEN`: Your Telegram Bot Token.
- `TRACKER_ANNOUNCE_URL`: The announce URL of the tracker you want to spoof.

Add them to your worker using Wrangler:
```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put TRACKER_ANNOUNCE_URL
```

### 4. Deploy to Cloudflare
Deploy the worker:
```bash
npx wrangler deploy
```

Once deployed, Wrangler will output the URL of your worker (e.g., `https://multi-torrent-spoofer.<your-username>.workers.dev`).

### 5. Set Up Telegram Webhook
Tell Telegram to send messages to your new Cloudflare Worker URL. Run the following `curl` command (replace `<YOUR_BOT_TOKEN>` and `<YOUR_WORKER_URL>`):

```bash
curl -F "url=<YOUR_WORKER_URL>" https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook
```

## Bot Commands
Send these commands to your bot on Telegram:
- `/seed <info_hash> <upload_speed_kbps>` - Start seeding a torrent.
- `/status` - View all your active torrents.
- `/cancel <info_hash>` - Stop seeding a specific torrent.
- `/cancel_all` - Stop seeding all your torrents.

## Disclaimer
This project is for educational purposes only. Misuse of this tool on private trackers can result in account bans.
