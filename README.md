# Multi-Torrent Spoofer

A serverless Cloudflare Worker acting as a Telegram bot to spoof BitTorrent tracker uploads.

## Features
- **Add and Spoofer Torrents:** Allows users to easily spoof their BitTorrent tracker uploads using a Telegram bot interface.
- **Scoping per Chat:** Operates natively in multi-user environments with separated namespaces per user chat.
- **Continuous Announcing:** Uses Cloudflare Scheduled triggers to regularly announce mock uploads to trackers automatically.

## Deployment Guide (Cloudflare Workers)

Deploying this bot involves setting up a Cloudflare account, creating a KV namespace for storing state, installing `wrangler`, defining your secrets, and publishing the worker.

### Prerequisites

1. **Cloudflare Account:** You need a registered account on [Cloudflare](https://dash.cloudflare.com/sign-up).
2. **Node.js & npm:** Install Node.js (which includes npm).
3. **Telegram Bot Token:** Create a new bot on Telegram using [BotFather](https://t.me/botfather) and note down its token.

### 1. Install Dependencies & Setup Wrangler

Clone the repository and install the dependencies:
```bash
git clone <repository_url>
cd <repository_folder>
npm install
```

Wrangler is the CLI tool for Cloudflare Workers. It will be installed as part of your Node project, or you can run `npx wrangler login` to log in to your Cloudflare account from the command line:
```bash
npx wrangler login
```

### 2. Create a Cloudflare KV Namespace

This bot uses Cloudflare KV (Key-Value storage) to keep track of active torrents.

Run the following command to create a new KV namespace:
```bash
npx wrangler kv:namespace create "TORRENTS_KV"
```

The output will contain an `id` block. Copy the ID, and open your `wrangler.toml` file. Under `[[kv_namespaces]]`, paste your newly generated `id`:

```toml
[[kv_namespaces]]
binding = "TORRENTS_KV"
id = "<YOUR_NEW_KV_ID>"
```

### 3. Add Secrets

The bot needs your Telegram Bot Token to operate. Because this is sensitive, we'll store it as a Cloudflare Secret.

Add the Telegram Bot Token:
```bash
npx wrangler secret put BOT_TOKEN
```
*(Paste your token when prompted)*

### 4. Deploy the Worker

Once your KV namespace is bound and secrets are configured, deploy the Cloudflare Worker:
```bash
npx wrangler deploy
```

Make note of the deployed Worker URL (e.g., `https://multi-torrent-spoofer.<your_subdomain>.workers.dev`).

### 5. Set the Telegram Webhook

To make Telegram send messages to your newly deployed bot, configure the webhook by replacing `<YOUR_BOT_TOKEN>` and `<YOUR_WORKER_URL>` in the following URL and opening it in your browser:

```
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=<YOUR_WORKER_URL>
```

You should see a JSON response like `{"ok":true,"result":true,"description":"Webhook was set"}`.

### 6. Automated Deployment via GitHub Actions

You can automatically deploy your bot to Cloudflare Workers on every push to the `main` branch. The deployment workflow securely passes environmental variables (secrets) to Cloudflare.

1. Go to your GitHub repository **Settings** -> **Secrets and variables** -> **Actions**.
2. Add the following repository secrets to allow GitHub Actions to authenticate with Cloudflare and configure your bot:
   - `CLOUDFLARE_API_TOKEN`: Create an API token in your Cloudflare dashboard with "Edit Cloudflare Workers" permissions.
   - `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare Account ID (found on the right sidebar of the Workers dashboard).
   - `BOT_TOKEN`: The token you received from BotFather.

The action securely maps `BOT_TOKEN` environmental variables to Cloudflare Workers Secrets during deployment using Wrangler.

When you push changes, the `.github/workflows/deploy.yml` workflow will automatically run and deploy the worker.

## Usage Commands

Start interacting with your bot on Telegram:
- `/seed <magnet_link> <kbps>` - Start a torrent using a magnet link (automatically extracts info hash and tracker URL)
- Send a `.torrent` file and put `/seed <kbps>` in the caption to start seeding from a torrent file.
- `/status` - View all your active torrents
- `/cancel <info_hash>` - Stop a specific torrent
- `/cancel_all` - Stop all your active torrents
