/**
 * Entry point — runs bot or dashboard depending on RUN_MODE env var.
 * RUN_MODE=dashboard → starts the web dashboard
 * Otherwise → runs the trading bot
 */

if (process.env.RUN_MODE === "dashboard") {
  await import("./dashboard.js");
} else {
  await import("./bot.js");
}
