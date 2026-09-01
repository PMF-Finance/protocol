const fs = require("fs");
const path = require("path");
const { artifacts, ethers } = require("hardhat");

const CONTRACTS_ROOT = path.resolve(__dirname, "..", "..");
const MONOREPO_OUTPUT_DIR = path.resolve(
  CONTRACTS_ROOT,
  "..",
  "packages",
  "pmf-interfaces",
  "contracts"
);
const STANDALONE_OUTPUT_DIR = path.join(CONTRACTS_ROOT, "interfaces", "current");
const DEFAULT_OUTPUT_DIR = fs.existsSync(path.join(CONTRACTS_ROOT, "interfaces"))
  ? STANDALONE_OUTPUT_DIR
  : MONOREPO_OUTPUT_DIR;

const MANIFESTS = [
  {
    contractName: "PMFVault",
    interfaceVersion: "pmf-vault-v3",
    outputFile: "pmf-vault-v3.json",
    roleNames: [
      "AP_ROLE",
      "NAV_REPORTER_ROLE",
      "MANDATE_MANAGER_ROLE",
      "PAUSER_ROLE",
      "SOLVER_ROLE",
      "ORDER_COMMITTER_ROLE"
    ],
    constants: {
      firstRedemptionRequestId: 1,
      sideMasks: {
        buy: 1,
        sell: 2,
        both: 3
      },
      pricingModes: {
        snapshot: 1,
        primary: 2
      },
      residualMinPriceE18: "1000000000000000",
      maxAPSpreadBps: 300,
      maxManagementFeeBps: 500
    }
  },
  {
    contractName: "PMFBasketOracleRouter",
    interfaceVersion: "pmf-basket-oracle-router",
    outputFile: "pmf-basket-oracle-router.json",
    roleNames: ["ROUTER_ADMIN_ROLE", "PAUSER_ROLE"],
    constants: {
      replacementDelaySeconds: 86400,
      maxRoutedConstituents: 50
    }
  },
  {
    contractName: "PMFPricingRouter",
    interfaceVersion: "pmf-pricing-router",
    outputFile: "pmf-pricing-router.json",
    roleNames: ["ROUTER_ADMIN_ROLE", "PAUSER_ROLE"],
    constants: {
      replacementDelaySeconds: 86400,
      pricingModes: {
        snapshot: 1,
        primary: 2
      }
    }
  }
];

function roleMap(roleNames) {
  return Object.fromEntries([
    ["DEFAULT_ADMIN_ROLE", ethers.ZeroHash],
    ...roleNames.map((name) => [name, ethers.id(name)])
  ]);
}

function namesByType(abi, type) {
  return abi
    .filter((fragment) => fragment.type === type)
    .map((fragment) => fragment.name)
    .sort();
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!options.check) {
    fs.mkdirSync(options.outputDir, { recursive: true });
  }
  const outputs = [];
  for (const spec of MANIFESTS) {
    const artifact = await artifacts.readArtifact(spec.contractName);
    const manifest = {
      manifestSchemaVersion: "pmf.contract_interface_manifest.v1",
      contractName: spec.contractName,
      interfaceVersion: spec.interfaceVersion,
      sourceName: artifact.sourceName,
      abi: artifact.abi,
      roles: roleMap(spec.roleNames),
      eventNames: namesByType(artifact.abi, "event"),
      errorNames: namesByType(artifact.abi, "error"),
      functionNames: namesByType(artifact.abi, "function"),
      constants: spec.constants
    };
    const outputPath = path.join(options.outputDir, spec.outputFile);
    const rendered = `${JSON.stringify(manifest, null, 2)}\n`;
    if (options.check) {
      if (!fs.existsSync(outputPath)) {
        throw new Error(`interface manifest is missing: ${outputPath}`);
      }
      if (fs.readFileSync(outputPath, "utf8") !== rendered) {
        throw new Error(`interface manifest is stale: ${outputPath}`);
      }
    } else {
      fs.writeFileSync(outputPath, rendered);
    }
    outputs.push({
      output: outputPath,
      contractName: spec.contractName,
      status: options.check ? "current" : "written",
    });
  }
  console.log(JSON.stringify({ outputs }, null, 2));
}

function parseArgs(argv) {
  const options = {
    outputDir: path.resolve(process.env.PMF_INTERFACE_OUTPUT_DIR || DEFAULT_OUTPUT_DIR),
    check: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--out") {
      index += 1;
      if (!argv[index]) {
        throw new Error("--out requires a directory");
      }
      options.outputDir = path.resolve(argv[index]);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
