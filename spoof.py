import requests
import time
import random
import string
import logging
import threading
import bencode
import telebot

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(message)s')

# --- Configuration ---
BOT_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN_HERE"  
TRACKER_ANNOUNCE_URL = "http://tracker.example.com/announce"

bot = telebot.TeleBot(BOT_TOKEN)

# Dictionary to track multiple active seeding threads
# Format: { "info_hash": {"is_running": True, "uploaded": 0, "thread": ThreadObject} }
active_torrents = {}

def generate_qbittorrent_peer_id():
    random_chars = ''.join(random.choices(string.ascii_letters + string.digits, k=12))
    return f"-qB4540-{random_chars}"

def spoof_tracker_thread(chat_id, info_hash_hex, upload_speed_kbps):
    """Background worker that handles a single torrent session."""
    try:
        info_hash_bytes = bytes.fromhex(info_hash_hex)
    except ValueError:
        bot.send_message(chat_id, f"❌ Invalid Info Hash: `{info_hash_hex}`", parse_mode="Markdown")
        active_torrents.pop(info_hash_hex, None)
        return

    peer_id = generate_qbittorrent_peer_id()
    upload_speed_bps = upload_speed_kbps * 1024
    
    session = requests.Session()
    session.headers.update({
        'User-Agent': 'qBittorrent/4.5.4',
        'Accept-Encoding': 'gzip, deflate'
    })

    payload = {
        "info_hash": info_hash_bytes,
        "peer_id": peer_id.encode('utf-8'),
        "port": 6881,
        "uploaded": 0,
        "downloaded": 0,
        "left": 0,
        "compact": 1,
        "event": "started"
    }

    bot.send_message(chat_id, f"🚀 Started seeding!\nHash: `{info_hash_hex}`\nSpeed: {upload_speed_kbps} KB/s", parse_mode="Markdown")

    try:
        # Loop continues as long as this specific hash is marked as running
        while active_torrents.get(info_hash_hex, {}).get("is_running", False):
            sleep_interval = 1800  

            try:
                response = session.get(TRACKER_ANNOUNCE_URL, params=payload, timeout=10)
                response.raise_for_status()
                
                try:
                    tracker_data = bencode.decode(response.content)
                    if b'failure reason' in tracker_data:
                        error_msg = tracker_data[b'failure reason'].decode('utf-8', errors='ignore')
                        bot.send_message(chat_id, f"⚠️ Tracker Error for `{info_hash_hex[:8]}`: {error_msg}", parse_mode="Markdown")
                        time.sleep(60) 
                        continue
                    
                    if b'interval' in tracker_data:
                        sleep_interval = tracker_data[b'interval']

                except Exception as e:
                    logging.error(f"Bencode parse error on {info_hash_hex}: {e}")

                # Update live stats in the global dictionary
                if info_hash_hex in active_torrents:
                    active_torrents[info_hash_hex]["uploaded"] = payload["uploaded"]
                
            except requests.exceptions.RequestException as e:
                logging.error(f"Connection error on {info_hash_hex}: {e}")

            if "event" in payload:
                del payload["event"]

            # Sleep in 1-second chunks to allow instant cancellation
            for _ in range(sleep_interval):
                if not active_torrents.get(info_hash_hex, {}).get("is_running", False):
                    break
                time.sleep(1)

            payload["uploaded"] += upload_speed_bps * sleep_interval

    finally:
        # Cleanup when the thread exits (either naturally or via cancellation)
        active_torrents.pop(info_hash_hex, None)
        bot.send_message(chat_id, f"🛑 Stopped seeding: `{info_hash_hex}`", parse_mode="Markdown")

# --- Telegram Bot Commands ---

@bot.message_handler(commands=['start', 'help'])
def send_welcome(message):
    help_text = (
        "🤖 *Multi-Torrent Spoofer*\n\n"
        "`/seed <info_hash> <kbps>` - Start a torrent\n"
        "`/status` - View all active torrents\n"
        "`/cancel <info_hash>` - Stop a specific torrent\n"
        "`/cancel_all` - Stop everything\n"
    )
    bot.reply_to(message, help_text, parse_mode="Markdown")

@bot.message_handler(commands=['seed'])
def cmd_seed(message):
    args = message.text.split()
    if len(args) != 3:
        bot.reply_to(message, "❌ Format: `/seed <info_hash> <upload_speed_kbps>`", parse_mode="Markdown")
        return

    info_hash = args[1].lower()
    if info_hash in active_torrents:
        bot.reply_to(message, "⚠️ That torrent is already being seeded.")
        return

    try:
        speed_kbps = int(args[2])
    except ValueError:
        bot.reply_to(message, "❌ Speed must be a number.")
        return

    # Initialize state for this specific torrent
    active_torrents[info_hash] = {
        "is_running": True,
        "uploaded": 0,
        "thread": None
    }

    t = threading.Thread(target=spoof_tracker_thread, args=(message.chat.id, info_hash, speed_kbps))
    active_torrents[info_hash]["thread"] = t
    t.start()

@bot.message_handler(commands=['status'])
def cmd_status(message):
    if not active_torrents:
        bot.reply_to(message, "💤 No active torrents.")
        return
    
    response_lines = ["📊 *Active Torrents*"]
    total_uploaded = 0

    for hash_key, data in active_torrents.items():
        uploaded_gb = data["uploaded"] / (1024**3)
        total_uploaded += uploaded_gb
        response_lines.append(f"• `{hash_key[:8]}...` | {uploaded_gb:.2f} GB")
    
    response_lines.append(f"\n*Total Uploaded:* {total_uploaded:.2f} GB")
    bot.reply_to(message, "\n".join(response_lines), parse_mode="Markdown")

@bot.message_handler(commands=['cancel'])
def cmd_cancel(message):
    args = message.text.split()
    if len(args) != 2:
        bot.reply_to(message, "❌ Format: `/cancel <info_hash>`", parse_mode="Markdown")
        return
    
    info_hash = args[1].lower()
    if info_hash not in active_torrents:
        bot.reply_to(message, "❌ Torrent not found in active list.")
        return
    
    # Setting this flag to False breaks the while-loop in the thread
    active_torrents[info_hash]["is_running"] = False
    bot.reply_to(message, f"⏳ Cancelling `{info_hash[:8]}...`", parse_mode="Markdown")

@bot.message_handler(commands=['cancel_all'])
def cmd_cancel_all(message):
    if not active_torrents:
        bot.reply_to(message, "💤 Nothing to cancel.")
        return
    
    for info_hash in active_torrents:
        active_torrents[info_hash]["is_running"] = False
        
    bot.reply_to(message, "🧹 Cancelling all active torrents...")

if __name__ == "__main__":
    print("Bot is polling...")
    bot.infinity_polling()
