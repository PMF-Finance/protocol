require("@nomicfoundation/hardhat-toolbox");
require("solidity-coverage");
const fs = require("fs");
const path = require("path");

function loadEnvFile(filePath) {
  if (!filePath) {
    return;
  }
  const resolvedPath = resolveEnvFilePath(filePath);
  const text = fs.readFileSync(resolvedPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const delimiter = line.indexOf("=");
    if (delimiter <= 0) {
      continue;
    }
    const key = line.slice(0, delimiter).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) {
      continue;
    }
    let value = line.slice(delimiter + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function resolveEnvFilePath(filePath) {
  if (path.isAbsolute(filePath) || fs.existsSync(filePath)) {
    return filePath;
  }
  for (const candidate of [path.join(__dirname, filePath), path.join(__dirname, "..", filePath)]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return filePath;
}

loadEnvFile(process.env.CONTRACTS_DEPLOY_ENV_FILE);

const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || "https://polygon.drpc.org/";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || process.env.POLYGONSCAN_API_KEY || "";
const RAW_DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";
const DEPLOYER_PRIVATE_KEY = /^[0-9a-fA-F]{64}$/.test(RAW_DEPLOYER_PRIVATE_KEY)
  ? `0x${RAW_DEPLOYER_PRIVATE_KEY}`
  : RAW_DEPLOYER_PRIVATE_KEY;

/** @type import("hardhat/config").HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      viaIR: true,
      metadata: {
        bytecodeHash: "none"
      },
      optimizer: {
        enabled: true,
        runs: 0
      }
    }
  },
  networks: {
    hardhat: {},
    polygon: {
      url: POLYGON_RPC_URL,
      chainId: 137,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : []
    },
    elonFork: {
      url: process.env.ELON_REDEPLOYMENT_FORK_RPC_URL || "http://127.0.0.1:8547",
      chainId: 137
    }
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY
  },
  sourcify: {
    enabled: true
  }
};
