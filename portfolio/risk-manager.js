import { markKilled } from "./mandate.js";
import { recordKill, recordTrade, updateEquity } from "./state.js";

/**
 * Wraps a broker with portfolio-level governance.
 * Intercepts placeOrder to enforce mandate limits and kill switches.
 * Other broker methods pass through unchanged.
 */
export function wrapBroker({ broker, mandate, strategyState, savePortfolioState, portfolioState, notify }) {
  async function syncEquity() {
    try {
      const account = await broker.fetchAccount();
      const equity = Number(account.equity ?? account.portfolio_value ?? 0);
      if (Number.isFinite(equity) && equity > 0) {
        updateEquity(strategyState, equity);
        savePortfolioState(portfolioState);
      }
    } catch (err) {
      console.log(`  ⚠️  Equity sync failed: ${err.message}`);
    }
  }

  async function checkKillSwitches() {
    if (strategyState.killed) {
      return { killed: true, reason: strategyState.killReason };
    }
    const ks = mandate.killSwitches || {};
    if (ks.maxDrawdownPct != null && strategyState.drawdownPct >= ks.maxDrawdownPct) {
      const reason = `Drawdown ${(strategyState.drawdownPct * 100).toFixed(1)}% breached limit ${(ks.maxDrawdownPct * 100).toFixed(1)}%`;
      recordKill(strategyState, reason);
      markKilled(mandate, reason);
      savePortfolioState(portfolioState);
      if (notify) await notify.error("Kill switch", reason);
      return { killed: true, reason };
    }
    return { killed: false };
  }

  async function placeOrder(orderArgs) {
    const kill = await checkKillSwitches();
    if (kill.killed) {
      throw new Error(`Strategy killed — order rejected. Reason: ${kill.reason}`);
    }

    const equity = strategyState.currentEquity;
    const limits = mandate.limits || {};

    if (orderArgs.notional != null) {
      const notional = Number(orderArgs.notional);
      const maxSingle = (limits.maxSinglePositionPct || 1) * equity;
      if (notional > maxSingle) {
        const clamped = maxSingle;
        if (notify) {
          await notify.info(
            "Risk manager resize",
            `${orderArgs.symbol} notional ${notional.toFixed(2)} → ${clamped.toFixed(2)} (max ${(limits.maxSinglePositionPct * 100).toFixed(0)}% of equity)`,
          );
        }
        orderArgs = { ...orderArgs, notional: clamped };
      }
    }

    if (orderArgs.side === "buy" && limits.maxGrossExposurePct != null) {
      try {
        const positions = await broker.fetchPositions();
        const currentGross = positions.reduce(
          (sum, p) => sum + Math.abs(Number(p.market_value ?? 0)),
          0,
        );
        const addNotional = Number(orderArgs.notional ?? 0);
        const maxGross = limits.maxGrossExposurePct * equity;
        if (currentGross + addNotional > maxGross) {
          const available = Math.max(0, maxGross - currentGross);
          if (available < 1) {
            throw new Error(
              `Gross exposure limit hit (${currentGross.toFixed(2)} + ${addNotional.toFixed(2)} > ${maxGross.toFixed(2)})`,
            );
          }
          orderArgs = { ...orderArgs, notional: available };
          if (notify) {
            await notify.info(
              "Risk manager resize",
              `${orderArgs.symbol} clipped to ${available.toFixed(2)} (gross-exposure cap)`,
            );
          }
        }
      } catch (err) {
        if (err.message.startsWith("Gross exposure limit")) throw err;
        console.log(`  ⚠️  Gross exposure check failed: ${err.message}`);
      }
    }

    const result = await broker.placeOrder(orderArgs);
    // Skip persisting state changes for dry-run synthetic orders.
    if (!String(result?.orderId || "").startsWith("dry-")) {
      recordTrade(strategyState);
      savePortfolioState(portfolioState);
    }
    return result;
  }

  return {
    ...broker,
    placeOrder,
    __governance: { syncEquity, checkKillSwitches, mandate, strategyState },
  };
}
