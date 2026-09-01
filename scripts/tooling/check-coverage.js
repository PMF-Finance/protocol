const fs = require("fs");
const path = require("path");

const lcovPath = path.join(__dirname, "..", "..", "coverage", "lcov.info");
const defaultThresholds = {
  lines: 90,
  functions: 96,
  branches: 64
};
const thresholds = {
  lines: readThreshold("COVERAGE_LINES", defaultThresholds.lines),
  functions: readThreshold("COVERAGE_FUNCTIONS", defaultThresholds.functions),
  branches: readThreshold("COVERAGE_BRANCHES", defaultThresholds.branches)
};

if (!fs.existsSync(lcovPath)) {
  console.error("Missing coverage/lcov.info. Run `npm run coverage` first.");
  process.exit(1);
}

console.log(
  "Coverage thresholds: "
    + `lines ${thresholds.lines}%, functions ${thresholds.functions}%, branches ${thresholds.branches}%`
);

const totals = {
  lines: { found: 0, hit: 0 },
  functions: { found: 0, hit: 0 },
  branches: { found: 0, hit: 0 }
};

for (const line of fs.readFileSync(lcovPath, "utf8").split(/\r?\n/)) {
  addMetric(line, "LF:", totals.lines, "found");
  addMetric(line, "LH:", totals.lines, "hit");
  addMetric(line, "FNF:", totals.functions, "found");
  addMetric(line, "FNH:", totals.functions, "hit");
  addMetric(line, "BRF:", totals.branches, "found");
  addMetric(line, "BRH:", totals.branches, "hit");
}

let failed = false;
for (const [name, total] of Object.entries(totals)) {
  const percent = total.found === 0 ? 100 : (total.hit / total.found) * 100;
  const required = thresholds[name];
  console.log(
    `${name}: ${percent.toFixed(2)}% (${total.hit}/${total.found}), threshold ${required}%`
  );
  if (percent < required) {
    failed = true;
  }
}

if (failed) {
  console.error("Coverage threshold failed.");
  process.exit(1);
}

function addMetric(line, prefix, target, key) {
  if (!line.startsWith(prefix)) {
    return;
  }
  target[key] += Number(line.slice(prefix.length));
}

function readThreshold(envName, fallback) {
  const raw = process.env[envName];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const threshold = Number(raw);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    console.error(`${envName} must be a number from 0 to 100.`);
    process.exit(1);
  }
  return threshold;
}
