const { expect } = require("chai");
const { ethers } = require("hardhat");

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

const TARGET_WEIGHT_SUM = 1000000000000000000n;

describe("PMFBasketOracle property checks", function () {
  async function deployOracle() {
    const [admin, signer, relayer] = await ethers.getSigners();
    const feedId = ethers.keccak256(ethers.toUtf8Bytes("PMF:stability:basket:v1"));
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
    return { admin, signer, relayer, oracle, feedId };
  }

  function generatedConstituents(count, seed = 0) {
    const baseWeight = TARGET_WEIGHT_SUM / BigInt(count);
    let remainder = TARGET_WEIGHT_SUM - baseWeight * BigInt(count);
    return Array.from({ length: count }, (_, index) => {
      const extraWeight = index === count - 1 ? remainder : 0n;
      const weightE18 = baseWeight + extraWeight;
      remainder -= extraWeight;
      return {
        tokenId: BigInt(100000 + seed * 1000 + index),
        conditionId: hashText(`condition:${seed}:${index}`),
        marketIdHash: hashText(`market:${seed}:${index}`),
        questionHash: hashText(`question:${seed}:${index}`),
        outcomeHash: hashText(`outcome:${seed}:${index % 3}`),
        outcomeSide: index % 3,
        weightE18,
        referencePriceE18: 100000000000000000n + BigInt(index + 1) * 1000000000000000n,
        executionCapacityE6: 1000000n + BigInt(seed + index + 1),
        bestBidE18: 90000000000000000n + BigInt(index + 1) * 1000000000000000n,
        bestAskE18: 110000000000000000n + BigInt(index + 1) * 1000000000000000n,
        spreadBps: 200,
        depthBidE6: 1000000n + BigInt(seed + index + 1),
        depthAskE6: 1000000n + BigInt(seed + index + 1)
      };
    });
  }

  function hashText(value) {
    return ethers.keccak256(ethers.toUtf8Bytes(value));
  }

  function cloneConstituents(constituents) {
    return constituents.map((item) => ({ ...item }));
  }

  async function signedBasket(context, constituents, overrides = {}) {
    const block = await ethers.provider.getBlock("latest");
    const asOf = overrides.asOf ?? BigInt(block.timestamp);
    const normalizedConstituents = constituents.map((item) => ({
      ...item,
      marketDataAsOf: item.marketDataAsOf ?? asOf
    }));
    const basketHash = overrides.basketHash ?? (await context.oracle.hashBasket(normalizedConstituents));
    const header = {
      feedId: overrides.feedId ?? context.feedId,
      roundId: overrides.roundId ?? 1n,
      asOf,
      validUntil: overrides.validUntil ?? asOf + 4n * 60n * 60n,
      runIdHash: overrides.runIdHash ?? hashText(`run:${overrides.roundId ?? 1n}`),
      basketHash,
      constituentCount: overrides.constituentCount ?? constituents.length,
      levelE18: overrides.levelE18 ?? 100000000000000000000n,
      qualityStatus: overrides.qualityStatus ?? 1
    };
    const signature = await signHeader(context.signer, context.oracle, header);
    return { header, constituents: normalizedConstituents, signature };
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

  it("accepts generated valid baskets and preserves invariants", async function () {
    const context = await deployOracle();
    const counts = [1, 2, 3, 5, 8, 13, 21, 34, 50];

    for (let index = 0; index < counts.length; index++) {
      const constituents = generatedConstituents(counts[index], index + 1);
      const basket = await signedBasket(context, constituents, {
        roundId: BigInt(490000 + index)
      });

      await expect(
        context.oracle
          .connect(context.relayer)
          .submitBasket(basket.header, basket.constituents, basket.signature)
      )
        .to.emit(context.oracle, "BasketPublished")
        .withArgs(
          context.feedId,
          basket.header.roundId,
          basket.header.asOf,
          basket.header.validUntil,
          basket.header.basketHash,
          basket.header.constituentCount,
          basket.header.levelE18,
          basket.header.qualityStatus
        );

      const latest = await context.oracle.latestBasket();
      expect(latest.roundId).to.equal(basket.header.roundId);
      expect(latest.basketHash).to.equal(basket.header.basketHash);
      expect(await context.oracle.getConstituentCount()).to.equal(counts[index]);
      expect(await context.oracle.isFresh()).to.equal(true);

      let weightSum = 0n;
      const tokens = new Set();
      for (let constituentIndex = 0; constituentIndex < counts[index]; constituentIndex++) {
        const constituent = await context.oracle.getConstituent(constituentIndex);
        expect(tokens.has(constituent.tokenId.toString())).to.equal(false);
        tokens.add(constituent.tokenId.toString());
        weightSum += constituent.weightE18;
      }
      expect(weightSum).to.equal(TARGET_WEIGHT_SUM);
    }
  });

  it("rejects generated malformed baskets at boundary fields", async function () {
    const cases = [
      {
        name: "zero token",
        mutate: (items) => {
          items[0].tokenId = 0n;
        },
        error: "InvalidConstituent"
      },
      {
        name: "duplicate token",
        mutate: (items) => {
          items[2].tokenId = items[0].tokenId;
        },
        error: "DuplicateToken"
      },
      {
        name: "bad outcome side",
        mutate: (items) => {
          items[1].outcomeSide = 3;
        },
        error: "InvalidConstituent"
      },
      {
        name: "ask below bid",
        mutate: (items) => {
          items[1].bestAskE18 = items[1].bestBidE18 - 1n;
        },
        error: "InvalidMarketData"
      },
      {
        name: "zero bid",
        mutate: (items) => {
          items[1].bestBidE18 = 0n;
        },
        error: "InvalidMarketData"
      },
      {
        name: "stale market data timestamp",
        mutate: (items) => {
          items[1].marketDataAsOf = 1n;
        },
        error: "InvalidMarketData"
      },
      {
        name: "spread too wide",
        mutate: (items) => {
          items[1].spreadBps = 10001;
        },
        error: "InvalidMarketData"
      },
      {
        name: "zero depth",
        mutate: (items) => {
          items[1].depthAskE6 = 0n;
        },
        error: "InvalidMarketData"
      },
      {
        name: "bad weight sum",
        mutate: (items) => {
          items[0].weightE18 += 200000000000000n;
        },
        error: "BadWeightSum"
      }
    ];

    for (const testCase of cases) {
      const context = await deployOracle();
      const constituents = cloneConstituents(generatedConstituents(4, 99));
      testCase.mutate(constituents);
      const basket = await signedBasket(context, constituents, { roundId: 490100n });

      await expect(
        context.oracle
          .connect(context.relayer)
          .submitBasket(basket.header, basket.constituents, basket.signature),
        testCase.name
      ).to.be.revertedWithCustomError(context.oracle, testCase.error);
    }
  });

  it("rejects count, timestamp, and hash boundary violations", async function () {
    const context = await deployOracle();
    const constituents = generatedConstituents(3, 7);
    const valid = await signedBasket(context, constituents, { roundId: 490200n });
    await context.oracle
      .connect(context.relayer)
      .submitBasket(valid.header, valid.constituents, valid.signature);

    const nonMonotonic = await signedBasket(context, generatedConstituents(3, 8), {
      roundId: 490200n
    });
    await expect(
      context.oracle
        .connect(context.relayer)
        .submitBasket(nonMonotonic.header, nonMonotonic.constituents, nonMonotonic.signature)
    ).to.be.revertedWithCustomError(context.oracle, "NonMonotonicRound");

    const badCount = await signedBasket(context, generatedConstituents(3, 9), {
      roundId: 490201n,
      constituentCount: 2
    });
    await expect(
      context.oracle
        .connect(context.relayer)
        .submitBasket(badCount.header, badCount.constituents, badCount.signature)
    ).to.be.revertedWithCustomError(context.oracle, "ConstituentCountMismatch");

    const badHash = await signedBasket(context, generatedConstituents(3, 10), {
      roundId: 490202n,
      basketHash: hashText("wrong-basket-hash")
    });
    await expect(
      context.oracle
        .connect(context.relayer)
        .submitBasket(badHash.header, badHash.constituents, badHash.signature)
    ).to.be.revertedWithCustomError(context.oracle, "BasketHashMismatch");

    const block = await ethers.provider.getBlock("latest");
    const tooFuture = BigInt(block.timestamp + 16 * 60);
    const futureBasket = await signedBasket(context, generatedConstituents(3, 11), {
      roundId: 490203n,
      asOf: tooFuture,
      validUntil: tooFuture + 4n * 60n * 60n
    });
    await expect(
      context.oracle
        .connect(context.relayer)
        .submitBasket(futureBasket.header, futureBasket.constituents, futureBasket.signature)
    ).to.be.revertedWithCustomError(context.oracle, "FutureBasket");

    const tooMany = await signedBasket(context, generatedConstituents(51, 12), {
      roundId: 490204n
    });
    await expect(
      context.oracle
        .connect(context.relayer)
        .submitBasket(tooMany.header, tooMany.constituents, tooMany.signature)
    ).to.be.revertedWithCustomError(context.oracle, "TooManyConstituents");
  });
});
