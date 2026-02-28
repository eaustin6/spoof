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
            if (msg && (msg.text || msg.caption || msg.document)) {
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
            await env.TORRENTS_KV.put(fullKey, JSON.stringify(torrentData));
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
            params.append('corrupt', '0');
            if (torrentData.key) {
                params.append('key', torrentData.key);
            }
            if (torrentData.event) {
                params.append('event', torrentData.event);
            }
            params.append('numwant', '200');
            params.append('compact', '1');
            params.append('no_peer_id', '1');
            params.append('supportcrypto', '1');
            params.append('redundant', '0');

            const queryString = Array.from(params.entries())
                .map(([k, v]) => `${k}=${k === 'info_hash' ? v : encodeURIComponent(v)}`)
                .join('&');

            const announceUrl = torrentData.announceUrl;
            if (!announceUrl) {
                console.error(`No announceUrl for ${infoHash}, skipping.`);
                continue;
            }
            const url = `${announceUrl}?${queryString}`;

            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'qBittorrent/5.1.4',
                    'Accept-Encoding': 'gzip, deflate',
                    'Connection': 'close'
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
    const text = message.text || message.caption || '';
    const chatId = message.chat.id;
    const args = text.split(' ').filter(Boolean);
    const command = args.length > 0 ? args[0].toLowerCase() : '';

    if (command === '/start' || command === '/help') {
        const helpText =
            "🤖 *Multi-Torrent Spoofer*\n\n" +
            "📖 *Usage Guide:*\n" +
            "1️⃣ *Start Seeding (Magnet):* Send `/seed <magnet_link> <kbps>` (e.g. `/seed magnet:?xt=... 5000` to spoof 5MB/s).\n" +
            "2️⃣ *Start Seeding (File):* Send a `.torrent` file with the caption `/seed <kbps>`.\n" +
            "3️⃣ *Check Status:* Send `/status` to view your active torrents and total fake uploaded data.\n" +
            "4️⃣ *Stop Seeding:* Send `/cancel <info_hash>` to stop a specific torrent or `/cancel_all` to stop everything.\n\n" +
            "⚠️ *Disclaimer & Risks:*\n" +
            "• *Tracker Bans:* This bot mimics a BitTorrent client (qBittorrent), but abnormally high speeds or lack of download progress might trigger tracker anti-cheat systems, leading to a ban.\n" +
            "• *IP Leaks:* The IP address announced to the tracker will be the Cloudflare Worker's IP, not yours. This hides your home IP but may look suspicious to private trackers enforcing IP rules.\n" +
            "• *Inaccurate Stats:* The spoofed upload amount is an estimate based on speed and time. It may not exactly match what the tracker records.\n" +
            "• *Use at your own risk!* We are not responsible for any banned accounts or lost ratios.";
        await sendMessage(chatId, helpText, env);
        return;
    }

    if (command === '/seed') {
        let infoHash = '';
        let announceUrl = '';
        let speedKbps = 0;

        try {
            if (message.document?.file_name && message.document.file_name.endsWith('.torrent')) {
                if (args.length < 2) {
                    await sendMessage(chatId, "❌ Format for torrent file: Caption with `/seed <speed_kbps>`", env);
                    return;
                }
                speedKbps = parseInt(args[1]);

                const fileId = message.document.file_id;
                const fileRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${fileId}`);
                const fileJson = await fileRes.json();
                if (!fileJson.ok) throw new Error('Could not get file path');

                const filePath = fileJson.result.file_path;
                const downloadRes = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`);
                const fileBuffer = await downloadRes.arrayBuffer();

                const decoded = bencode.decode(Buffer.from(fileBuffer));

                if (decoded.announce) {
                    announceUrl = Buffer.from(decoded.announce).toString('utf-8');
                } else if (decoded['announce-list']) {
                    announceUrl = Buffer.from(decoded['announce-list'][0][0]).toString('utf-8');
                }

                if (!announceUrl) {
                    throw new Error("Could not find tracker URL in torrent file.");
                }

                const infoEncoded = bencode.encode(decoded.info);
                const hashBuffer = await crypto.subtle.digest('SHA-1', infoEncoded);
                infoHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

            } else if (args.length >= 3 && args[1].startsWith('magnet:')) {
                const magnetUrl = new URL(args[1]);
                const xt = magnetUrl.searchParams.get('xt');
                if (!xt) throw new Error('Invalid magnet link: Missing xt parameter');

                if (xt.startsWith('urn:btih:')) {
                    const hashPart = xt.substring(9);
                    if (hashPart.length === 40) {
                        infoHash = hashPart.toLowerCase();
                    } else if (hashPart.length === 32) {
                        // Base32 decoding
                        const base32chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
                        let bits = "";
                        let hex = "";
                        for (let i = 0; i < hashPart.length; i++) {
                            const val = base32chars.indexOf(hashPart.charAt(i).toUpperCase());
                            bits += val.toString(2).padStart(5, '0');
                        }
                        for (let i = 0; i < bits.length; i += 4) {
                            hex += parseInt(bits.substring(i, i + 4), 2).toString(16);
                        }
                        infoHash = hex.toLowerCase();
                    } else {
                        throw new Error('Invalid magnet link: Unknown info hash length');
                    }
                } else {
                    throw new Error('Invalid magnet link: Unsupported xt format');
                }

                const tr = magnetUrl.searchParams.get('tr');
                if (tr) announceUrl = tr;

                if (!announceUrl) {
                    throw new Error("Could not find tracker URL in magnet link.");
                }

                speedKbps = parseInt(args[2]);

            } else {
                await sendMessage(chatId, "❌ Please provide a magnet link or upload a `.torrent` file.", env);
                return;
            }
        } catch (e) {
            console.error('Seed command error:', e);
            await sendMessage(chatId, `❌ Error processing request: ${e.message}`, env);
            return;
        }

        if (!/^[0-9a-f]{40}$/.test(infoHash)) {
            await sendMessage(chatId, `❌ Invalid Info Hash: \`${infoHash}\``, env);
            return;
        }

        if (isNaN(speedKbps) || speedKbps <= 0) {
            await sendMessage(chatId, "❌ Speed must be a positive number.", env);
            return;
        }

        const storageKey = `${chatId}:${infoHash}`;
        const existing = await env.TORRENTS_KV.get(storageKey);
        if (existing) {
            await sendMessage(chatId, "⚠️ That torrent is already being seeded.", env, null);
            return;
        }

        const peerId = generatePeerId();

        // Generate random 8-character hex key to mimic qBittorrent client
        const hexChars = '0123456789ABCDEF';
        let trackerKey = '';
        for (let i = 0; i < 8; i++) {
            trackerKey += hexChars[Math.floor(Math.random() * 16)];
        }

        const torrentData = {
            chatId: chatId,
            uploadSpeedKbps: speedKbps,
            uploaded: 0,
            startTime: Date.now(),
            lastUpdate: Date.now(),
            peerId: peerId,
            key: trackerKey,
            intervalSecs: 0,
            nextAnnounceTime: 0,
            event: 'started'
        };

        if (announceUrl) {
            torrentData.announceUrl = announceUrl;
        }

        await env.TORRENTS_KV.put(storageKey, JSON.stringify(torrentData));
        await sendMessage(chatId, `🚀 Started seeding!\nHash: \`${infoHash}\`\nSpeed: ${speedKbps} KB/s${announceUrl ? '\nTracker: `'+announceUrl+'`' : ''}`, env);

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
