-- Telegram alerts: per-monitor destination chat. The bot token itself is a Worker secret
-- (TELEGRAM_BOT_TOKEN) and never touches the database.
ALTER TABLE monitors ADD COLUMN telegram_chat_id TEXT;
