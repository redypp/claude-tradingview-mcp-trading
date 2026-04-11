/**
 * Telegram notifier. Single bot token, single chat — messages are
 * prefixed with the strategy name so multiple strategies can share
 * one chat without confusion.
 */

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendRaw(text) {
  if (!TOKEN || !CHAT_ID) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
    });
    if (!res.ok) {
      console.log(`  Telegram send failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.log(`  Telegram error: ${err.message}`);
  }
}

export function createNotifier(strategyName) {
  const prefix = `[${strategyName}]`;
  return {
    async info(text) {
      await sendRaw(`${prefix} ${text}`);
    },
    async tradeExecuted({ symbol, side, price, size, orderId, note }) {
      const icon = side === "buy" ? "🟢" : "🔴";
      await sendRaw(
        `${icon} <b>${prefix} TRADE PLACED</b>\n\n` +
        `Symbol: <b>${symbol}</b>\n` +
        `Side: ${side.toUpperCase()}\n` +
        `Price: $${price.toFixed(2)}\n` +
        `Size: $${size.toFixed(2)}\n` +
        `Order: ${orderId}` +
        (note ? `\nNote: ${note}` : ""),
      );
    },
    async positionClosed({ symbol, reason, entryPrice, exitPrice, pnlPct, daysHeld }) {
      const icon = pnlPct >= 0 ? "💰" : "📉";
      await sendRaw(
        `${icon} <b>${prefix} POSITION CLOSED</b> — ${symbol}\n\n` +
        `Reason: ${reason}\n` +
        `Entry: $${entryPrice.toFixed(2)} → Exit: $${exitPrice.toFixed(2)}\n` +
        `P&L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%\n` +
        `Held: ${daysHeld} trading day${daysHeld === 1 ? "" : "s"}`,
      );
    },
    async error(context, errorMsg) {
      await sendRaw(
        `❌ <b>${prefix} ERROR</b>\n\n` +
        `Context: ${context}\n` +
        `Error: ${errorMsg}`,
      );
    },
    async startup(mode) {
      const modeIcon = mode === "live" ? "🔴" : "📋";
      await sendRaw(
        `🤖 <b>${prefix} starting</b>\n\n` +
        `Mode: ${modeIcon} ${mode.toUpperCase()}\n` +
        `Time: ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET`,
      );
    },
  };
}
