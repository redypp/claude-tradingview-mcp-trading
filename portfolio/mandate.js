import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const MANDATES_DIR = "mandates";
const VALID_STATUSES = new Set(["paper", "live", "paused", "killed"]);

const REQUIRED_FIELDS = [
  "name",
  "displayName",
  "status",
  "thesis",
  "broker",
  "capital",
  "limits",
  "killSwitches",
  "expected",
];

export function listMandates() {
  if (!existsSync(MANDATES_DIR)) return [];
  return readdirSync(MANDATES_DIR)
    .filter((f) => f.endsWith(".json") && f !== "TEMPLATE.json")
    .map((f) => f.replace(/\.json$/, ""));
}

export function loadMandate(name) {
  const path = join(MANDATES_DIR, `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(`Mandate not found: ${path}`);
  }
  const mandate = JSON.parse(readFileSync(path, "utf8"));
  validateMandate(mandate, path);
  return mandate;
}

export function saveMandate(mandate) {
  const path = join(MANDATES_DIR, `${mandate.name}.json`);
  writeFileSync(path, JSON.stringify(mandate, null, 2) + "\n");
}

export function validateMandate(mandate, source = "<mandate>") {
  for (const field of REQUIRED_FIELDS) {
    if (mandate[field] == null) {
      throw new Error(`Mandate ${source} missing required field: ${field}`);
    }
  }
  if (!VALID_STATUSES.has(mandate.status)) {
    throw new Error(
      `Mandate ${source} has invalid status "${mandate.status}" — must be one of ${[...VALID_STATUSES].join(", ")}`,
    );
  }
  const lim = mandate.limits;
  if (lim.maxGrossExposurePct == null || lim.maxSinglePositionPct == null) {
    throw new Error(`Mandate ${source} limits must define maxGrossExposurePct and maxSinglePositionPct`);
  }
  const ks = mandate.killSwitches;
  if (ks.maxDrawdownPct == null) {
    throw new Error(`Mandate ${source} killSwitches must define maxDrawdownPct`);
  }
  const cap = mandate.capital;
  if (cap.startingEquity == null || cap.startingEquity <= 0) {
    throw new Error(`Mandate ${source} capital.startingEquity must be positive`);
  }
}

export function markKilled(mandate, reason) {
  mandate.status = "killed";
  mandate.killedAt = new Date().toISOString();
  mandate.killReason = reason;
  saveMandate(mandate);
}

export function isActive(mandate) {
  return mandate.status === "paper" || mandate.status === "live";
}
