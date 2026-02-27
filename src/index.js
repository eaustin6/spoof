import { Buffer } from 'node:buffer';
import bencode from 'bencode';

export default {
    async fetch(request, env, ctx) {
        if (request.method !== 'POST') {
            return new Response('OK', { status: 200 });
        }

        try {
            const update = await request.json();
            const msg = update.message || update.edited_message;
            if (msg && msg.text) {
                await handleCommand(msg, env);
            }
            return new Response('OK', { status: 200 });
        } catch (e) {
            console.error(e);
            return new Response('Error', { status: 500 });
        }
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil(processActiveTorrents(env));
    }
};

async function processActiveTorrents(env) {
    const list = await env.TORRENTS_KV.list();
    if (!list || list.keys.length === 0) return;

    for (const key of list.keys) {
        const fullKey = key.name;
        const infoHash = fullKey.includes(':') ? fullKey.split(':')[1] : fullKey;
        const dataStr = await env.TORRENTS_KV.get(fullKey);
        if (!dataStr) continue;

        let torrentData;
        try {
            torrentData = JSON.parse(dataStr);
        } catch (e) {
            console.error(`Failed to parse data for ${infoHash}`);
            continue;
        }

        const now = Date.now();
        const elapsedSecs = (now - torrentData.lastUpdate) / 1000;

        // Calculate and add uploaded bytes
        if (elapsedSecs > 0) {
            const uploadSpeedBps = torrentData.uploadSpeedKbps * 1024;
            const uploadedBytes = uploadSpeedBps * elapsedSecs;
            torrentData.uploaded += Math.floor(uploadedBytes);
            torrentData.lastUpdate = now;
            await env.TORRENTS_KV.put(infoHash, JSON.stringify(torrentData));
        }

        // Check if it's time to announce
        if (now < torrentData.nextAnnounceTime) continue;

        // Convert info hash hex to bytes, bail on invalid/corrupted data
        const infoHashBytes = new Uint8Array(20);
        let invalidInfoHash = false;
        for (let i = 0; i < 20; i++) {
            const byte = parseInt(infoHash.substring(i * 2, i * 2 + 2), 16);
            if (Number.isNaN(byte)) {
                invalidInfoHash = true;
                break;
            }
            infoHashBytes[i] = byte;
        }
        if (invalidInfoHash) {
            console.error(`Invalid infoHash for ${fullKey}, skipping.`);
            continue;
        }

        try {
            const params = new URLSearchParams();
            params.append('info_hash', escapeBytesForURL(infoHashBytes));
            params.append('peer_id', torrentData.peerId);
            params.append('port', '6881');
            params.append('uploaded', torrentData.uploaded.toString());
            params.append('downloaded', '0');
            params.append('left', '0');
            params.append('compact', '1');

            if (torrentData.event) {
                params.append('event', torrentData.event);
            }

            const queryString = Array.from(params.entries())
                .map(([k, v]) => `${k}=${k === 'info_hash' ? v : encodeURIComponent(v)}`)
                .join('&');

            const url = `${env.TRACKER_ANNOUNCE_URL}?${queryString}`;

            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'qBittorrent/5.1.4',
                    'Accept-Encoding': 'gzip, deflate'
                }
            });

            if (response.ok) {
                 const buffer = await response.arrayBuffer();
                 try {
                     const decoded = bencode.decode(Buffer.from(buffer));
                     if (decoded['failure reason']) {
                         const failureStr = Buffer.from(decoded['failure reason']).toString('utf-8');
                         console.error(`Tracker Error for ${infoHash}: ${failureStr}`);
                     } else if (decoded.interval) {
                         torrentData.intervalSecs = decoded.interval;
                     } else if (torrentData.intervalSecs === 0) {
                         torrentData.intervalSecs = 1800; // default 30 mins
                     }
                 } catch (parseErr) {
                     console.error(`Failed to decode bencode for ${infoHash}: `, parseErr);
                     if (torrentData.intervalSecs === 0) torrentData.intervalSecs = 1800;
                 }

                 // If the event was 'stopped', we are done and can remove it from KV
                 if (torrentData.event === 'stopped') {
                     await env.TORRENTS_KV.delete(fullKey);
                     continue;
                 }

                 // Clear 'started' event for future announces
                 if (torrentData.event === 'started') {
                     delete torrentData.event;
                 }

                 torrentData.nextAnnounceTime = now + (torrentData.intervalSecs * 1000);
                 await env.TORRENTS_KV.put(fullKey, JSON.stringify(torrentData));
            } else {
                console.error(`Tracker error for ${infoHash}: ${response.statusText}`);
                // Try again in 1 minute on HTTP error
                torrentData.nextAnnounceTime = now + 60000;
                await env.TORRENTS_KV.put(fullKey, JSON.stringify(torrentData));
            }
        } catch (e) {
            console.error(`Fetch error for ${infoHash}: `, e);
            // Try again in 1 minute on network error
            torrentData.nextAnnounceTime = now + 60000;
            await env.TORRENTS_KV.put(fullKey, JSON.stringify(torrentData));
        }
    }
}

function generatePeerId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let randomChars = '';
    for (let i = 0; i < 12; i++) {
        randomChars += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `-qB5140-${randomChars}`;
}

function escapeBytesForURL(bytes) {
    let result = '';
    for (let i = 0; i < bytes.length; i++) {
        const hex = bytes[i].toString(16).padStart(2, '0');
        result += `%${hex}`;
    }
    return result;
}

async function sendMessage(chatId, text, env, parseMode = 'Markdown') {
    const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
    await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text: text,
            parse_mode: parseMode
        })
    });
}

async function handleCommand(message, env) {
    const text = message.text;
    const chatId = message.chat.id;
    const args = text.split(' ');
    const command = args[0].toLowerCase();

    if (command === '/start' || command === '/help') {
        const helpText =
            "🤖 *Multi-Torrent Spoofer*\n\n" +
            "`/seed <info_hash> <kbps>` - Start a torrent\n" +
            "`/status` - View all active torrents\n" +
            "`/cancel <info_hash>` - Stop a specific torrent\n" +
            "`/cancel_all` - Stop everything\n";
        await sendMessage(chatId, helpText, env);
        return;
    }

    if (command === '/seed') {
        if (args.length !== 3) {
            await sendMessage(chatId, "❌ Format: `/seed <info_hash> <upload_speed_kbps>`", env);
            return;
        }

        const infoHash = args[1].toLowerCase();

        // Basic infohash validation (must be 40 hex chars)
        if (!/^[0-9a-f]{40}$/.test(infoHash)) {
            await sendMessage(chatId, `❌ Invalid Info Hash: \`${infoHash}\``, env);
            return;
        }

        const speedKbps = parseInt(args[2]);
        if (isNaN(speedKbps) || speedKbps <= 0) {
            await sendMessage(chatId, "❌ Speed must be a positive number.", env);
            return;
        }

        // Check if already seeding
        const storageKey = `${chatId}:${infoHash}`;
        const existing = await env.TORRENTS_KV.get(storageKey);
        if (existing) {
            await sendMessage(chatId, "⚠️ That torrent is already being seeded.", env, null);
            return;
        }

        const peerId = generatePeerId();

        const torrentData = {
            chatId: chatId,
            uploadSpeedKbps: speedKbps,
            uploaded: 0,
            startTime: Date.now(),
            lastUpdate: Date.now(),
            peerId: peerId,
            intervalSecs: 0,
            nextAnnounceTime: 0,
            event: 'started'
        };

        await env.TORRENTS_KV.put(storageKey, JSON.stringify(torrentData));
        await sendMessage(chatId, `🚀 Started seeding!\nHash: \`${infoHash}\`\nSpeed: ${speedKbps} KB/s`, env);

        // Let the scheduled task handle the initial announce
        return;
    }

    if (command === '/status') {
        const list = await env.TORRENTS_KV.list({ prefix: `${chatId}:` });
        if (list.keys.length === 0) {
            await sendMessage(chatId, "💤 No active torrents.", env, null);
            return;
        }

        let responseLines = ["📊 *Active Torrents*"];
        let totalUploaded = 0;

        for (const key of list.keys) {
            const dataStr = await env.TORRENTS_KV.get(key.name);
            if (dataStr) {
                const data = JSON.parse(dataStr);
                const uploadedGb = data.uploaded / (1024 ** 3);
                totalUploaded += uploadedGb;
                const infoHash = key.name.includes(':') ? key.name.split(':')[1] : key.name;
                responseLines.push(`• \`${infoHash.substring(0, 8)}...\` | ${uploadedGb.toFixed(2)} GB`);
            }
        }

        responseLines.push(`\n*Total Uploaded:* ${totalUploaded.toFixed(2)} GB`);
        await sendMessage(chatId, responseLines.join('\n'), env);
        return;
    }

    if (command === '/cancel') {
        if (args.length !== 2) {
            await sendMessage(chatId, "❌ Format: `/cancel <info_hash>`", env);
            return;
        }

        const infoHash = args[1].toLowerCase();
        const storageKey = `${chatId}:${infoHash}`;
        const dataStr = await env.TORRENTS_KV.get(storageKey);

        if (!dataStr) {
            await sendMessage(chatId, "❌ Torrent not found in active list.", env, null);
            return;
        }

        try {
            const torrentData = JSON.parse(dataStr);
            torrentData.event = 'stopped';
            torrentData.nextAnnounceTime = 0;
            await env.TORRENTS_KV.put(storageKey, JSON.stringify(torrentData));
            await sendMessage(chatId, `⏳ Cancelling \`${infoHash.substring(0, 8)}...\``, env);
        } catch(e) {
            await env.TORRENTS_KV.delete(storageKey);
            await sendMessage(chatId, `❌ Failed to parse torrent data. Removed \`${infoHash.substring(0, 8)}...\``, env);
        }
        return;
    }

    if (command === '/cancel_all') {
        const list = await env.TORRENTS_KV.list({ prefix: `${chatId}:` });
        if (list.keys.length === 0) {
            await sendMessage(chatId, "💤 Nothing to cancel.", env, null);
            return;
        }

        for (const key of list.keys) {
            const dataStr = await env.TORRENTS_KV.get(key.name);
            if (dataStr) {
                 try {
                     const torrentData = JSON.parse(dataStr);
                     torrentData.event = 'stopped';
                     torrentData.nextAnnounceTime = 0;
                     await env.TORRENTS_KV.put(key.name, JSON.stringify(torrentData));
                 } catch(e) {
                     await env.TORRENTS_KV.delete(key.name);
                 }
            }
        }

        await sendMessage(chatId, "🧹 Cancelling all active torrents...", env, null);
        return;
    }
}
