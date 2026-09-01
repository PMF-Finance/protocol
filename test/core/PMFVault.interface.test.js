const { expect } = require("chai");
const { artifacts, ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

describe("PMFVault interface manifest", function () {
  it("exports the clean vault ABI, roles, events, errors, and constants for off-chain clients", async function () {
    const manifestCandidates = interfaceManifestCandidates("pmf-vault-v3.json");
    const manifestPath = manifestCandidates.find((candidate) => fs.existsSync(candidate));
    expect(manifestPath, "PMFVault interface manifest path").to.be.a("string");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const artifact = await artifacts.readArtifact("PMFVault");

    expect(manifest.manifestSchemaVersion).to.equal("pmf.contract_interface_manifest.v1");
    expect(manifest.contractName).to.equal("PMFVault");
    expect(manifest.interfaceVersion).to.equal("pmf-vault-v3");
    expect(manifest.abi).to.deep.equal(artifact.abi);
    expect(manifest.roles.DEFAULT_ADMIN_ROLE).to.equal(ethers.ZeroHash);
    expect(manifest.roles.AP_ROLE).to.equal(ethers.id("AP_ROLE"));
    expect(manifest.roles.NAV_REPORTER_ROLE).to.equal(ethers.id("NAV_REPORTER_ROLE"));
    expect(manifest.roles.MANDATE_MANAGER_ROLE).to.equal(ethers.id("MANDATE_MANAGER_ROLE"));
    expect(manifest.roles.PAUSER_ROLE).to.equal(ethers.id("PAUSER_ROLE"));
    expect(manifest.roles.SOLVER_ROLE).to.equal(ethers.id("SOLVER_ROLE"));
    expect(manifest.roles.ORDER_COMMITTER_ROLE).to.equal(ethers.id("ORDER_COMMITTER_ROLE"));
    expect(manifest.functionNames).to.include.members([
      "activeOrderIntentBatch",
      "accrueManagementFee",
      "apFeeRecipient",
      "beginWindDown",
      "commitOrderIntentBatchFor",
      "commitResidualLiquidationBatch",
      "deposit",
      "depositWithAPQuote",
      "fulfillBuyIntent",
      "fulfillResidualSellIntent",
      "fulfillSellIntent",
      "latestTradingAssetsReport",
      "latestOrderIntentCount",
      "latestOrderIntentHash",
      "mint",
      "pendingRedemptionAssets",
      "pendingManagementFeeShares",
      "processRedemptions",
      "requestRedeemWithAPQuote",
      "redeem",
      "redemptionRequest",
      "setMyFeeRecipient",
      "registerResidualToken",
      "resetIgnoredResidualToken",
      "unallocatedCapital",
      "withdraw",
      "orderMandate",
      "solverOrderIntents",
      "markedDownExternalAssets",
      "setManagementFee",
      "usedAPQuoteIds",
      "usedAPQuoteNonces",
      "windDownStarted"
    ]);
    expect(manifest.eventNames).to.include.members([
      "APQuoteDeposit",
      "APQuoteRedeemRequest",
      "APFeePaid",
      "APFeeRecipientUpdated",
      "Deposit",
      "Withdraw",
      "RedeemRequest",
      "RedemptionQueued",
      "RedemptionPaid",
      "RedemptionCompleted",
      "ManagementFeeAccrued",
      "ManagementFeeUpdated",
      "OrderIntentBatchCommitted",
      "OrderMandateUpdated",
      "ResidualInventoryClosed",
      "ResidualInventoryIgnored",
      "ResidualLiquidationBatchCommitted",
      "ResidualSellIntentCommitted",
      "ResidualSellIntentFulfilled",
      "ResidualTokenTracked",
      "SolverOrderIntentCommitted",
      "SolverOrderIntentFulfilled",
      "FundClosed",
      "NonPUSDAssetsMarkedDown",
      "WindDownStarted"
    ]);
    expect(manifest.errorNames).to.include.members([
      "APQuoteAlreadyUsed",
      "APQuoteIdAlreadyUsed",
      "APQuoteNonceAlreadyUsed",
      "ExpiredAPQuote",
      "FundAlreadyClosed",
      "FundWindDownActive",
      "FundWindDownAlreadyStarted",
      "FundWindDownNotStarted",
      "InvalidIntentBatch",
      "IntentOverfill",
      "NoOrderIntents",
      "PriceBoundViolation",
      "ResidualIntentExpired",
      "ResidualIntentOverfill",
      "ResidualPriceTooLow",
      "ResidualTokenUnknown",
      "StaleBasketSource",
      "TooManyBasketConstituents",
      "ExcessiveAPQuoteAssets",
      "ExcessiveManagementFee",
      "UnauthorizedAPQuoteSigner",
      "UnauthorizedERC1155Transfer"
    ]);
    expect(manifest.constants.firstRedemptionRequestId).to.equal(1);
    expect(manifest.constants.sideMasks).to.deep.equal({ buy: 1, sell: 2, both: 3 });
    expect(manifest.constants.pricingModes).to.deep.equal({ snapshot: 1, primary: 2 });
    expect(manifest.constants.residualMinPriceE18).to.equal("1000000000000000");
    expect(manifest.constants.maxAPSpreadBps).to.equal(300);
    expect(manifest.constants.maxManagementFeeBps).to.equal(500);
  });

  it("exports basket and pricing router manifests", async function () {
    for (const spec of [
      ["PMFBasketOracleRouter", "pmf-basket-oracle-router.json", "pmf-basket-oracle-router"],
      ["PMFPricingRouter", "pmf-pricing-router.json", "pmf-pricing-router"]
    ]) {
      const [contractName, fileName, interfaceVersion] = spec;
      const manifestPath = interfaceManifestCandidates(fileName).find((candidate) => fs.existsSync(candidate));
      expect(manifestPath, `${fileName} manifest path`).to.be.a("string");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const artifact = await artifacts.readArtifact(contractName);
      expect(manifest.manifestSchemaVersion).to.equal("pmf.contract_interface_manifest.v1");
      expect(manifest.contractName).to.equal(contractName);
      expect(manifest.interfaceVersion).to.equal(interfaceVersion);
      expect(manifest.abi).to.deep.equal(artifact.abi);
      expect(manifest.roles.DEFAULT_ADMIN_ROLE).to.equal(ethers.ZeroHash);
      expect(manifest.roles.ROUTER_ADMIN_ROLE).to.equal(ethers.id("ROUTER_ADMIN_ROLE"));
      expect(manifest.roles.PAUSER_ROLE).to.equal(ethers.id("PAUSER_ROLE"));
      expect(manifest.constants.replacementDelaySeconds).to.equal(86400);
      if (contractName === "PMFBasketOracleRouter") {
        expect(manifest.constants.maxRoutedConstituents).to.equal(50);
      }
      expect(manifest.functionNames).to.include.members(["setSourceAllowed", "sourceAllowed"]);
    }
  });
});

function interfaceManifestCandidates(fileName) {
  return [
    path.join(__dirname, "..", "..", "..", "packages", "pmf-interfaces", "contracts", fileName),
    path.join(__dirname, "..", "..", "interfaces", "current", fileName)
  ];
}
