require("@nomicfoundation/hardhat-toolbox");
require("solidity-coverage");

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
    hardhat: {}
  }
};
