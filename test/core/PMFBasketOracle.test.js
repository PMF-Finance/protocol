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

describe("PMFBasketOracle", function () {
  async function deployOracle() {
    const [admin, signer, relayer, other] = await ethers.getSigners();
    const feedId = ethers.keccak256(ethers.toUtf8Bytes("PMF:example:basket:v1"));
    const Oracle = await ethers.getContractFactory("PMFBasketOracle");
    const oracle = await Oracle.deploy(
      feedId,
      admin.address,
      signer.address,
      50,
      15 * 60,
      100000000000000n
    );
    await oracle.waitForDeployment();
    return { admin, signer, relayer, other, oracle, feedId };
  }

  it("rejects invalid constructor arguments", async function () {
    const [admin, signer] = await ethers.getSigners();
    const feedId = ethers.keccak256(ethers.toUtf8Bytes("PMF:example:basket:v1"));
    const Oracle = await ethers.getContractFactory("PMFBasketOracle");

    await expect(
      Oracle.deploy(ethers.ZeroHash, admin.address, signer.address, 50, 15 * 60, 100000000000000n)
    ).to.be.revertedWithCustomError(Oracle, "InvalidHeader");
    await expect(
      Oracle.deploy(feedId, admin.address, signer.address, 0, 15 * 60, 100000000000000n)
    ).to.be.revertedWithCustomError(Oracle, "TooManyConstituents");
  });

  async function basketFixture(overrides = {}) {
    const context = await deployOracle();
    const block = await ethers.provider.getBlock("latest");
    const asOf = BigInt(block.timestamp);
    const constituents = overrides.constituents !== undefined ? overrides.constituents : [
      {
        tokenId: 1001n,
        conditionId: ethers.keccak256(ethers.toUtf8Bytes("condition-a")),
        marketIdHash: ethers.keccak256(ethers.toUtf8Bytes("market-a")),
        questionHash: ethers.keccak256(ethers.toUtf8Bytes("question-a")),
        outcomeHash: ethers.keccak256(ethers.toUtf8Bytes("Yes")),
        outcomeSide: 1,
        weightE18: 600000000000000000n,
        referencePriceE18: 550000000000000000n,
        executionCapacityE6: 8000000000n,
        bestBidE18: 540000000000000000n,
        bestAskE18: 560000000000000000n,
        spreadBps: 200,
        depthBidE6: 8000000000n,
        depthAskE6: 8000000000n,
        marketDataAsOf: asOf
      },
      {
        tokenId: 1002n,
        conditionId: ethers.keccak256(ethers.toUtf8Bytes("condition-b")),
        marketIdHash: ethers.keccak256(ethers.toUtf8Bytes("market-b")),
        questionHash: ethers.keccak256(ethers.toUtf8Bytes("question-b")),
        outcomeHash: ethers.keccak256(ethers.toUtf8Bytes("No")),
        outcomeSide: 2,
        weightE18: 400000000000000000n,
        referencePriceE18: 300000000000000000n,
        executionCapacityE6: 4000000000n,
        bestBidE18: 290000000000000000n,
        bestAskE18: 310000000000000000n,
        spreadBps: 200,
        depthBidE6: 4000000000n,
        depthAskE6: 4000000000n,
        marketDataAsOf: asOf
      }
    ];
    const basketHash = await context.oracle.hashBasket(constituents);
    const header = {
      feedId: context.feedId,
      roundId: overrides.roundId || 490000n,
      asOf: overrides.asOf || asOf,
      validUntil: overrides.validUntil || asOf + 4n * 60n * 60n,
      runIdHash: ethers.keccak256(ethers.toUtf8Bytes("run-1")),
      basketHash,
      constituentCount: constituents.length,
      levelE18: 101250000000000000000n,
      qualityStatus: 1
    };
    const signature = await signHeader(context.signer, context.oracle, header);
    return { ...context, header, constituents, signature };
  }

  it("publishes a signed basket and exposes latest data", async function () {
    const { oracle, relayer, header, constituents, signature, feedId } = await basketFixture();

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
      );

    const latest = await oracle.latestBasket();
    expect(latest.roundId).to.equal(header.roundId);
    expect(await oracle.getConstituentCount()).to.equal(2);
    expect((await oracle.getConstituent(0)).tokenId).to.equal(1001n);
    expect(await oracle.isFresh()).to.equal(true);
  });

  it("accepts a payoff-weighted inverse basket shape", async function () {
    const block = await ethers.provider.getBlock("latest");
    const asOf = BigInt(block.timestamp);
    const fixture = await basketFixture({
      constituents: [
        {
          tokenId: 1002n,
          conditionId: ethers.keccak256(ethers.toUtf8Bytes("condition-a")),
          marketIdHash: ethers.keccak256(ethers.toUtf8Bytes("market-a")),
          questionHash: ethers.keccak256(ethers.toUtf8Bytes("question-a")),
          outcomeHash: ethers.keccak256(ethers.toUtf8Bytes("No")),
          outcomeSide: 2,
          weightE18: 400000000000000000n,
          referencePriceE18: 500000000000000000n,
          executionCapacityE6: 8000000000n,
          bestBidE18: 490000000000000000n,
          bestAskE18: 510000000000000000n,
          spreadBps: 200,
          depthBidE6: 8000000000n,
          depthAskE6: 8000000000n,
          marketDataAsOf: asOf
        },
        {
          tokenId: 2002n,
          conditionId: ethers.keccak256(ethers.toUtf8Bytes("condition-b")),
          marketIdHash: ethers.keccak256(ethers.toUtf8Bytes("market-b")),
          questionHash: ethers.keccak256(ethers.toUtf8Bytes("question-b")),
          outcomeHash: ethers.keccak256(ethers.toUtf8Bytes("No")),
          outcomeSide: 2,
          weightE18: 600000000000000000n,
          referencePriceE18: 750000000000000000n,
          executionCapacityE6: 4000000000n,
          bestBidE18: 740000000000000000n,
          bestAskE18: 760000000000000000n,
          spreadBps: 200,
          depthBidE6: 4000000000n,
          depthAskE6: 4000000000n,
          marketDataAsOf: asOf
        }
      ]
    });

    await fixture.oracle
      .connect(fixture.relayer)
      .submitBasket(fixture.header, fixture.constituents, fixture.signature);

    const latest = await fixture.oracle.latestBasket();
    const first = await fixture.oracle.getConstituent(0);
    const second = await fixture.oracle.getConstituent(1);
    expect(latest.basketHash).to.equal(fixture.header.basketHash);
    expect(first.tokenId).to.equal(1002n);
    expect(second.tokenId).to.equal(2002n);
    expect(first.weightE18 + second.weightE18).to.equal(1000000000000000000n);
    expect(await fixture.oracle.isFresh()).to.equal(true);
  });

  it("accepts a paired-share basket shape", async function () {
    const block = await ethers.provider.getBlock("latest");
    const asOf = BigInt(block.timestamp);
    const fixture = await basketFixture({
      constituents: [
        {
          tokenId: 1001n,
          conditionId: ethers.keccak256(ethers.toUtf8Bytes("condition-a")),
          marketIdHash: ethers.keccak256(ethers.toUtf8Bytes("market-a")),
          questionHash: ethers.keccak256(ethers.toUtf8Bytes("question-a")),
          outcomeHash: ethers.keccak256(ethers.toUtf8Bytes("Yes")),
          outcomeSide: 1,
          weightE18: 800000000000000000n,
          referencePriceE18: 800000000000000000n,
          executionCapacityE6: 1000000000n,
          bestBidE18: 790000000000000000n,
          bestAskE18: 810000000000000000n,
          spreadBps: 200,
          depthBidE6: 1000000000n,
          depthAskE6: 1000000000n,
          marketDataAsOf: asOf
        },
        {
          tokenId: 2001n,
          conditionId: ethers.keccak256(ethers.toUtf8Bytes("condition-b")),
          marketIdHash: ethers.keccak256(ethers.toUtf8Bytes("market-b")),
          questionHash: ethers.keccak256(ethers.toUtf8Bytes("question-b")),
          outcomeHash: ethers.keccak256(ethers.toUtf8Bytes("Yes")),
          outcomeSide: 1,
          weightE18: 200000000000000000n,
          referencePriceE18: 200000000000000000n,
          executionCapacityE6: 1000000000n,
          bestBidE18: 190000000000000000n,
          bestAskE18: 210000000000000000n,
          spreadBps: 200,
          depthBidE6: 1000000000n,
          depthAskE6: 1000000000n,
          marketDataAsOf: asOf
        }
      ]
    });

    await fixture.oracle
      .connect(fixture.relayer)
      .submitBasket(fixture.header, fixture.constituents, fixture.signature);

    const first = await fixture.oracle.getConstituent(0);
    const second = await fixture.oracle.getConstituent(1);
    expect(first.weightE18).to.equal(800000000000000000n);
    expect(second.weightE18).to.equal(200000000000000000n);
    expect(first.weightE18 + second.weightE18).to.equal(1000000000000000000n);
    expect(await fixture.oracle.isFresh()).to.equal(true);
  });

  it("rejects an unauthorized signer", async function () {
    const fixture = await basketFixture();
    const signature = await signHeader(fixture.other, fixture.oracle, fixture.header);

    await expect(
      fixture.oracle.connect(fixture.relayer).submitBasket(fixture.header, fixture.constituents, signature)
    ).to.be.revertedWithCustomError(fixture.oracle, "UnauthorizedSigner");
  });

  it("rejects feed id mismatches", async function () {
    const fixture = await basketFixture();
    fixture.header.feedId = ethers.keccak256(ethers.toUtf8Bytes("wrong-feed"));
    const signature = await signHeader(fixture.signer, fixture.oracle, fixture.header);

    await expect(
      fixture.oracle.connect(fixture.relayer).submitBasket(fixture.header, fixture.constituents, signature)
    ).to.be.revertedWithCustomError(fixture.oracle, "FeedIdMismatch");
  });

  it("rejects invalid headers and empty constituent sets", async function () {
    const invalidHeader = await basketFixture();
    invalidHeader.header.qualityStatus = 0;
    const invalidSignature = await signHeader(
      invalidHeader.signer,
      invalidHeader.oracle,
      invalidHeader.header
    );

    await expect(
      invalidHeader.oracle
        .connect(invalidHeader.relayer)
        .submitBasket(invalidHeader.header, invalidHeader.constituents, invalidSignature)
    ).to.be.revertedWithCustomError(invalidHeader.oracle, "InvalidHeader");

    const empty = await basketFixture({ constituents: [] });
    await expect(
      empty.oracle.connect(empty.relayer).submitBasket(empty.header, empty.constituents, empty.signature)
    ).to.be.revertedWithCustomError(empty.oracle, "EmptyConstituentSet");
  });

  it("rejects duplicate token ids", async function () {
    const duplicate = await basketFixture();
    duplicate.constituents[1] = { ...duplicate.constituents[1], tokenId: duplicate.constituents[0].tokenId };
    duplicate.header.basketHash = await duplicate.oracle.hashBasket(duplicate.constituents);
    const signature = await signHeader(duplicate.signer, duplicate.oracle, duplicate.header);

    await expect(
      duplicate.oracle.connect(duplicate.relayer).submitBasket(duplicate.header, duplicate.constituents, signature)
    ).to.be.revertedWithCustomError(duplicate.oracle, "DuplicateToken");
  });

  it("rejects bad weight sums", async function () {
    const fixture = await basketFixture();
    fixture.constituents[1] = { ...fixture.constituents[1], weightE18: 300000000000000000n };
    fixture.header.basketHash = await fixture.oracle.hashBasket(fixture.constituents);
    const signature = await signHeader(fixture.signer, fixture.oracle, fixture.header);

    await expect(
      fixture.oracle.connect(fixture.relayer).submitBasket(fixture.header, fixture.constituents, signature)
    ).to.be.revertedWithCustomError(fixture.oracle, "BadWeightSum");
  });

  it("rejects stale baskets", async function () {
    const block = await ethers.provider.getBlock("latest");
    const fixture = await basketFixture({
      asOf: BigInt(block.timestamp - 10_000),
      validUntil: BigInt(block.timestamp - 1)
    });

    await expect(
      fixture.oracle.connect(fixture.relayer).submitBasket(fixture.header, fixture.constituents, fixture.signature)
    ).to.be.revertedWithCustomError(fixture.oracle, "StaleBasket");
  });

  it("rejects submissions while paused", async function () {
    const fixture = await basketFixture();
    await fixture.oracle.connect(fixture.admin).pause();

    await expect(
      fixture.oracle.connect(fixture.relayer).submitBasket(fixture.header, fixture.constituents, fixture.signature)
    ).to.be.revertedWithCustomError(fixture.oracle, "EnforcedPause");

    await expect(fixture.oracle.connect(fixture.admin).unpause())
      .to.emit(fixture.oracle, "Unpaused")
      .withArgs(fixture.admin.address);
  });
});

describe("PMFOracleRegistry", function () {
  it("rejects a zero admin", async function () {
    const Registry = await ethers.getContractFactory("PMFOracleRegistry");

    await expect(Registry.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      Registry,
      "InvalidFeed"
    );
  });

  it("delays feed replacement", async function () {
    const [admin, feedA, feedB] = await ethers.getSigners();
    const feedId = ethers.keccak256(ethers.toUtf8Bytes("PMF:example:basket:v1"));
    const Registry = await ethers.getContractFactory("PMFOracleRegistry");
    const registry = await Registry.deploy(admin.address);
    await registry.waitForDeployment();

    await registry.setInitialFeed(feedId, feedA.address);
    await registry.proposeFeed(feedId, feedB.address);
    await expect(registry.activateFeed(feedId)).to.be.revertedWithCustomError(registry, "ReplacementDelayActive");

    await network.provider.send("evm_increaseTime", [24 * 60 * 60]);
    await network.provider.send("evm_mine");
    await registry.activateFeed(feedId);
    expect(await registry.feeds(feedId)).to.equal(feedB.address);
  });

  it("rejects invalid registry writes and supports cancellation", async function () {
    const [admin, feedA, feedB] = await ethers.getSigners();
    const feedId = ethers.keccak256(ethers.toUtf8Bytes("PMF:example:basket:v1"));
    const missingFeedId = ethers.keccak256(ethers.toUtf8Bytes("PMF:missing:basket:v1"));
    const Registry = await ethers.getContractFactory("PMFOracleRegistry");
    const registry = await Registry.deploy(admin.address);
    await registry.waitForDeployment();

    await expect(registry.setInitialFeed(ethers.ZeroHash, feedA.address)).to.be.revertedWithCustomError(
      registry,
      "InvalidFeed"
    );
    await expect(registry.setInitialFeed(feedId, ethers.ZeroAddress)).to.be.revertedWithCustomError(
      registry,
      "InvalidFeed"
    );
    await registry.setInitialFeed(feedId, feedA.address);
    await expect(registry.setInitialFeed(feedId, feedB.address)).to.be.revertedWithCustomError(
      registry,
      "FeedAlreadySet"
    );
    await expect(registry.proposeFeed(ethers.ZeroHash, feedB.address)).to.be.revertedWithCustomError(
      registry,
      "InvalidFeed"
    );
    await expect(registry.activateFeed(missingFeedId)).to.be.revertedWithCustomError(
      registry,
      "NoPendingFeed"
    );
    await expect(registry.cancelFeedReplacement(missingFeedId)).to.be.revertedWithCustomError(
      registry,
      "NoPendingFeed"
    );

    await registry.proposeFeed(feedId, feedB.address);
    await expect(registry.cancelFeedReplacement(feedId))
      .to.emit(registry, "FeedReplacementCancelled")
      .withArgs(feedId, feedB.address);
    expect((await registry.pendingFeeds(feedId)).feed).to.equal(ethers.ZeroAddress);
  });
});

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
