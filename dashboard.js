/**
 * Trading Bot Dashboard — Web UI
 *
 * Serves a clean dark dashboard showing:
 * - Bot status & next run
 * - Strategy overview (V5)
 * - Stack & costs
 * - Trading journal (from trades.csv + safety-check-log.json)
 * - Insider watchlist
 * - Performance metrics
 * - Backtest results
 *
 * Usage: node dashboard.js
 * Runs on port 3000 (or PORT env var)
 */

import "dotenv/config";
import { createServer } from "http";
import { readFileSync, existsSync } from "fs";

const PORT = process.env.PORT || 3000;

// ─── Data Loaders ───────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync("safety-check-log.json")) return { trades: [] };
  try { return JSON.parse(readFileSync("safety-check-log.json", "utf8")); }
  catch { return { trades: [] }; }
}

function loadRules() {
  if (!existsSync("rules.json")) return {};
  try { return JSON.parse(readFileSync("rules.json", "utf8")); }
  catch { return {}; }
}

function loadCsv() {
  if (!existsSync("trades.csv")) return [];
  const lines = readFileSync("trades.csv", "utf8").trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map(line => {
    const vals = line.split(",");
    const obj = {};
    headers.forEach((h, i) => obj[h.trim()] = (vals[i] || "").replace(/^"|"$/g, ""));
    return obj;
  }).filter(r => r.Date && r.Date.match(/^\d{4}/));
}

function loadBacktestResults() {
  if (!existsSync("backtest-v2-results.json")) return null;
  try { return JSON.parse(readFileSync("backtest-v2-results.json", "utf8")); }
  catch { return null; }
}

// ─── API Endpoints ──────────────────────────────────────────────────────────

function getApiData(path) {
  if (path === "/api/status") {
    const log = loadLog();
    const today = new Date().toISOString().slice(0, 10);
    const todayTrades = log.trades.filter(t => t.timestamp?.startsWith(today) && t.orderPlaced);
    const lastRun = log.trades.length > 0 ? log.trades[log.trades.length - 1] : null;
    return {
      paperTrading: process.env.PAPER_TRADING !== "false",
      totalDecisions: log.trades.length,
      todayTrades: todayTrades.length,
      maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
      lastRun: lastRun ? {
        timestamp: lastRun.timestamp,
        symbol: lastRun.symbol,
        decision: lastRun.allPass ? "TRADE" : "BLOCKED",
        bias: lastRun.bias,
      } : null,
      schedule: "9:30 AM + 4:30 PM ET, Mon-Fri",
    };
  }

  if (path === "/api/journal") {
    const log = loadLog();
    return log.trades.slice().reverse().slice(0, 100);
  }

  if (path === "/api/rules") {
    return loadRules();
  }

  if (path === "/api/csv") {
    return loadCsv().reverse();
  }

  if (path === "/api/performance") {
    const log = loadLog();
    const executed = log.trades.filter(t => t.orderPlaced);
    const blocked = log.trades.filter(t => !t.allPass);
    const trades = loadCsv().filter(r => r.Mode === "PAPER" || r.Mode === "LIVE");
    return {
      totalDecisions: log.trades.length,
      executed: executed.length,
      blocked: blocked.length,
      trades,
    };
  }

  if (path === "/api/backtest") {
    return loadBacktestResults();
  }

  return null;
}

// ─── HTML ───────────────────────────────────────────────────────────────────

function renderPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Trading Bot Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --surface2: #1a1a26;
    --border: #2a2a3a;
    --text: #e0e0e8;
    --text2: #8888a0;
    --green: #00d4aa;
    --red: #ff4466;
    --blue: #4488ff;
    --yellow: #ffaa00;
    --purple: #aa66ff;
  }
  body {
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    min-height: 100vh;
  }
  .header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    position: sticky;
    top: 0;
    z-index: 100;
  }
  .header h1 { font-size: 16px; font-weight: 600; letter-spacing: 1px; }
  .header .mode {
    padding: 4px 12px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 1px;
  }
  .mode-paper { background: var(--yellow); color: #000; }
  .mode-live { background: var(--red); color: #fff; }

  .nav {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    display: flex;
    gap: 0;
    overflow-x: auto;
    padding: 0 24px;
  }
  .nav button {
    background: none;
    border: none;
    color: var(--text2);
    padding: 12px 20px;
    font-family: inherit;
    font-size: 13px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    white-space: nowrap;
    transition: all 0.2s;
  }
  .nav button:hover { color: var(--text); }
  .nav button.active { color: var(--green); border-bottom-color: var(--green); }

  .content { max-width: 1200px; margin: 0 auto; padding: 24px; }
  .tab { display: none; }
  .tab.active { display: block; }

  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 20px;
  }
  .card h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: var(--text2); margin-bottom: 12px; }
  .card .value { font-size: 28px; font-weight: 700; }
  .card .sub { font-size: 12px; color: var(--text2); margin-top: 4px; }

  .green { color: var(--green); }
  .red { color: var(--red); }
  .blue { color: var(--blue); }
  .yellow { color: var(--yellow); }
  .purple { color: var(--purple); }

  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 10px 12px; color: var(--text2); font-size: 11px; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid var(--border); }
  td { padding: 10px 12px; border-bottom: 1px solid var(--border); }
  tr:hover td { background: var(--surface2); }

  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 3px;
    font-size: 11px;
    font-weight: 600;
  }
  .badge-green { background: rgba(0,212,170,0.15); color: var(--green); }
  .badge-red { background: rgba(255,68,102,0.15); color: var(--red); }
  .badge-yellow { background: rgba(255,170,0,0.15); color: var(--yellow); }
  .badge-blue { background: rgba(68,136,255,0.15); color: var(--blue); }

  .section { margin-bottom: 32px; }
  .section h2 { font-size: 14px; font-weight: 600; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }

  .rule-list { list-style: none; }
  .rule-list li { padding: 8px 0; border-bottom: 1px solid var(--border); display: flex; align-items: flex-start; gap: 8px; }
  .rule-list li:last-child { border: none; }
  .rule-icon { flex-shrink: 0; margin-top: 2px; }

  .cost-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--border); }
  .cost-row:last-child { border: none; font-weight: 700; }
  .cost-label { color: var(--text2); }

  .condition { padding: 6px 0; display: flex; align-items: center; gap: 8px; }
  .condition .icon { width: 18px; text-align: center; }

  .empty { text-align: center; padding: 40px; color: var(--text2); }

  @media (max-width: 768px) {
    .grid { grid-template-columns: 1fr; }
    .nav { padding: 0 12px; }
    .nav button { padding: 10px 14px; font-size: 12px; }
    .content { padding: 16px; }
  }
</style>
</head>
<body>

<div class="header">
  <h1>TRADING BOT</h1>
  <div class="mode" id="mode-badge">...</div>
</div>

<div class="nav">
  <button class="active" onclick="showTab('status')">Status</button>
  <button onclick="showTab('strategy')">Strategy</button>
  <button onclick="showTab('stack')">Stack & Costs</button>
  <button onclick="showTab('journal')">Journal</button>
  <button onclick="showTab('performance')">Performance</button>
  <button onclick="showTab('backtest')">Backtest</button>
</div>

<div class="content">

<!-- STATUS TAB -->
<div class="tab active" id="tab-status">
  <div class="grid" id="status-cards"></div>
  <div class="section">
    <h2>Last Decision</h2>
    <div id="last-decision" class="card"><div class="empty">Loading...</div></div>
  </div>
  <div class="section">
    <h2>Recent Decisions</h2>
    <div class="card" style="overflow-x:auto">
      <table>
        <thead><tr><th>Time</th><th>Symbol</th><th>Decision</th><th>Bias</th><th>Price</th></tr></thead>
        <tbody id="recent-decisions"></tbody>
      </table>
    </div>
  </div>
</div>

<!-- STRATEGY TAB -->
<div class="tab" id="tab-strategy">
  <div class="section">
    <h2>Strategy Overview</h2>
    <div class="card" id="strategy-overview"></div>
  </div>
  <div class="grid">
    <div class="section">
      <h2>Entry Conditions</h2>
      <div class="card"><ul class="rule-list" id="entry-rules"></ul></div>
    </div>
    <div class="section">
      <h2>Exit Rules</h2>
      <div class="card"><ul class="rule-list" id="exit-rules"></ul></div>
    </div>
  </div>
  <div class="section">
    <h2>Risk Rules</h2>
    <div class="card"><ul class="rule-list" id="risk-rules"></ul></div>
  </div>
  <div class="section">
    <h2>Why This Works</h2>
    <div class="card" id="why-works"></div>
  </div>
</div>

<!-- STACK & COSTS TAB -->
<div class="tab" id="tab-stack">
  <div class="section">
    <h2>Technology Stack</h2>
    <div class="grid">
      <div class="card">
        <h3>Broker</h3>
        <div class="value blue">Alpaca</div>
        <div class="sub">Paper trading account, $20,000</div>
        <div class="sub">Stocks + crypto, commission-free for stocks</div>
      </div>
      <div class="card">
        <h3>Insider Data</h3>
        <div class="value purple">Finnhub</div>
        <div class="sub">SEC Form 4 filings (insider transactions)</div>
        <div class="sub">Free tier: 60 calls/min</div>
      </div>
      <div class="card">
        <h3>Cloud Runtime</h3>
        <div class="value yellow">Railway</div>
        <div class="sub">Runs bot on cron schedule</div>
        <div class="sub">9:30 AM + 4:30 PM ET, Mon-Fri</div>
      </div>
      <div class="card">
        <h3>AI / Development</h3>
        <div class="value green">Claude Code</div>
        <div class="sub">Strategy development, backtesting, deployment</div>
        <div class="sub">TradingView MCP for live chart reading</div>
      </div>
      <div class="card">
        <h3>Charts</h3>
        <div class="value" style="color:var(--text)">TradingView</div>
        <div class="sub">Visual monitoring (IVB, FVG, EMAs, RSI)</div>
        <div class="sub">Not used by cloud bot directly</div>
      </div>
      <div class="card">
        <h3>Source Control</h3>
        <div class="value" style="color:var(--text)">GitHub</div>
        <div class="sub">redypp/claude-tradingview-mcp-trading</div>
        <div class="sub">All code backed up</div>
      </div>
    </div>
  </div>
  <div class="section">
    <h2>Monthly Cost Estimate</h2>
    <div class="card">
      <div class="cost-row"><span class="cost-label">Alpaca (paper trading)</span><span class="green">Free</span></div>
      <div class="cost-row"><span class="cost-label">Alpaca (live — commission-free stocks)</span><span class="green">Free</span></div>
      <div class="cost-row"><span class="cost-label">Finnhub (free tier)</span><span class="green">Free</span></div>
      <div class="cost-row"><span class="cost-label">Railway (Hobby plan)</span><span>$5/mo</span></div>
      <div class="cost-row"><span class="cost-label">TradingView (Essential)</span><span>$13/mo</span></div>
      <div class="cost-row"><span class="cost-label">Claude Code (Pro plan)</span><span>$20/mo</span></div>
      <div class="cost-row"><span class="cost-label">GitHub</span><span class="green">Free</span></div>
      <div class="cost-row" style="margin-top:8px; padding-top:12px; border-top:2px solid var(--border)"><span>Total</span><span class="yellow">~$38/mo</span></div>
    </div>
  </div>
</div>

<!-- JOURNAL TAB -->
<div class="tab" id="tab-journal">
  <div class="section">
    <h2>Trading Journal</h2>
    <div class="card" style="overflow-x:auto">
      <table>
        <thead><tr><th>Date</th><th>Symbol</th><th>Side</th><th>Price</th><th>Size</th><th>Mode</th><th>Notes</th></tr></thead>
        <tbody id="journal-body"></tbody>
      </table>
    </div>
  </div>
  <div class="section">
    <h2>Decision Log (with indicators)</h2>
    <div id="decision-cards"></div>
  </div>
</div>

<!-- PERFORMANCE TAB -->
<div class="tab" id="tab-performance">
  <div class="grid" id="perf-cards"></div>
  <div class="section">
    <h2>Trade History</h2>
    <div class="card" style="overflow-x:auto">
      <table>
        <thead><tr><th>Date</th><th>Symbol</th><th>Side</th><th>Price</th><th>Total</th><th>Mode</th><th>Status</th></tr></thead>
        <tbody id="perf-table"></tbody>
      </table>
    </div>
  </div>
</div>

<!-- BACKTEST TAB -->
<div class="tab" id="tab-backtest">
  <div class="section">
    <h2>Strategy Comparison (Backtest Results)</h2>
    <div class="card" style="overflow-x:auto">
      <table>
        <thead><tr><th>Strategy</th><th>Trades</th><th>Win%</th><th>PF</th><th>Avg%</th><th>AvgW%</th><th>AvgL%</th><th>W/L</th><th>$/trade</th></tr></thead>
        <tbody id="backtest-table"></tbody>
      </table>
    </div>
  </div>
  <div id="backtest-details"></div>
</div>

</div>

<script>
function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav button').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  document.querySelector('.nav button[onclick*="' + name + '"]').classList.add('active');
}

async function loadStatus() {
  const res = await fetch('/api/status');
  const d = await res.json();

  const badge = document.getElementById('mode-badge');
  badge.textContent = d.paperTrading ? 'PAPER' : 'LIVE';
  badge.className = 'mode ' + (d.paperTrading ? 'mode-paper' : 'mode-live');

  document.getElementById('status-cards').innerHTML = \`
    <div class="card"><h3>Mode</h3><div class="value \${d.paperTrading ? 'yellow' : 'red'}">\${d.paperTrading ? 'Paper' : 'LIVE'}</div><div class="sub">\${d.paperTrading ? 'No real money at risk' : 'Real trades executing'}</div></div>
    <div class="card"><h3>Today's Trades</h3><div class="value">\${d.todayTrades}<span style="font-size:14px;color:var(--text2)"> / \${d.maxTradesPerDay}</span></div><div class="sub">Daily limit</div></div>
    <div class="card"><h3>Total Decisions</h3><div class="value blue">\${d.totalDecisions}</div><div class="sub">All-time bot runs</div></div>
    <div class="card"><h3>Schedule</h3><div class="value" style="font-size:16px">\${d.schedule}</div><div class="sub">Automatic on Railway</div></div>
  \`;

  if (d.lastRun) {
    const time = new Date(d.lastRun.timestamp).toLocaleString();
    const isTraded = d.lastRun.decision === 'TRADE';
    document.getElementById('last-decision').innerHTML = \`
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:20px;font-weight:700">\${d.lastRun.symbol}</div>
          <div class="sub">\${time}</div>
        </div>
        <div class="badge \${isTraded ? 'badge-green' : 'badge-red'}">\${d.lastRun.decision}</div>
      </div>
      <div class="sub" style="margin-top:8px">Bias: \${d.lastRun.bias || 'N/A'}</div>
    \`;
  }
}

async function loadJournal() {
  const [csvRes, logRes] = await Promise.all([fetch('/api/csv'), fetch('/api/journal')]);
  const csv = await csvRes.json();
  const log = await logRes.json();

  document.getElementById('journal-body').innerHTML = csv.map(r => \`
    <tr>
      <td>\${r.Date} \${r['Time (UTC)'] || ''}</td>
      <td><strong>\${r.Symbol || ''}</strong></td>
      <td>\${r.Side ? '<span class="badge ' + (r.Side === 'BUY' ? 'badge-green' : 'badge-red') + '">' + r.Side + '</span>' : ''}</td>
      <td>\${r.Price ? '$' + parseFloat(r.Price).toFixed(2) : ''}</td>
      <td>\${r['Total USD'] ? '$' + r['Total USD'] : ''}</td>
      <td><span class="badge \${r.Mode === 'PAPER' ? 'badge-yellow' : r.Mode === 'LIVE' ? 'badge-green' : 'badge-red'}">\${r.Mode || ''}</span></td>
      <td style="font-size:12px;color:var(--text2)">\${r.Notes || ''}</td>
    </tr>
  \`).join('');

  document.getElementById('recent-decisions').innerHTML = log.slice(0, 20).map(t => {
    const time = new Date(t.timestamp).toLocaleString();
    const dec = t.allPass ? 'TRADE' : 'BLOCKED';
    return \`<tr>
      <td>\${time}</td>
      <td><strong>\${t.symbol}</strong></td>
      <td><span class="badge \${t.allPass ? 'badge-green' : 'badge-red'}">\${dec}</span></td>
      <td>\${t.bias || ''}</td>
      <td>\${t.price ? '$' + t.price.toFixed(2) : ''}</td>
    </tr>\`;
  }).join('');

  document.getElementById('decision-cards').innerHTML = log.slice(0, 20).map(t => {
    const time = new Date(t.timestamp).toLocaleString();
    const conditions = (t.conditions || []).map(c => \`
      <div class="condition">
        <span class="icon">\${c.pass ? '&#10003;' : '&#10007;'}</span>
        <span style="color:\${c.pass ? 'var(--green)' : 'var(--red)'}">\${c.label}</span>
        <span style="color:var(--text2);font-size:11px;margin-left:auto">\${c.actual || ''}</span>
      </div>
    \`).join('');

    const ind = t.indicators || {};
    return \`
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div>
            <strong>\${t.symbol}</strong> <span style="color:var(--text2)">\${time}</span>
          </div>
          <span class="badge \${t.allPass ? 'badge-green' : 'badge-red'}">\${t.allPass ? 'TRADED' : 'BLOCKED'}</span>
        </div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--text2);margin-bottom:12px">
          \${ind.ema10 ? '<span>EMA10: $' + ind.ema10.toFixed(2) + '</span>' : ''}
          \${ind.ema21 ? '<span>EMA21: $' + ind.ema21.toFixed(2) + '</span>' : ''}
          \${ind.sma200 ? '<span>SMA200: $' + ind.sma200.toFixed(2) + '</span>' : ''}
          \${ind.rsi ? '<span>RSI: ' + ind.rsi.toFixed(1) + '</span>' : ''}
          \${ind.atr ? '<span>ATR: $' + ind.atr.toFixed(2) + '</span>' : ''}
        </div>
        \${conditions}
        \${t.insiderData ? '<div style="margin-top:8px;font-size:12px;color:var(--text2)">Insiders: ' + (t.insiderData.buys||0) + ' buys, ' + (t.insiderData.sells||0) + ' sells</div>' : ''}
      </div>
    \`;
  }).join('');
}

async function loadStrategy() {
  const res = await fetch('/api/rules');
  const r = await res.json();

  document.getElementById('strategy-overview').innerHTML = \`
    <div class="value" style="font-size:18px;margin-bottom:8px">\${r.strategy?.name || 'N/A'}</div>
    <div style="color:var(--text2);font-size:13px;margin-bottom:16px">\${r.strategy?.description || ''}</div>
    \${r.strategy?.backtest_results ? \`
      <div style="display:flex;gap:24px;flex-wrap:wrap;font-size:13px">
        <div><span class="green">\${r.strategy.backtest_results.trades}</span> trades</div>
        <div>Win: <span class="green">\${r.strategy.backtest_results.win_rate}</span></div>
        <div>PF: <span class="blue">\${r.strategy.backtest_results.profit_factor}</span></div>
        <div>W/L: <span class="purple">\${r.strategy.backtest_results.wl_ratio}x</span></div>
        <div>Avg W: <span class="green">\${r.strategy.backtest_results.avg_winner}</span></div>
        <div>Avg L: <span class="red">\${r.strategy.backtest_results.avg_loser}</span></div>
      </div>
    \` : ''}
  \`;

  const entryRules = r.entry_rules?.long || [];
  document.getElementById('entry-rules').innerHTML = entryRules.map(rule =>
    \`<li><span class="rule-icon green">&#10003;</span> \${rule}</li>\`
  ).join('');

  const exitRules = r.exit_rules || [];
  document.getElementById('exit-rules').innerHTML = exitRules.map(rule =>
    \`<li><span class="rule-icon blue">&#8594;</span> \${rule}</li>\`
  ).join('');

  const riskRules = r.risk_rules || [];
  document.getElementById('risk-rules').innerHTML = riskRules.map(rule =>
    \`<li><span class="rule-icon yellow">&#9888;</span> \${rule}</li>\`
  ).join('');

  const why = r.why_this_works || {};
  document.getElementById('why-works').innerHTML = Object.entries(why).map(([k, v]) =>
    \`<div style="margin-bottom:12px"><strong style="text-transform:capitalize">\${k.replace(/_/g, ' ')}</strong><div style="color:var(--text2);font-size:13px;margin-top:4px">\${v}</div></div>\`
  ).join('');
}

async function loadPerformance() {
  const res = await fetch('/api/performance');
  const d = await res.json();

  document.getElementById('perf-cards').innerHTML = \`
    <div class="card"><h3>Total Decisions</h3><div class="value">\${d.totalDecisions}</div></div>
    <div class="card"><h3>Trades Executed</h3><div class="value green">\${d.executed}</div></div>
    <div class="card"><h3>Trades Blocked</h3><div class="value red">\${d.blocked}</div></div>
    <div class="card"><h3>Block Rate</h3><div class="value yellow">\${d.totalDecisions > 0 ? ((d.blocked/d.totalDecisions)*100).toFixed(0) : 0}%</div></div>
  \`;

  document.getElementById('perf-table').innerHTML = d.trades.map(r => \`
    <tr>
      <td>\${r.Date}</td>
      <td><strong>\${r.Symbol}</strong></td>
      <td>\${r.Side || ''}</td>
      <td>\${r.Price ? '$' + parseFloat(r.Price).toFixed(2) : ''}</td>
      <td>\${r['Total USD'] ? '$' + r['Total USD'] : ''}</td>
      <td><span class="badge badge-yellow">\${r.Mode}</span></td>
      <td><span class="badge badge-green">Executed</span></td>
    </tr>
  \`).join('') || '<tr><td colspan="7" class="empty">No trades yet — bot is watching and waiting</td></tr>';
}

async function loadBacktest() {
  const res = await fetch('/api/backtest');
  const data = await res.json();
  if (!data) {
    document.getElementById('backtest-table').innerHTML = '<tr><td colspan="9" class="empty">No backtest results found</td></tr>';
    return;
  }

  const rows = Object.entries(data).map(([name, v]) => {
    const s = v.stats;
    if (!s) return '';
    const best = name.includes('V5');
    return \`<tr style="\${best ? 'background:rgba(0,212,170,0.05)' : ''}">
      <td>\${best ? '<strong>' : ''}\${name}\${best ? ' &#9733;</strong>' : ''}</td>
      <td>\${s.n}</td>
      <td>\${s.wr.toFixed(1)}%</td>
      <td class="\${s.pf > 1 ? 'green' : 'red'}">\${s.pf.toFixed(2)}</td>
      <td class="\${s.avgPnl > 0 ? 'green' : 'red'}">\${s.avgPnl > 0 ? '+' : ''}\${s.avgPnl.toFixed(2)}%</td>
      <td class="green">+\${s.avgW.toFixed(2)}%</td>
      <td class="red">\${s.avgL.toFixed(2)}%</td>
      <td>\${s.wl.toFixed(2)}</td>
      <td class="\${s.expectancy > 0 ? 'green' : 'red'}">$\${s.expectancy > 0 ? '+' : ''}\${s.expectancy.toFixed(2)}</td>
    </tr>\`;
  }).join('');

  document.getElementById('backtest-table').innerHTML = rows;
}

// Load everything
Promise.all([loadStatus(), loadJournal(), loadStrategy(), loadPerformance(), loadBacktest()]);
// Refresh status every 30s
setInterval(loadStatus, 30000);
</script>
</body>
</html>`;
}

// ─── Server ─────────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname.startsWith("/api/")) {
    const data = getApiData(url.pathname);
    if (data !== null) {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(data));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
    return;
  }

  // Serve dashboard
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(renderPage());
});

server.listen(PORT, () => {
  console.log(`\n  Dashboard running at http://localhost:${PORT}\n`);
});
