const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const HEADER_TYPES = {
  BasketHeader: [
    { name: "feedId", type: "bytes32" },
    { name: "roundId", type: "uint80" },
    { name: "asOf", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "runIdHash", type: "bytes32" },
    { name: "basketHash", type: "bytes32" },
    { name: "constituentCount", type: "uint16" },
    { name: "levelE18", type: "uint256" },
    { name: "qualityStatus", type: "uint8" }
  ]
};

function hashText(value) {
  return ethers.keccak256(ethers.toUtf8Bytes(value));
}

async function signHeader(signer, oracle, header) {
  const { chainId } = await ethers.provider.getNetwork();
  return signer.signTypedData(
    {
      name: "PMF Basket Oracle",
      version: "1",
      chainId,
      verifyingContract: await oracle.getAddress()
    },
    HEADER_TYPES,
    header
  );
}

async function deployOracleFixture(label, feedId, validSeconds = 4 * 60 * 60) {
  const [admin, signer, relayer] = await ethers.getSigners();
  const Oracle = await ethers.getContractFactory("PMFBasketOracle");
  const oracle = await Oracle.deploy(feedId, admin.address, signer.address, 50, 15 * 60, 100000000000000n);
  await oracle.waitForDeployment();

  const block = await ethers.provider.getBlock("latest");
  const asOf = BigInt(block.timestamp);
  const constituents = [
    {
      tokenId: BigInt(hashText(`${label}:token`)) % 1000000n + 1n,
      conditionId: hashText(`${label}:condition`),
      marketIdHash: hashText(`${label}:market`),
      questionHash: hashText(`${label}:question`),
      outcomeHash: hashText(`${label}:outcome`),
      outcomeSide: 1,
      weightE18: 1000000000000000000n,
      referencePriceE18: 500000000000000000n,
      executionCapacityE6: 1000000000n,
      bestBidE18: 490000000000000000n,
      bestAskE18: 510000000000000000n,
      spreadBps: 200,
      depthBidE6: 1000000000n,
      depthAskE6: 1000000000n,
      marketDataAsOf: asOf
    }
  ];
  const basketHash = await oracle.hashBasket(constituents);
  const header = {
    feedId,
    roundId: BigInt(100 + Number(validSeconds)),
    asOf,
    validUntil: asOf + BigInt(validSeconds),
    runIdHash: hashText(`${label}:run`),
    basketHash,
    constituentCount: constituents.length,
    levelE18: 100000000000000000000n,
    qualityStatus: 1
  };
  await oracle.connect(relayer).submitBasket(header, constituents, await signHeader(signer, oracle, header));
  return { admin, signer, relayer, oracle, header, constituents };
}

describe("PMF routers", function () {
  it("routes basket sources through propose, delay, activate, cancel, and pause", async function () {
    const [admin, other] = await ethers.getSigners();
    const feedId = hashText("PMF:router:basket");
    const sourceA = await deployOracleFixture("source-a", feedId);
    const sourceB = await deployOracleFixture("source-b", feedId, 48 * 60 * 60);
    const wrongFeed = await deployOracleFixture("wrong-feed", hashText("PMF:router:other"));

    const BasketRouter = await ethers.getContractFactory("PMFBasketOracleRouter");
    await expect(BasketRouter.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      { interface: BasketRouter.interface },
      "InvalidSource"
    );
    const router = await BasketRouter.deploy(admin.address);
    await router.waitForDeployment();

    await expect(router.activeSource(feedId)).to.be.revertedWithCustomError(router, "NoActiveSource");
    await expect(router.sourceRevision(feedId)).to.be.revertedWithCustomError(router, "NoActiveSource");
    await expect(router.connect(admin).cancelSourceReplacement(feedId))
      .to.be.revertedWithCustomError(router, "NoPendingSource");
    await expect(router.connect(other).setSourceAllowed(feedId, await sourceA.oracle.getAddress(), true))
      .to.be.revertedWithCustomError(router, "AccessControlUnauthorizedAccount");
    await expect(router.connect(other).setInitialSource(feedId, await sourceA.oracle.getAddress()))
      .to.be.revertedWithCustomError(router, "AccessControlUnauthorizedAccount");
    await expect(router.connect(admin).setInitialSource(feedId, other.address))
      .to.be.revertedWithCustomError(router, "InvalidSource");
    await expect(router.connect(admin).setInitialSource(feedId, await sourceA.oracle.getAddress()))
      .to.be.revertedWithCustomError(router, "SourceNotAllowed");
    await expect(router.connect(admin).setSourceAllowed(feedId, await wrongFeed.oracle.getAddress(), true))
      .to.be.revertedWithCustomError(router, "SourceFeedMismatch");
    await expect(router.connect(admin).setSourceAllowed(feedId, await sourceA.oracle.getAddress(), true))
      .to.emit(router, "SourceAllowed")
      .withArgs(feedId, await sourceA.oracle.getAddress(), true);
    expect(await router.sourceAllowed(feedId, await sourceA.oracle.getAddress())).to.equal(true);

    await expect(router.connect(admin).setInitialSource(feedId, await sourceA.oracle.getAddress()))
      .to.emit(router, "SourceSet")
      .withArgs(feedId, await sourceA.oracle.getAddress(), 1);
    await expect(router.connect(admin).setInitialSource(feedId, await sourceA.oracle.getAddress()))
      .to.be.revertedWithCustomError(router, "SourceAlreadySet");
    expect(await router.activeSource(feedId)).to.equal(await sourceA.oracle.getAddress());
    expect((await router.latestBasket(feedId)).basketHash).to.equal(sourceA.header.basketHash);
    expect(await router.getConstituentCount(feedId)).to.equal(1n);
    expect((await router.getConstituent(feedId, 0)).tokenId).to.equal(sourceA.constituents[0].tokenId);
    expect(await router.isFresh(feedId)).to.equal(true);

    await expect(router.connect(admin).proposeSource(feedId, await sourceB.oracle.getAddress()))
      .to.be.revertedWithCustomError(router, "SourceNotAllowed");
    await expect(router.connect(admin).setSourceAllowed(feedId, await sourceB.oracle.getAddress(), true))
      .to.emit(router, "SourceAllowed")
      .withArgs(feedId, await sourceB.oracle.getAddress(), true);
    await expect(router.connect(admin).proposeSource(feedId, await sourceB.oracle.getAddress()))
      .to.emit(router, "SourceReplacementProposed");
    await expect(router.connect(admin).activateSource(feedId))
      .to.be.revertedWithCustomError(router, "ReplacementDelayActive");
    await expect(router.connect(admin).cancelSourceReplacement(feedId))
      .to.emit(router, "SourceReplacementCancelled")
      .withArgs(feedId, await sourceB.oracle.getAddress());
    await expect(router.connect(admin).activateSource(feedId))
      .to.be.revertedWithCustomError(router, "NoPendingSource");

    await router.connect(admin).proposeSource(feedId, await sourceB.oracle.getAddress());
    await network.provider.send("evm_increaseTime", [24 * 60 * 60]);
    await network.provider.send("evm_mine");
    await expect(router.connect(admin).activateSource(feedId))
      .to.emit(router, "SourceReplacementActivated")
      .withArgs(feedId, await sourceA.oracle.getAddress(), await sourceB.oracle.getAddress(), 2);
    expect(await router.sourceRevision(feedId)).to.equal(2n);

    await expect(router.connect(admin).pause()).to.emit(router, "Paused");
    await expect(router.latestBasket(feedId)).to.be.revertedWithCustomError(router, "EnforcedPause");
    await expect(router.connect(admin).unpause()).to.emit(router, "Unpaused");
  });

  it("rejects stale basket source activation", async function () {
    const [admin] = await ethers.getSigners();
    const feedId = hashText("PMF:router:stale");
    const sourceA = await deployOracleFixture("stale-a", feedId, 48 * 60 * 60);
    const sourceB = await deployOracleFixture("stale-b", feedId, 2);
    const BasketRouter = await ethers.getContractFactory("PMFBasketOracleRouter");
    const router = await BasketRouter.deploy(admin.address);
    await router.waitForDeployment();

    await router.connect(admin).setSourceAllowed(feedId, await sourceA.oracle.getAddress(), true);
    await router.connect(admin).setSourceAllowed(feedId, await sourceB.oracle.getAddress(), true);
    await router.connect(admin).setInitialSource(feedId, await sourceA.oracle.getAddress());
    await router.connect(admin).proposeSource(feedId, await sourceB.oracle.getAddress());
    await network.provider.send("evm_increaseTime", [24 * 60 * 60]);
    await network.provider.send("evm_mine");
    await expect(router.connect(admin).activateSource(feedId))
      .to.be.revertedWithCustomError(router, "StaleSource");
  });

  it("rejects basket sources with count mismatches or too many constituents", async function () {
    const [admin] = await ethers.getSigners();
    const feedId = hashText("PMF:router:count-bound");
    const BasketRouter = await ethers.getContractFactory("PMFBasketOracleRouter");
    const router = await BasketRouter.deploy(admin.address);
    await router.waitForDeployment();
    const MockBasketOracle = await ethers.getContractFactory("MockBasketOracle");
    const mismatch = await MockBasketOracle.deploy(feedId, 2, 1, true);
    await mismatch.waitForDeployment();
    const oversized = await MockBasketOracle.deploy(feedId, 51, 51, true);
    await oversized.waitForDeployment();

    await expect(router.connect(admin).setSourceAllowed(feedId, await mismatch.getAddress(), true))
      .to.be.revertedWithCustomError(router, "SourceConstituentCountMismatch")
      .withArgs(feedId, 2, 1);
    await expect(router.connect(admin).setSourceAllowed(feedId, await oversized.getAddress(), true))
      .to.be.revertedWithCustomError(router, "TooManyRoutedConstituents")
      .withArgs(feedId, 51, 50);
  });

  it("routes pricing sources while launch snapshot mode remains enabled", async function () {
    const [admin, other] = await ethers.getSigners();
    const feedId = hashText("PMF:router:pricing");
    const source = await deployOracleFixture("pricing-source", hashText("PMF:router:pricing:source"));
    const PricingRouter = await ethers.getContractFactory("PMFPricingRouter");
    await expect(PricingRouter.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      { interface: PricingRouter.interface },
      "InvalidPricingSource"
    );
    const router = await PricingRouter.deploy(admin.address);
    await router.waitForDeployment();

    await expect(router.activePricingSource(feedId))
      .to.be.revertedWithCustomError(router, "NoActivePricingSource");
    await expect(router.pricingSourceRevision(feedId))
      .to.be.revertedWithCustomError(router, "NoActivePricingSource");
    await expect(router.validatePricingReference(feedId, 2, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(router, "NoActivePricingSource");
    await expect(router.connect(admin).setInitialSource(ethers.ZeroHash, ethers.ZeroAddress, false))
      .to.be.revertedWithCustomError(router, "InvalidPricingSource");
    await expect(router.connect(other).setInitialSource(feedId, ethers.ZeroAddress, false))
      .to.be.revertedWithCustomError(router, "AccessControlUnauthorizedAccount");
    await expect(router.connect(admin).setInitialSource(feedId, ethers.ZeroAddress, true))
      .to.be.revertedWithCustomError(router, "InvalidPricingSource");
    await expect(router.connect(admin).setInitialSource(feedId, other.address, true))
      .to.be.revertedWithCustomError(router, "InvalidPricingSource");
    await expect(router.connect(admin).setInitialSource(feedId, await source.oracle.getAddress(), true))
      .to.be.revertedWithCustomError(router, "PricingSourceNotAllowed");
    await expect(router.connect(admin).setInitialSource(feedId, ethers.ZeroAddress, false))
      .to.emit(router, "PricingSourceSet")
      .withArgs(feedId, ethers.ZeroAddress, false, 1);
    expect(await router.activePricingSource(feedId)).to.equal(ethers.ZeroAddress);
    expect(await router.pricingSourceRevision(feedId)).to.equal(1n);
    await expect(router.connect(admin).setInitialSource(feedId, ethers.ZeroAddress, false))
      .to.be.revertedWithCustomError(router, "PricingSourceAlreadySet");

    await router.validatePricingReference(feedId, 1, ethers.ZeroAddress);
    await expect(router.validatePricingReference(feedId, 1, await source.oracle.getAddress()))
      .to.be.revertedWithCustomError(router, "PricingSourceMismatch");
    await expect(router.validatePricingReference(feedId, 2, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(router, "PricingFeedDisabled");
    await expect(router.validatePricingReference(feedId, 99, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(router, "InvalidPricingMode");

    await expect(router.connect(admin).proposeSource(feedId, await source.oracle.getAddress(), true))
      .to.be.revertedWithCustomError(router, "PricingSourceNotAllowed");
    await expect(router.connect(admin).setSourceAllowed(feedId, await source.oracle.getAddress(), true))
      .to.emit(router, "PricingSourceAllowed")
      .withArgs(feedId, await source.oracle.getAddress(), true);
    expect(await router.sourceAllowed(feedId, await source.oracle.getAddress())).to.equal(true);
    await expect(router.connect(admin).proposeSource(feedId, await source.oracle.getAddress(), true))
      .to.emit(router, "PricingSourceReplacementProposed");
    await expect(router.connect(admin).activateSource(feedId))
      .to.be.revertedWithCustomError(router, "PricingReplacementDelayActive");
    await expect(router.connect(admin).cancelSourceReplacement(feedId))
      .to.emit(router, "PricingSourceReplacementCancelled")
      .withArgs(feedId, await source.oracle.getAddress());
    await expect(router.connect(admin).activateSource(feedId))
      .to.be.revertedWithCustomError(router, "NoPendingPricingSource");

    await router.connect(admin).proposeSource(feedId, await source.oracle.getAddress(), true);
    await network.provider.send("evm_increaseTime", [24 * 60 * 60]);
    await network.provider.send("evm_mine");
    await expect(router.connect(admin).activateSource(feedId))
      .to.emit(router, "PricingSourceReplacementActivated")
      .withArgs(feedId, ethers.ZeroAddress, await source.oracle.getAddress(), true, 2);
    expect(await router.primaryEnabled(feedId)).to.equal(true);
    await router.validatePricingReference(feedId, 2, await source.oracle.getAddress());
    await expect(router.validatePricingReference(feedId, 2, admin.address))
      .to.be.revertedWithCustomError(router, "PricingSourceMismatch");

    await expect(router.connect(admin).setPrimaryEnabled(feedId, false))
      .to.emit(router, "PricingSourceEnabled")
      .withArgs(feedId, await source.oracle.getAddress(), false, 3);
    await expect(router.validatePricingReference(feedId, 2, await source.oracle.getAddress()))
      .to.be.revertedWithCustomError(router, "PricingFeedDisabled");

    await expect(router.connect(admin).pause()).to.emit(router, "Paused");
    await expect(router.validatePricingReference(feedId, 1, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(router, "EnforcedPause");
    await expect(router.connect(admin).unpause()).to.emit(router, "Unpaused");
  });
});
