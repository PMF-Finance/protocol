#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const FIXTURES_ROOT = path.join(ROOT, "fixtures", "pmvs-extensions");
const ALLOWED_CASES = new Set(["positive", "boundary", "negative"]);
const ALLOWED_RESULTS = new Set(["accept", "reject"]);

function main() {
  const files = fs.readdirSync(FIXTURES_ROOT)
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new Error("no PMVS extension fixtures found");

  const ids = new Set();
  const counts = { positive: 0, boundary: 0, negative: 0 };
  for (const file of files) {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_ROOT, file), "utf8"));
    requireString(fixture, "id", file);
    requireString(fixture, "profileId", file);
    requireString(fixture, "case", file);
    if (!fixture.input || typeof fixture.input !== "object" || Array.isArray(fixture.input)) {
      throw new Error(`${file}: input must be an object`);
    }
    if (!fixture.expected || typeof fixture.expected !== "object" || Array.isArray(fixture.expected)) {
      throw new Error(`${file}: expected must be an object`);
    }
    requireString(fixture.expected, "result", `${file}.expected`);
    if (ids.has(fixture.id)) throw new Error(`${file}: duplicate id ${fixture.id}`);
    if (!fixture.profileId.startsWith("pmf/")) throw new Error(`${file}: profileId must use the pmf/ prefix`);
    if (!ALLOWED_CASES.has(fixture.case)) throw new Error(`${file}: unsupported case ${fixture.case}`);
    if (!ALLOWED_RESULTS.has(fixture.expected.result)) {
      throw new Error(`${file}: expected.result must be accept or reject`);
    }
    if (fixture.case === "positive" && fixture.expected.result !== "accept") {
      throw new Error(`${file}: positive cases must be accepted`);
    }
    if (fixture.case === "negative" && fixture.expected.result !== "reject") {
      throw new Error(`${file}: negative cases must be rejected`);
    }
    const evaluatedResult = evaluateFixture(fixture, file);
    if (evaluatedResult !== fixture.expected.result) {
      throw new Error(
        `${file}: evaluated ${evaluatedResult}, but expected.result is ${fixture.expected.result}`
      );
    }
    const serialized = JSON.stringify(fixture);
    if (/private.?key|seed.?phrase|mnemonic/i.test(serialized)) {
      throw new Error(`${file}: secret-bearing field name found`);
    }
    ids.add(fixture.id);
    counts[fixture.case] += 1;
  }

  for (const caseName of ALLOWED_CASES) {
    if (counts[caseName] === 0) throw new Error(`missing ${caseName} fixture`);
  }

  process.stdout.write(`${JSON.stringify({ status: "ok", fixtures: files.length, cases: counts }, null, 2)}\n`);
}

function evaluateFixture(fixture, file) {
  const input = fixture.input;
  if (fixture.profileId === "pmf/admission-ap-quote/1") {
    if (typeof input.authorized !== "boolean" || typeof input.consumed !== "boolean") {
      throw new Error(`${file}: quote authority and consumption flags must be booleans`);
    }
    if (!input.authorized || input.consumed) return "reject";
    return integer(input.observedAt, file) <= integer(input.deadline, file) ? "accept" : "reject";
  }

  if (fixture.profileId === "pmf/execution-intents/1") {
    if (typeof input.solverAuthorized !== "boolean" || typeof input.expired !== "boolean") {
      throw new Error(`${file}: solver authority and expiry flags must be booleans`);
    }
    if (!input.solverAuthorized || input.expired) return "reject";
    const remaining = integer(input.remainingAssetAmount, file);
    const fill = integer(input.fillAssetAmount, file);
    if (fill === 0n || fill > remaining) return "reject";
    const counter = integer(input.fillCounterAssetAmount, file);
    if (input.direction === "buy") {
      const maximum = integer(input.maximumCounterAssetAmount, file);
      return counter * remaining <= maximum * fill ? "accept" : "reject";
    }
    if (input.direction === "sell") {
      const minimum = integer(input.minimumCounterAssetAmount, file);
      return counter * remaining >= minimum * fill ? "accept" : "reject";
    }
    throw new Error(`${file}: unsupported intent direction ${input.direction}`);
  }

  if (fixture.profileId === "pmf/settlement-fifo-liability/1") {
    if (input.proposedBuyAllocation !== undefined) {
      const cash = integer(input.settlementCash, file);
      const allocation = integer(input.proposedBuyAllocation, file);
      const reserve = integer(input.requiredReserve, file);
      return allocation <= cash && cash - allocation >= reserve ? "accept" : "reject";
    }
    const original = integer(input.originalAmount, file);
    const paid = integer(input.paidAmountBefore, file);
    const payment = integer(input.paymentAmount, file);
    const liquidity = integer(input.availableSettlementLiquidity, file);
    const queuePosition = integer(input.queuePosition, file);
    if (paid > original || payment === 0n || queuePosition !== 0n) return "reject";
    return payment <= original - paid && payment <= liquidity ? "accept" : "reject";
  }

  throw new Error(`${file}: no evaluator for profile ${fixture.profileId}`);
}

function integer(value, file) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${file}: expected an unsigned base-10 integer string, got ${value}`);
  }
  return BigInt(value);
}

function requireString(object, key, context) {
  if (typeof object[key] !== "string" || object[key].length === 0) {
    throw new Error(`${context}: ${key} must be a non-empty string`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
