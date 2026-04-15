/**
 * Curated list of ~100 highly liquid S&P 500 names.
 * Used as the scan universe for mean-reversion / factor strategies.
 *
 * Criteria: market cap > $50B, avg daily dollar volume > $100M,
 * no dual-class share duplicates (e.g., GOOGL only, not GOOG).
 *
 * Refresh quarterly — tickers drop out of indices, new ones enter.
 * Last refresh: 2026-04-14.
 */

export const SP500_TOP_LIQUID = [
  "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "LLY",
  "AVGO", "JPM", "V", "WMT", "XOM", "UNH", "MA", "PG",
  "JNJ", "HD", "ORCL", "COST", "NFLX", "BAC", "CVX", "ABBV",
  "KO", "CRM", "PEP", "ADBE", "AMD", "TMO", "MRK", "CSCO",
  "ACN", "LIN", "MCD", "WFC", "ABT", "DHR", "TXN", "NKE",
  "PM", "DIS", "IBM", "INTC", "QCOM", "VZ", "NOW", "CMCSA",
  "CAT", "UNP", "GE", "HON", "UPS", "LOW", "SPGI", "INTU",
  "MS", "AMGN", "BA", "GS", "BLK", "SYK", "AXP", "MDT",
  "DE", "GILD", "BKNG", "T", "ELV", "ADI", "PLD", "MMC",
  "AMAT", "TJX", "ETN", "SBUX", "C", "LRCX", "ADP", "VRTX",
  "SCHW", "CI", "MO", "TMUS", "MU", "ZTS", "BMY", "CB",
  "FI", "PANW", "REGN", "DUK", "ICE", "SO", "PGR", "NOC",
  "EQIX", "APD", "CL", "ITW",
];
