const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const TYPES = {
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

const describeFork = process.env.POLYGON_RPC_URL ? describe : describe.skip;
const TARGET_WEIGHT_SUM = 1000000000000000000n;

describeFork("PMFBasketOracle Polygon fork", function () {
  this.timeout(180000);

  before(async function () {
    if (network.name !== "hardhat") {
      this.skip();
    }
    const forking = { jsonRpcUrl: process.env.POLYGON_RPC_URL };
    if (process.env.POLYGON_FORK_BLOCK) {
      forking.blockNumber = Number(process.env.POLYGON_FORK_BLOCK);
    }
    await network.provider.request({
      method: "hardhat_reset",
      params: [{ forking }]
    });
  });

  it("publishes the full 19-market ELON recipe within a 50-constituent oracle and exercises registry migration", async function () {
    const [admin, signer, relayer] = await ethers.getSigners();
    const feedId = ethers.keccak256(ethers.toUtf8Bytes("PMF:stability:basket:v1"));
    const Oracle = await ethers.getContractFactory("PMFBasketOracle");
    const Registry = await ethers.getContractFactory("PMFOracleRegistry");

    const oracle = await Oracle.deploy(
      feedId,
      admin.address,
      signer.address,
      50,
      15 * 60,
      100000000000000n
    );
    await oracle.waitForDeployment();

    const registry = await Registry.deploy(admin.address);
    await registry.waitForDeployment();
    await expect(registry.setInitialFeed(feedId, await oracle.getAddress()))
      .to.emit(registry, "FeedSet")
      .withArgs(feedId, await oracle.getAddress());

    expect(await oracle.hasRole(await oracle.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
    expect(await oracle.hasRole(await oracle.REPORT_SIGNER_ROLE(), signer.address)).to.equal(true);
    expect(await oracle.hasRole(await oracle.PAUSER_ROLE(), admin.address)).to.equal(true);

    expect(await oracle.maxConstituents()).to.equal(50);
    const constituents = generatedConstituents(19);
    const header = await basketHeader(oracle, feedId, constituents, 520000n);
    const signature = await signHeader(signer, oracle, header);
    const txRequest = await oracle
      .connect(relayer)
      .submitBasket.populateTransaction(header, constituents, signature);
    const estimatedGas = await ethers.provider.estimateGas({
      ...txRequest,
      from: relayer.address
    });
    expect(estimatedGas).to.be.greaterThan(0n);
    expect(estimatedGas).to.be.lessThan(12000000n);

    await expect(oracle.connect(relayer).submitBasket(header, constituents, signature))
      .to.emit(oracle, "BasketPublished")
      .withArgs(
        feedId,
        header.roundId,
        header.asOf,
        header.validUntil,
        header.basketHash,
        header.constituentCount,
        header.levelE18,
        header.qualityStatus
      )
      .and.to.emit(oracle, "SignerRecovered")
      .withArgs(signer.address, header.roundId);

    expect((await oracle.latestBasket()).basketHash).to.equal(header.basketHash);
    expect(await oracle.getConstituentCount()).to.equal(19);
    expect(await oracle.isFresh()).to.equal(true);

    await expect(oracle.pause()).to.emit(oracle, "Paused").withArgs(admin.address);
    const pausedConstituents = generatedConstituents(2);
    const pausedHeader = await basketHeader(oracle, feedId, pausedConstituents, 520001n);
    const pausedSignature = await signHeader(signer, oracle, pausedHeader);
    await expect(
      oracle.connect(relayer).submitBasket(pausedHeader, pausedConstituents, pausedSignature)
    ).to.be.revertedWithCustomError(oracle, "EnforcedPause");
    await expect(oracle.unpause()).to.emit(oracle, "Unpaused").withArgs(admin.address);

    const replacement = await Oracle.deploy(
      feedId,
      admin.address,
      signer.address,
      50,
      15 * 60,
      100000000000000n
    );
    await replacement.waitForDeployment();

    await expect(registry.proposeFeed(feedId, await replacement.getAddress())).to.emit(
      registry,
      "FeedReplacementProposed"
    );
    await network.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await network.provider.send("evm_mine");
    await expect(registry.activateFeed(feedId))
      .to.emit(registry, "FeedReplacementActivated")
      .withArgs(feedId, await oracle.getAddress(), await replacement.getAddress());
    expect(await registry.feeds(feedId)).to.equal(await replacement.getAddress());
  });
});

function generatedConstituents(count) {
  const baseWeight = TARGET_WEIGHT_SUM / BigInt(count);
  const remainder = TARGET_WEIGHT_SUM - baseWeight * BigInt(count);
  return Array.from({ length: count }, (_, index) => ({
    tokenId: BigInt(900000000000 + index),
    conditionId: hashText(`fork-condition:${index}`),
    marketIdHash: hashText(`fork-market:${index}`),
    questionHash: hashText(`fork-question:${index}`),
    outcomeHash: hashText(`fork-outcome:${index % 3}`),
    outcomeSide: index % 3,
    weightE18: baseWeight + (index === count - 1 ? remainder : 0n),
    referencePriceE18: 100000000000000000n + BigInt(index + 1) * 1000000000000000n,
    executionCapacityE6: 5000000000n + BigInt(index),
    bestBidE18: 90000000000000000n + BigInt(index + 1) * 1000000000000000n,
    bestAskE18: 110000000000000000n + BigInt(index + 1) * 1000000000000000n,
    spreadBps: 200,
    depthBidE6: 5000000000n + BigInt(index),
    depthAskE6: 5000000000n + BigInt(index)
  }));
}

async function basketHeader(oracle, feedId, constituents, roundId) {
  const block = await ethers.provider.getBlock("latest");
  const asOf = BigInt(block.timestamp);
  for (const constituent of constituents) {
    constituent.marketDataAsOf = constituent.marketDataAsOf ?? asOf;
  }
  return {
    feedId,
    roundId,
    asOf,
    validUntil: asOf + 4n * 60n * 60n,
    runIdHash: hashText(`fork-run:${roundId}`),
    basketHash: await oracle.hashBasket(constituents),
    constituentCount: constituents.length,
    levelE18: 100000000000000000000n,
    qualityStatus: 1
  };
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
    TYPES,
    header
  );
}

function hashText(value) {
  return ethers.keccak256(ethers.toUtf8Bytes(value));
}
