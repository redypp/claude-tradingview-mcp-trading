/**
 * Governance Dashboard — web UI.
 *
 * Reads mandates/, state/portfolio.json, and state/log-*.json.
 * Shows: mandate list, per-strategy equity/drawdown, kill state,
 * recent trades, and mandate divergence flags.
 *
 * Run: node dashboard.js
 */

import "dotenv/config";
import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { loadMandate, listMandates } from "./portfolio/mandate.js";
import { loadPortfolioState } from "./portfolio/state.js";
import { computeStats, compareToMandate } from "./portfolio/attribution.js";

const PORT = process.env.PORT || 3000;

function loadStrategyLog(name) {
  const p = join("state", `log-${name}.json`);
  if (!existsSync(p)) return { trades: [], exits: [], meta: {} };
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch { return { trades: [], exits: [], meta: {} }; }
}

function buildSummary() {
  const portfolioState = loadPortfolioState();
  const mandateNames = listMandates();
  const strategies = mandateNames.map((n) => {
    let mandate;
    try { mandate = loadMandate(n); } catch (err) { return { name: n, error: err.message }; }
    const state = portfolioState.strategies[n];
    const stats = state ? computeStats(state) : null;
    const flags = stats ? compareToMandate(stats, mandate) : [];
    const log = loadStrategyLog(n);
    return {
      name: n,
      mandate: {
        displayName: mandate.displayName,
        status: mandate.status,
        version: mandate.version,
        thesis: mandate.thesis,
        killReason: mandate.killReason,
        broker: mandate.broker,
        capital: mandate.capital,
        expected: mandate.expected,
        revisions: mandate.revisions || [],
      },
      state: state || null,
      stats,
      flags,
      recentTrades: (log.trades || []).slice(-10).reverse(),
      recentExits: (log.exits || []).slice(-10).reverse(),
      lastRebalance: log.meta?.lastRebalanceDate || null,
    };
  });

  const totals = strategies.reduce(
    (acc, s) => {
      if (!s.stats) return acc;
      acc.equity += s.stats.currentEquity;
      acc.starting += s.stats.startingEquity;
      return acc;
    },
    { equity: 0, starting: 0 },
  );

  return {
    generatedAt: new Date().toISOString(),
    strategies,
    totals,
    mandateCount: strategies.length,
    activeCount: strategies.filter((s) => s.mandate?.status === "paper" || s.mandate?.status === "live").length,
    killedCount: strategies.filter((s) => s.mandate?.status === "killed").length,
  };
}

const HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Fund Governance</title>
<style>
  :root { --bg:#0b0d10; --panel:#13161b; --border:#272c34; --text:#e6e9ee; --text2:#8a929e;
          --green:#3ddc84; --red:#ff5c5c; --blue:#5aa4ff; --amber:#f4b740; --purple:#c293ff; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 -apple-system,system-ui,sans-serif; padding:24px; }
  h1 { font-size:20px; margin:0 0 4px; }
  h2 { font-size:15px; margin:20px 0 8px; color:var(--text2); letter-spacing:0.08em; text-transform:uppercase; }
  .sub { color:var(--text2); font-size:13px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:16px; margin-bottom:12px; }
  .row { display:flex; gap:12px; flex-wrap:wrap; }
  .row > .card { flex:1 1 240px; }
  .stat { font-size:22px; font-weight:600; }
  .stat-label { color:var(--text2); font-size:12px; margin-bottom:4px; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; letter-spacing:0.04em; text-transform:uppercase; }
  .pill.paper { background:rgba(90,164,255,0.15); color:var(--blue); }
  .pill.live { background:rgba(61,220,132,0.15); color:var(--green); }
  .pill.paused { background:rgba(244,183,64,0.15); color:var(--amber); }
  .pill.killed { background:rgba(255,92,92,0.15); color:var(--red); }
  .green { color:var(--green); }
  .red { color:var(--red); }
  .amber { color:var(--amber); }
  .muted { color:var(--text2); }
  code { background:#1b1f26; border:1px solid var(--border); border-radius:4px; padding:1px 6px; font-size:12px; }
  .thesis { font-size:13px; color:var(--text2); line-height:1.55; margin-top:6px; }
  .flag { color:var(--amber); font-size:12px; margin-top:6px; }
  .flag.kill { color:var(--red); }
  .trade { font-family:ui-monospace,monospace; font-size:12px; color:var(--text2); padding:4px 0; border-bottom:1px solid var(--border); }
  .trade:last-child { border:0; }
  .refresh { position:fixed; top:16px; right:24px; color:var(--text2); font-size:11px; }
</style>
</head>
<body>
<div class="refresh" id="ts"></div>
<h1>Fund Governance</h1>
<div class="sub" id="sub"></div>

<div id="totals" class="row" style="margin-top:16px"></div>

<h2>Strategies</h2>
<div id="strategies"></div>

<script>
async function load() {
  const res = await fetch('/api/summary');
  const d = await res.json();

  document.getElementById('ts').textContent = 'updated ' + new Date(d.generatedAt).toLocaleTimeString();
  document.getElementById('sub').textContent = d.mandateCount + ' mandate' + (d.mandateCount === 1 ? '' : 's') +
    ' · ' + d.activeCount + ' active · ' + d.killedCount + ' killed';

  const totals = document.getElementById('totals');
  totals.innerHTML = '';
  if (d.totals.starting > 0) {
    const pnl = d.totals.equity - d.totals.starting;
    const pnlPct = pnl / d.totals.starting;
    totals.innerHTML = \`
      <div class="card"><div class="stat-label">Total equity</div><div class="stat">$\${d.totals.equity.toFixed(2)}</div></div>
      <div class="card"><div class="stat-label">Starting capital</div><div class="stat">$\${d.totals.starting.toFixed(2)}</div></div>
      <div class="card"><div class="stat-label">P&L</div><div class="stat \${pnl>=0?'green':'red'}">\${pnl>=0?'+':''}\${(pnlPct*100).toFixed(2)}%</div></div>
    \`;
  }

  const s = document.getElementById('strategies');
  s.innerHTML = d.strategies.length
    ? d.strategies.map(renderStrategy).join('')
    : '<div class="card muted">No mandates. Create one at mandates/&lt;name&gt;.json</div>';
}

function renderStrategy(s) {
  if (s.error) return \`<div class="card"><b>\${s.name}</b> <span class="red">error: \${s.error}</span></div>\`;
  const m = s.mandate;
  const stats = s.stats;
  const pct = (x) => (x == null ? '—' : (x*100).toFixed(2) + '%');
  const usd = (x) => (x == null ? '—' : '$' + x.toFixed(2));

  const flagsHtml = (s.flags || []).map(f => {
    const isKill = f.startsWith('KILL');
    return \`<div class="flag \${isKill?'kill':''}">\${isKill?'⛔':'⚠️'} \${f}</div>\`;
  }).join('');

  const statsBlock = stats ? \`
    <div class="row" style="margin-top:12px">
      <div class="card"><div class="stat-label">Equity</div><div class="stat">\${usd(stats.currentEquity)}</div></div>
      <div class="card"><div class="stat-label">Peak</div><div class="stat">\${usd(stats.peakEquity)}</div></div>
      <div class="card"><div class="stat-label">Drawdown</div><div class="stat \${stats.drawdownPct>0.10?'red':stats.drawdownPct>0.05?'amber':''}">\${pct(stats.drawdownPct)}</div></div>
      <div class="card"><div class="stat-label">CAGR</div><div class="stat">\${pct(stats.cagr)}</div></div>
      <div class="card"><div class="stat-label">Sharpe</div><div class="stat">\${stats.sharpe.toFixed(2)}</div></div>
      <div class="card"><div class="stat-label">Trades</div><div class="stat">\${stats.tradeCount}</div></div>
    </div>
  \` : '<div class="muted" style="margin-top:8px">No state yet — strategy has not run.</div>';

  const killBlock = s.state?.killed
    ? \`<div class="flag kill">⛔ KILLED: \${s.state.killReason || '(no reason recorded)'}</div>\`
    : '';

  const mandateKill = m.status === 'killed'
    ? \`<div class="flag kill">⛔ MANDATE KILLED: \${m.killReason || '(no reason recorded)'}</div>\`
    : '';

  const tradesHtml = (s.recentTrades || []).length
    ? s.recentTrades.map(t => \`<div class="trade">\${(t.timestamp||'').slice(0,16)} · \${t.side?.toUpperCase()||''} \${t.symbol} \${t.notional?'· $'+t.notional.toFixed(0):''} \${t.signal?'· '+t.signal:''}</div>\`).join('')
    : '<div class="muted" style="font-size:12px">No trades yet.</div>';

  return \`
    <div class="card">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:12px">
        <div>
          <b style="font-size:16px">\${m.displayName}</b>
          <span class="pill \${m.status}" style="margin-left:8px">\${m.status}</span>
          \${m.version ? '<span class="muted" style="font-size:12px; margin-left:6px">v'+m.version+'</span>' : ''}
        </div>
        <div class="muted" style="font-size:12px"><code>\${s.name}</code> · \${m.broker.type}/\${m.broker.account_env_prefix}</div>
      </div>
      <div class="thesis">\${m.thesis || ''}</div>
      \${mandateKill}
      \${killBlock}
      \${statsBlock}
      \${flagsHtml}
      <h2 style="margin-top:16px; font-size:12px">Recent trades</h2>
      \${tradesHtml}
      \${s.lastRebalance ? '<div class="muted" style="font-size:12px; margin-top:8px">Last rebalance: '+s.lastRebalance+'</div>' : ''}
    </div>
  \`;
}

load();
setInterval(load, 15000);
</script>
</body>
</html>`;

const server = createServer((req, res) => {
  if (req.url === "/api/summary") {
    try {
      const body = JSON.stringify(buildSummary());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(HTML);
});

server.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
});
