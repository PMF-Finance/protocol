const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

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

const QUOTE_REFERENCE_TYPES = [
  { name: "basketFeedId", type: "bytes32" },
  { name: "basketHash", type: "bytes32" },
  { name: "basketRoundId", type: "uint80" },
  { name: "basketSource", type: "address" },
  { name: "basketSourceRevision", type: "uint64" },
  { name: "pricingFeedId", type: "bytes32" },
  { name: "pricingMode", type: "uint8" },
  { name: "pricingSource", type: "address" },
  { name: "pricingReportHash", type: "bytes32" },
  { name: "pricingAsOf", type: "uint64" }
];

const AP_QUOTE_TYPES = {
  QuoteReference: QUOTE_REFERENCE_TYPES,
  APDepositQuote: [
    { name: "quoteId", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "payer", type: "address" },
    { name: "receiver", type: "address" },
    { name: "grossAssets", type: "uint256" },
    { name: "spreadAssets", type: "uint256" },
    { name: "minShares", type: "uint256" },
    { name: "quoteReference", type: "QuoteReference" },
    { name: "deadline", type: "uint64" }
  ]
};

const AP_REDEEM_TYPES = {
  QuoteReference: QUOTE_REFERENCE_TYPES,
  APRedeemQuote: [
    { name: "quoteId", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "controller", type: "address" },
    { name: "owner", type: "address" },
    { name: "receiver", type: "address" },
    { name: "shares", type: "uint256" },
    { name: "assets", type: "uint256" },
    { name: "quoteReference", type: "QuoteReference" },
    { name: "deadline", type: "uint64" }
  ]
};

const VAULT_EIP712_NAME = "PMFVault";
const VAULT_EIP712_VERSION = "1";
const MANAGEMENT_FEE_REMAINDER_SCALE = 10n ** 18n;

function usdc(value) {
  return ethers.parseUnits(value, 6);
}

function hashText(value) {
  return ethers.keccak256(ethers.toUtf8Bytes(value));
}

function managementFeeShares(totalSupply, feeBps, elapsedSeconds) {
  return managementFeeSharesWithRemainder(totalSupply, feeBps, elapsedSeconds).shares;
}

function managementFeeSharesWithRemainder(totalSupply, feeBps, elapsedSeconds, remainder = 0n) {
  const numerator = BigInt(feeBps) * BigInt(elapsedSeconds);
  const denominator = 10000n * 365n * 24n * 60n * 60n;
  const scaledShares = (totalSupply * numerator * MANAGEMENT_FEE_REMAINDER_SCALE)
    / (denominator - numerator) + remainder;
  return {
    shares: scaledShares / MANAGEMENT_FEE_REMAINDER_SCALE,
    remainder: scaledShares % MANAGEMENT_FEE_REMAINDER_SCALE
  };
}

function baseMandate(tradingWallet, overrides = {}) {
  return {
    tradingWallet,
    tradingEnabled: true,
    allowedSides: 3,
    maxSlippageBps: 50,
    maxSpreadBps: 300,
    maxDepthParticipationBps: 2500,
    maxOrdersPerPlan: 25,
    staleAfterSeconds: 900,
    orderExpirySeconds: 300,
    minOrderNotional: usdc("1"),
    maxOrderNotional: usdc("1000"),
    minVaultCashBuffer: 0n,
    ...overrides
  };
}

function vaultInit(admin, manager, navReporter, spreadRecipient, initialAPs, initialMandate, overrides = {}) {
  return {
    admin,
    manager,
    navReporter,
    managementFeeRecipient: overrides.managementFeeRecipient ?? spreadRecipient,
    managementFeeBps: overrides.managementFeeBps ?? 0,
    initialAPs,
    initialMandate
  };
}

describe("PMFVault", function () {
  async function deployVaultFactory() {
    const Accounting = await ethers.getContractFactory("PMFVaultAccountingLib");
    const accounting = await Accounting.deploy();
    await accounting.waitForDeployment();
    const Redemption = await ethers.getContractFactory("PMFVaultRedemptionLib");
    const redemption = await Redemption.deploy();
    await redemption.waitForDeployment();
    const Intent = await ethers.getContractFactory("PMFVaultIntentLib", {
      libraries: { PMFVaultAccountingLib: await accounting.getAddress() }
    });
    const intent = await Intent.deploy();
    await intent.waitForDeployment();
    const Quote = await ethers.getContractFactory("PMFVaultQuoteLib");
    const quote = await Quote.deploy();
    await quote.waitForDeployment();
    const Residual = await ethers.getContractFactory("PMFVaultResidualLib", {
      libraries: { PMFVaultIntentLib: await intent.getAddress() }
    });
    const residual = await Residual.deploy();
    await residual.waitForDeployment();
    return ethers.getContractFactory("PMFVault", {
      libraries: {
        PMFVaultAccountingLib: await accounting.getAddress(),
        PMFVaultRedemptionLib: await redemption.getAddress(),
        PMFVaultIntentLib: await intent.getAddress(),
        PMFVaultQuoteLib: await quote.getAddress(),
        PMFVaultResidualLib: await residual.getAddress()
      }
    });
  }

  async function deployOracle() {
    const [admin, oracleSigner, relayer] = await ethers.getSigners();
    const feedId = hashText("PMF:stability:basket:v1");
    const Oracle = await ethers.getContractFactory("PMFBasketOracle");
    const oracle = await Oracle.deploy(
      feedId,
      admin.address,
      oracleSigner.address,
      50,
      15 * 60,
      100000000000000n
    );
    await oracle.waitForDeployment();
    return { admin, oracleSigner, relayer, oracle, feedId };
  }

  async function publishBasket(context, overrides = {}) {
    const block = await ethers.provider.getBlock("latest");
    const asOf = overrides.asOf ?? BigInt(block.timestamp);
    const constituents = overrides.constituents ?? [
      {
        tokenId: 1001n,
        conditionId: hashText("condition-a"),
        marketIdHash: hashText("market-a"),
        questionHash: hashText("question-a"),
        outcomeHash: hashText("Yes"),
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
        conditionId: hashText("condition-b"),
        marketIdHash: hashText("market-b"),
        questionHash: hashText("question-b"),
        outcomeHash: hashText("No"),
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
      roundId: overrides.roundId ?? 490000n,
      asOf,
      validUntil: overrides.validUntil ?? asOf + BigInt(overrides.validSeconds ?? 4 * 60 * 60),
      runIdHash: hashText(`run:${overrides.roundId ?? 490000n}`),
      basketHash,
      constituentCount: constituents.length,
      levelE18: 101250000000000000000n,
      qualityStatus: 1
    };
    const signature = await signHeader(context.oracleSigner, context.oracle, header);
    await context.oracle.connect(context.relayer).submitBasket(header, constituents, signature);
    return { header, constituents, signature };
  }

  function basketConstituent(tokenId, asOf, overrides = {}) {
    return {
      tokenId,
      conditionId: hashText(`condition-${tokenId}`),
      marketIdHash: hashText(`market-${tokenId}`),
      questionHash: hashText(`question-${tokenId}`),
      outcomeHash: hashText(`outcome-${tokenId}`),
      outcomeSide: overrides.outcomeSide ?? 1,
      weightE18: overrides.weightE18 ?? 1000000000000000000n,
      referencePriceE18: overrides.referencePriceE18 ?? 500000000000000000n,
      executionCapacityE6: overrides.executionCapacityE6 ?? usdc("5000"),
      bestBidE18: overrides.bestBidE18 ?? 490000000000000000n,
      bestAskE18: overrides.bestAskE18 ?? 500000000000000000n,
      spreadBps: overrides.spreadBps ?? 200,
      depthBidE6: overrides.depthBidE6 ?? usdc("5000"),
      depthAskE6: overrides.depthAskE6 ?? usdc("5000"),
      marketDataAsOf: overrides.marketDataAsOf ?? asOf
    };
  }

  async function publishCustomBasket(fixture, roundId, constituentsFactory) {
    const block = await ethers.provider.getBlock("latest");
    const asOf = BigInt(block.timestamp);
    return publishBasket(
      {
        admin: fixture.admin,
        oracle: fixture.oracle,
        oracleSigner: fixture.oracleSigner,
        relayer: fixture.relayer,
        feedId: await fixture.vault.basketFeedId()
      },
      {
        roundId,
        constituents: constituentsFactory(asOf)
      }
    );
  }

  async function acquireViaBuyIntent(fixture, tokenId, fillSize) {
    const { admin, manager, other: solver, conditionalTokens, vault } = fixture;
    await vault.connect(admin).grantRole(await vault.SOLVER_ROLE(), solver.address);
    await expect(commitBatch(vault, manager)).to.emit(vault, "OrderIntentBatchCommitted");
    const batch = await vault.activeOrderIntentBatch();
    const { intentHash, intent } = await findIntent(vault, { side: 1, tokenId });
    expect(intentHash).to.not.equal(undefined);
    expect(fillSize <= intent.remainingSize).to.equal(true);
    await conditionalTokens.mint(solver.address, tokenId, fillSize);
    await conditionalTokens.connect(solver).setApprovalForAll(await vault.getAddress(), true);
    await expect(vault.connect(solver).fulfillBuyIntent(batch.batchId, intentHash, fillSize, intent.priceE18))
      .to.emit(vault, "SolverOrderIntentFulfilled")
      .withArgs(batch.batchId, intentHash, solver.address, 1, tokenId, fillSize, intent.priceE18, anyValue);
  }

  async function acquireRemovedResidualPosition(fixture, tokenId, fillSize, roundId = 490100n) {
    await publishCustomBasket(fixture, roundId, (asOf) => [basketConstituent(tokenId, asOf)]);
    await acquireViaBuyIntent(fixture, tokenId, fillSize);
    await publishBasket(
      {
        admin: fixture.admin,
        oracle: fixture.oracle,
        oracleSigner: fixture.oracleSigner,
        relayer: fixture.relayer,
        feedId: await fixture.vault.basketFeedId()
      },
      { roundId: roundId + 1n }
    );
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

  async function signAPQuote(signer, vault, auth) {
    const { chainId } = await ethers.provider.getNetwork();
    auth.quoteReference = auth.quoteReference ?? await currentQuoteReference(vault);
    return signer.signTypedData(
      {
        name: VAULT_EIP712_NAME,
        version: VAULT_EIP712_VERSION,
        chainId,
        verifyingContract: await vault.getAddress()
      },
      AP_QUOTE_TYPES,
      auth
    );
  }

  async function signAPRedeemQuote(signer, vault, auth) {
    const { chainId } = await ethers.provider.getNetwork();
    auth.quoteReference = auth.quoteReference ?? await currentQuoteReference(vault);
    return signer.signTypedData(
      {
        name: VAULT_EIP712_NAME,
        version: VAULT_EIP712_VERSION,
        chainId,
        verifyingContract: await vault.getAddress()
      },
      AP_REDEEM_TYPES,
      auth
    );
  }

  async function currentQuoteReference(vault) {
    const router = await ethers.getContractAt("PMFBasketOracleRouter", await vault.basketOracleRouter());
    const feedId = await vault.basketFeedId();
    const header = await router.latestBasket(feedId);
    const report = await vault.latestTradingAssetsReport();
    return {
      basketFeedId: feedId,
      basketHash: header.basketHash,
      basketRoundId: header.roundId,
      basketSource: await router.activeSource(feedId),
      basketSourceRevision: await router.sourceRevision(feedId),
      pricingFeedId: await vault.pricingFeedId(),
      pricingMode: 1,
      pricingSource: ethers.ZeroAddress,
      pricingReportHash: report.reportHash,
      pricingAsOf: report.asOf
    };
  }

  async function commitBatch(vault, signer) {
    const router = await ethers.getContractAt("PMFBasketOracleRouter", await vault.basketOracleRouter());
    const header = await router.latestBasket(await vault.basketFeedId());
    return vault.connect(signer).commitOrderIntentBatchFor(header.basketHash, header.roundId);
  }

  async function redeemAuth(vault, label, { controller, owner, receiver, shares, assets }, overrides = {}) {
    const block = await ethers.provider.getBlock("latest");
    return {
      quoteId: hashText(`redeem-quote:${label}`),
      nonce: hashText(`redeem-nonce:${label}`),
      controller,
      owner,
      receiver,
      shares,
      assets,
      deadline: BigInt(block.timestamp + 3600),
      ...overrides
    };
  }

  async function requestRedeemWithQuote(vault, ap, sender, label, params, overrides = {}) {
    const auth = await redeemAuth(vault, label, params, overrides);
    return vault.connect(sender).requestRedeemWithAPQuote(auth, await signAPRedeemQuote(ap, vault, auth));
  }

  async function depositWithQuote(vault, ap, payer, receiver, label, assets, overrides = {}) {
    const block = await ethers.provider.getBlock("latest");
    const spreadAssets = overrides.spreadAssets ?? 0n;
    const minShares = overrides.minShares ?? (await vault.previewDeposit(assets - spreadAssets));
    const auth = {
      quoteId: hashText(`deposit-quote:${label}`),
      nonce: hashText(`deposit-nonce:${label}`),
      payer: payer.address,
      receiver: receiver.address,
      grossAssets: assets,
      spreadAssets,
      minShares,
      deadline: BigInt(block.timestamp + 3600),
      ...overrides
    };
    return vault.connect(payer).depositWithAPQuote(auth, await signAPQuote(ap, vault, auth));
  }

  async function findIntent(vault, { side, tokenId } = {}) {
    const intentCount = Number(await vault.latestOrderIntentCount());
    for (let index = 0; index < intentCount; index++) {
      const intentHash = await vault.latestOrderIntentHash(index);
      const intent = await vault.solverOrderIntents(intentHash);
      if (
        (side === undefined || Number(intent.side) === side)
        && (tokenId === undefined || intent.tokenId === tokenId)
      ) {
        return { intentHash, intent };
      }
    }
    return { intentHash: undefined, intent: undefined };
  }

  async function commitResidual(vault, manager, tokenIds) {
    const tx = await vault.connect(manager).commitResidualLiquidationBatch(tokenIds);
    const receipt = await tx.wait();
    const events = receipt.logs
      .map((log) => {
        try {
          return vault.interface.parseLog(log);
        } catch (_error) {
          return null;
        }
      })
      .filter(Boolean);
    const committed = events.find((event) => event.name === "ResidualSellIntentCommitted");
    return { tx, receipt, events, committed };
  }

  async function deployFixture(options = {}) {
    const [
      admin,
      manager,
      navReporter,
      oracleSigner,
      relayer,
      ap,
      ap2,
      investor,
      operator,
      tradingWallet,
      other,
      receiver,
      feeRecipient
    ] = await ethers.getSigners();
    const feedId = hashText("PMF:stability:basket:v1");

    const Oracle = await ethers.getContractFactory("PMFBasketOracle");
    const oracle = await Oracle.deploy(
      feedId,
      admin.address,
      oracleSigner.address,
      50,
      15 * 60,
      100000000000000n
    );
    await oracle.waitForDeployment();
    const oracleContext = { admin, oracleSigner, relayer, oracle, feedId };
    const basket = await publishBasket(oracleContext, options.basketOverrides ?? {});
    const pricingFeedId = hashText("PMF:pricing:snapshot:v1");
    const BasketRouter = await ethers.getContractFactory("PMFBasketOracleRouter");
    const basketRouter = await BasketRouter.deploy(admin.address);
    await basketRouter.waitForDeployment();
    await basketRouter.connect(admin).setSourceAllowed(feedId, await oracle.getAddress(), true);
    await basketRouter.connect(admin).setInitialSource(feedId, await oracle.getAddress());
    const PricingRouter = await ethers.getContractFactory("PMFPricingRouter");
    const pricingRouter = await PricingRouter.deploy(admin.address);
    await pricingRouter.waitForDeployment();
    await pricingRouter.connect(admin).setInitialSource(pricingFeedId, ethers.ZeroAddress, false);

    const Token = await ethers.getContractFactory("MockERC20");
    const pusd = await Token.deploy("Polymarket USD", "pUSD", 6);
    await pusd.waitForDeployment();
    const ConditionalTokens = await ethers.getContractFactory("MockERC1155");
    const conditionalTokens = await ConditionalTokens.deploy();
    await conditionalTokens.waitForDeployment();

    const Vault = await deployVaultFactory();
    const vault = await Vault.deploy(
      VAULT_EIP712_NAME,
      "pmfSTBL",
      await pusd.getAddress(),
      await conditionalTokens.getAddress(),
      await basketRouter.getAddress(),
      feedId,
      await pricingRouter.getAddress(),
      pricingFeedId,
      vaultInit(
        admin.address,
        manager.address,
        navReporter.address,
        feeRecipient.address,
        [ap.address, ap2.address],
        baseMandate(tradingWallet.address, options.mandateOverrides ?? {})
      )
    );
    await vault.waitForDeployment();
    if (options.configureAPRecipients !== false) {
      await vault.connect(ap).setMyFeeRecipient(feeRecipient.address);
      await vault.connect(ap2).setMyFeeRecipient(feeRecipient.address);
    }

    await pusd.mint(ap.address, usdc("10000"));
    await pusd.connect(ap).approve(await vault.getAddress(), ethers.MaxUint256);
    await pusd.mint(ap2.address, usdc("10000"));
    await pusd.connect(ap2).approve(await vault.getAddress(), ethers.MaxUint256);

    return {
      admin,
      manager,
      navReporter,
      oracleSigner,
      relayer,
      ap,
      ap2,
      investor,
      operator,
      tradingWallet,
      other,
      receiver,
      feeRecipient,
      oracle,
      basketRouter,
      pricingRouter,
      pricingFeedId,
      conditionalTokens,
      pusd,
      vault,
      basket
    };
  }

  it("rejects invalid constructor dependencies", async function () {
    const oracleContext = await deployOracle();
    const { admin, oracle, feedId } = oracleContext;
    await publishBasket(oracleContext);
    const [, manager, navReporter, , , ap, , , , tradingWallet, , , feeRecipient] =
      await ethers.getSigners();
    const pricingFeedId = hashText("PMF:pricing:snapshot:v1");
    const BasketRouter = await ethers.getContractFactory("PMFBasketOracleRouter");
    const basketRouter = await BasketRouter.deploy(admin.address);
    await basketRouter.waitForDeployment();
    await basketRouter.connect(admin).setSourceAllowed(feedId, await oracle.getAddress(), true);
    await basketRouter.connect(admin).setInitialSource(feedId, await oracle.getAddress());
    const PricingRouter = await ethers.getContractFactory("PMFPricingRouter");
    const pricingRouter = await PricingRouter.deploy(admin.address);
    await pricingRouter.waitForDeployment();
    await pricingRouter.connect(admin).setInitialSource(pricingFeedId, ethers.ZeroAddress, false);
    const Token = await ethers.getContractFactory("MockERC20");
    const pusd = await Token.deploy("Polymarket USD", "pUSD", 6);
    await pusd.waitForDeployment();
    const ConditionalTokens = await ethers.getContractFactory("MockERC1155");
    const conditionalTokens = await ConditionalTokens.deploy();
    await conditionalTokens.waitForDeployment();

    const Vault = await deployVaultFactory();
    const initialMandate = baseMandate(tradingWallet.address);
    await expect(
      Vault.deploy(
        VAULT_EIP712_NAME,
        "pmfSTBL",
        ethers.ZeroAddress,
        await conditionalTokens.getAddress(),
        await basketRouter.getAddress(),
        feedId,
        await pricingRouter.getAddress(),
        pricingFeedId,
        vaultInit(admin.address, manager.address, navReporter.address, feeRecipient.address, [ap.address], initialMandate)
      )
    ).to.be.revertedWithCustomError(Vault, "InvalidAddress");
    await expect(
      Vault.deploy(
        VAULT_EIP712_NAME,
        "pmfSTBL",
        await pusd.getAddress(),
        ethers.ZeroAddress,
        await basketRouter.getAddress(),
        feedId,
        await pricingRouter.getAddress(),
        pricingFeedId,
        vaultInit(admin.address, manager.address, navReporter.address, feeRecipient.address, [ap.address], initialMandate)
      )
    ).to.be.revertedWithCustomError(Vault, "InvalidAddress");
    await expect(
      Vault.deploy(
        VAULT_EIP712_NAME,
        "pmfSTBL",
        await pusd.getAddress(),
        await conditionalTokens.getAddress(),
        ethers.ZeroAddress,
        feedId,
        await pricingRouter.getAddress(),
        pricingFeedId,
        vaultInit(admin.address, manager.address, navReporter.address, feeRecipient.address, [ap.address], initialMandate)
      )
    ).to.be.revertedWithCustomError(Vault, "InvalidAddress");
    await expect(
      Vault.deploy(
        VAULT_EIP712_NAME,
        "pmfSTBL",
        await pusd.getAddress(),
        await conditionalTokens.getAddress(),
        await basketRouter.getAddress(),
        feedId,
        await pricingRouter.getAddress(),
        pricingFeedId,
        vaultInit(admin.address, ethers.ZeroAddress, navReporter.address, feeRecipient.address, [ap.address], initialMandate)
      )
    ).to.be.revertedWithCustomError(Vault, "InvalidAddress");
    await expect(
      Vault.deploy(
        VAULT_EIP712_NAME,
        "pmfSTBL",
        await pusd.getAddress(),
        await conditionalTokens.getAddress(),
        await basketRouter.getAddress(),
        feedId,
        await pricingRouter.getAddress(),
        pricingFeedId,
        vaultInit(admin.address, manager.address, ethers.ZeroAddress, feeRecipient.address, [ap.address], initialMandate)
      )
    ).to.be.revertedWithCustomError(Vault, "InvalidAddress");
    await expect(
      Vault.deploy(
        VAULT_EIP712_NAME,
        "pmfSTBL",
        await pusd.getAddress(),
        await conditionalTokens.getAddress(),
        await basketRouter.getAddress(),
        feedId,
        await pricingRouter.getAddress(),
        pricingFeedId,
        vaultInit(admin.address, manager.address, navReporter.address, ethers.ZeroAddress, [ap.address], initialMandate)
      )
    ).to.be.revertedWithCustomError(Vault, "InvalidAddress");
    await expect(
      Vault.deploy(
        VAULT_EIP712_NAME,
        "pmfSTBL",
        await pusd.getAddress(),
        await conditionalTokens.getAddress(),
        await basketRouter.getAddress(),
        feedId,
        await pricingRouter.getAddress(),
        pricingFeedId,
        vaultInit(
          admin.address,
          manager.address,
          navReporter.address,
          feeRecipient.address,
          [ethers.ZeroAddress],
          initialMandate
        )
      )
    ).to.be.revertedWithCustomError(Vault, "InvalidAddress");
  });

  it("uses AP-signed deposits and keeps share transfers standard", async function () {
    const { admin, manager, navReporter, ap, ap2, investor, other, receiver, pusd, vault } =
      await deployFixture();
    const depositAssets = usdc("1000");

    await pusd.mint(other.address, depositAssets);
    await pusd.connect(other).approve(await vault.getAddress(), depositAssets);
    await expect(vault.connect(other).deposit(depositAssets, other.address))
      .to.be.revertedWithCustomError(vault, "InvalidAmount");
    await expect(vault.connect(ap).deposit(depositAssets, investor.address))
      .to.be.revertedWithCustomError(vault, "InvalidAmount");

    await expect(depositWithQuote(vault, ap, ap, investor, "ap-seed", depositAssets))
      .to.emit(vault, "Deposit")
      .withArgs(ap.address, investor.address, depositAssets, depositAssets);
    expect(await vault.balanceOf(investor.address)).to.equal(depositAssets);
    await expect(depositWithQuote(vault, ap2, ap2, investor, "ap2-seed", usdc("25")))
      .to.emit(vault, "Deposit")
      .withArgs(ap2.address, investor.address, usdc("25"), usdc("25"));
    expect(await vault.hasRole(await vault.AP_ROLE(), ap.address)).to.equal(true);
    expect(await vault.hasRole(await vault.AP_ROLE(), ap2.address)).to.equal(true);
    expect(await vault.hasRole(await vault.AP_ROLE(), admin.address)).to.equal(false);
    expect(await vault.hasRole(await vault.MANDATE_MANAGER_ROLE(), manager.address)).to.equal(true);
    expect(await vault.hasRole(await vault.ORDER_COMMITTER_ROLE(), manager.address)).to.equal(true);
    expect(await vault.hasRole(await vault.PAUSER_ROLE(), manager.address)).to.equal(true);
    expect(await vault.hasRole(await vault.NAV_REPORTER_ROLE(), navReporter.address)).to.equal(true);
    expect(await vault.hasRole(await vault.NAV_REPORTER_ROLE(), admin.address)).to.equal(false);

    await vault.connect(investor).transfer(other.address, usdc("10"));
    expect(await vault.balanceOf(other.address)).to.equal(usdc("10"));

    await vault.connect(investor).approve(receiver.address, usdc("10"));
    await vault.connect(receiver).transferFrom(investor.address, receiver.address, usdc("10"));
    expect(await vault.balanceOf(receiver.address)).to.equal(usdc("10"));

    expect(await vault.decimals()).to.equal(6);
  });

  it("lets each approved AP control only its own fee recipient", async function () {
    const { admin, ap, ap2, other, feeRecipient, receiver, vault } =
      await deployFixture({ configureAPRecipients: false });

    expect(await vault.apFeeRecipient(ap.address)).to.equal(ethers.ZeroAddress);
    await expect(vault.connect(other).setMyFeeRecipient(other.address))
      .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount")
      .withArgs(other.address, await vault.AP_ROLE());
    await expect(vault.connect(ap).setMyFeeRecipient(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(vault, "InvalidAddress");
    await expect(vault.connect(ap).setMyFeeRecipient(await vault.getAddress()))
      .to.be.revertedWithCustomError(vault, "InvalidAddress");

    await expect(vault.connect(ap).setMyFeeRecipient(feeRecipient.address))
      .to.emit(vault, "APFeeRecipientUpdated")
      .withArgs(ap.address, ethers.ZeroAddress, feeRecipient.address);
    await expect(vault.connect(ap2).setMyFeeRecipient(receiver.address))
      .to.emit(vault, "APFeeRecipientUpdated")
      .withArgs(ap2.address, ethers.ZeroAddress, receiver.address);
    expect(await vault.apFeeRecipient(ap.address)).to.equal(feeRecipient.address);
    expect(await vault.apFeeRecipient(ap2.address)).to.equal(receiver.address);

    await admin.sendTransaction({ to: ap.address, value: 1n });
    await vault.connect(admin).revokeRole(await vault.AP_ROLE(), ap.address);
    await expect(vault.connect(ap).setMyFeeRecipient(other.address))
      .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount")
      .withArgs(ap.address, await vault.AP_ROLE());
    expect(await vault.apFeeRecipient(ap.address)).to.equal(feeRecipient.address);
  });

  it("requires a configured AP recipient and routes multiple APs independently", async function () {
    const { ap, ap2, investor, receiver, feeRecipient, pusd, vault } =
      await deployFixture({ configureAPRecipients: false });
    await expect(
      depositWithQuote(vault, ap, ap, investor, "recipient-required", usdc("1"))
    ).to.be.revertedWithCustomError(vault, "InvalidAddress");

    await vault.connect(ap).setMyFeeRecipient(feeRecipient.address);
    await vault.connect(ap2).setMyFeeRecipient(receiver.address);
    await depositWithQuote(vault, ap, ap, investor, "recipient-ap-one", usdc("10"), {
      spreadAssets: usdc("0.1")
    });
    await depositWithQuote(vault, ap2, ap2, investor, "recipient-ap-two", usdc("10"), {
      spreadAssets: usdc("0.1")
    });

    expect(await pusd.balanceOf(feeRecipient.address)).to.equal(usdc("0.1"));
    expect(await pusd.balanceOf(receiver.address)).to.equal(usdc("0.1"));
  });

  it("keeps direct minting closed and exposes view/interface helpers", async function () {
    const { manager, ap, investor, pusd, vault } = await deployFixture();
    const shares = usdc("250");

    await expect(vault.connect(ap).mint(shares, investor.address))
      .to.be.revertedWithCustomError(vault, "InvalidAmount");
    expect(await vault.balanceOf(investor.address)).to.equal(0n);
    expect(await vault.maxMint(investor.address)).to.equal(ethers.MaxUint256);
    expect(await vault.maxRedeem(investor.address)).to.equal(0n);
    expect(await vault.liquidAssets()).to.equal(await pusd.balanceOf(await vault.getAddress()));

    expect(await vault.supportsInterface("0x620ee8e4")).to.equal(false);
    expect(await vault.supportsInterface("0xe3bc4e65")).to.equal(false);
    expect(await vault.supportsInterface("0x2f0a18c5")).to.equal(false);
    expect(await vault.supportsInterface("0xffffffff")).to.equal(false);

    await vault.connect(manager).pause();
    expect(await vault.maxDeposit(investor.address)).to.equal(ethers.MaxUint256);
    expect(await vault.maxMint(investor.address)).to.equal(ethers.MaxUint256);
  });

  it("lets users deposit with a valid AP-signed quote while spread goes to treasury", async function () {
    const { ap, investor, receiver, feeRecipient, pusd, vault } = await deployFixture();
    const grossAssets = usdc("100");
    const spreadAssets = usdc("0.50");
    const netAssets = grossAssets - spreadAssets;
    const shares = usdc("99.25");
    const block = await ethers.provider.getBlock("latest");
    const auth = {
      quoteId: hashText("quote:valid-user-deposit"),
      nonce: hashText("nonce:valid-user-deposit"),
      payer: investor.address,
      receiver: receiver.address,
      grossAssets,
      spreadAssets,
      minShares: shares,
      deadline: BigInt(block.timestamp + 3600)
    };
    const signature = await signAPQuote(ap, vault, auth);

    await pusd.mint(investor.address, grossAssets);
    await pusd.connect(investor).approve(await vault.getAddress(), grossAssets);

    await expect(vault.connect(investor).depositWithAPQuote(auth, signature))
      .to.emit(vault, "Deposit")
      .withArgs(investor.address, receiver.address, netAssets, await vault.previewDeposit(netAssets))
      .and.to.emit(vault, "APQuoteDeposit")
      .withArgs(
        auth.quoteId,
        auth.nonce,
        ap.address,
        investor.address,
        receiver.address,
        grossAssets,
        spreadAssets,
        await vault.previewDeposit(netAssets),
        feeRecipient.address
      );

    expect(await vault.balanceOf(receiver.address)).to.equal(await vault.previewDeposit(netAssets));
    expect(await pusd.balanceOf(feeRecipient.address)).to.equal(spreadAssets);
    expect(await pusd.balanceOf(await vault.getAddress())).to.equal(netAssets);
    await expect(vault.connect(investor).depositWithAPQuote(auth, signature))
      .to.be.revertedWithCustomError(vault, "APQuoteAlreadyUsed")
      .withArgs(anyValue);
  });

  it("bootstraps AP deposits 1:1 when raw pUSD was donated before the first mint", async function () {
    const { ap, investor, other, receiver, pusd, vault } = await deployFixture();
    const donation = usdc("10");
    const grossAssets = usdc("2");
    const spreadAssets = usdc("0.01");
    const netAssets = grossAssets - spreadAssets;

    await pusd.mint(other.address, donation);
    await pusd.connect(other).transfer(await vault.getAddress(), donation);

    expect(await vault.totalSupply()).to.equal(0n);
    expect(await vault.totalAssets()).to.equal(donation);
    expect(await vault.previewDeposit(netAssets)).to.equal(netAssets);
    expect(await vault.convertToAssets(netAssets)).to.equal(netAssets);

    await pusd.mint(investor.address, grossAssets);
    await pusd.connect(investor).approve(await vault.getAddress(), grossAssets);

    await expect(depositWithQuote(vault, ap, investor, receiver, "donated-bootstrap", grossAssets, { spreadAssets }))
      .to.emit(vault, "Deposit")
      .withArgs(investor.address, receiver.address, netAssets, netAssets);

    expect(await vault.balanceOf(receiver.address)).to.equal(netAssets);
    expect(await vault.totalSupply()).to.equal(netAssets);
    expect(await vault.totalAssets()).to.equal(donation + netAssets);
    expect(await vault.convertToAssets(netAssets)).to.be.greaterThan(netAssets);
  });

  it("keeps donated pUSD in NAV after bootstrap and prices later mints from raw balance", async function () {
    const { ap, investor, other, pusd, vault } = await deployFixture();
    await depositWithQuote(vault, ap, ap, investor, "raw-balance-seed", usdc("100"));

    const sampleShares = usdc("10");
    const sampleAssetsBefore = await vault.convertToAssets(sampleShares);
    const sharesForTenBefore = await vault.previewDeposit(usdc("10"));

    const donation = usdc("50");
    await pusd.mint(other.address, donation);
    await pusd.connect(other).transfer(await vault.getAddress(), donation);

    expect(await vault.totalAssets()).to.equal(usdc("150"));
    expect(await vault.convertToAssets(sampleShares)).to.be.greaterThan(sampleAssetsBefore);
    expect(await vault.previewDeposit(usdc("10"))).to.be.lessThan(sharesForTenBefore);
  });

  it("keeps AP-signed deposits independent from stale index oracle rounds", async function () {
    const { ap, investor, receiver, pusd, vault, oracle } = await deployFixture({
      basketOverrides: { validSeconds: 1 }
    });
    await network.provider.send("evm_increaseTime", [2]);
    await network.provider.send("evm_mine");
    expect(await oracle.isFresh()).to.equal(false);

    const grossAssets = usdc("10");
    const spreadAssets = usdc("0.05");
    const netAssets = grossAssets - spreadAssets;
    const shares = await vault.previewDeposit(netAssets);
    const block = await ethers.provider.getBlock("latest");
    const auth = {
      quoteId: hashText("quote:stale-oracle-user-deposit"),
      nonce: hashText("nonce:stale-oracle-user-deposit"),
      payer: investor.address,
      receiver: receiver.address,
      grossAssets,
      spreadAssets,
      minShares: shares,
      deadline: BigInt(block.timestamp + 3600)
    };

    await pusd.mint(investor.address, grossAssets);
    await pusd.connect(investor).approve(await vault.getAddress(), grossAssets);
    await expect(vault.connect(investor).depositWithAPQuote(auth, await signAPQuote(ap, vault, auth)))
      .to.emit(vault, "APQuoteDeposit");
  });

  it("rejects invalid AP-signed deposit attempts", async function () {
    const { ap, manager, investor, other, receiver, pusd, vault } =
      await deployFixture();
    const grossAssets = usdc("100");
    const spreadAssets = usdc("0.50");
    const minShares = usdc("99.25");
    const block = await ethers.provider.getBlock("latest");
    const baseAuth = {
      quoteId: hashText("quote:base-invalid"),
      nonce: hashText("nonce:base-invalid"),
      payer: investor.address,
      receiver: receiver.address,
      grossAssets,
      spreadAssets,
      minShares,
      deadline: BigInt(block.timestamp + 3600)
    };
    const auth = (label, overrides = {}) => ({
      ...baseAuth,
      quoteId: hashText(`quote:${label}`),
      nonce: hashText(`nonce:${label}`),
      ...overrides
    });

    await pusd.mint(investor.address, usdc("1000"));
    await pusd.connect(investor).approve(await vault.getAddress(), ethers.MaxUint256);

    const wrongPayerAuth = auth("wrong-payer");
    await expect(
      vault.connect(other).depositWithAPQuote(wrongPayerAuth, await signAPQuote(ap, vault, wrongPayerAuth))
    )
      .to.be.revertedWithCustomError(vault, "QuotePayerMismatch")
      .withArgs(investor.address, other.address);

    const nonApAuth = auth("non-ap");
    await expect(vault.connect(investor).depositWithAPQuote(nonApAuth, await signAPQuote(other, vault, nonApAuth)))
      .to.be.revertedWithCustomError(vault, "UnauthorizedAPQuoteSigner")
      .withArgs(other.address);

    const expiredAuth = auth("expired", { deadline: BigInt(block.timestamp - 1) });
    await expect(vault.connect(investor).depositWithAPQuote(expiredAuth, await signAPQuote(ap, vault, expiredAuth)))
      .to.be.revertedWithCustomError(vault, "ExpiredAPQuote")
      .withArgs(expiredAuth.deadline);

    const overMintAuth = auth("over-mint", { minShares: usdc("100") });
    await expect(vault.connect(investor).depositWithAPQuote(overMintAuth, await signAPQuote(ap, vault, overMintAuth)))
      .to.be.revertedWithCustomError(vault, "ExcessiveAPQuoteShares")
      .withArgs(usdc("100"), usdc("99.5"));

    const zeroReceiverAuth = auth("zero-receiver", { receiver: ethers.ZeroAddress });
    await expect(
      vault.connect(investor).depositWithAPQuote(zeroReceiverAuth, await signAPQuote(ap, vault, zeroReceiverAuth))
    ).to.be.revertedWithCustomError(vault, "InvalidAddress");

    const zeroGrossAuth = auth("zero-gross", { grossAssets: 0n });
    await expect(
      vault.connect(investor).depositWithAPQuote(zeroGrossAuth, await signAPQuote(ap, vault, zeroGrossAuth))
    ).to.be.revertedWithCustomError(vault, "InvalidAmount");

    const fullSpreadAuth = auth("full-spread", { spreadAssets: grossAssets });
    await expect(
      vault.connect(investor).depositWithAPQuote(fullSpreadAuth, await signAPQuote(ap, vault, fullSpreadAuth))
    ).to.be.revertedWithCustomError(vault, "InvalidAmount");

    await vault.connect(manager).pause();
    const pausedAuth = auth("paused");
    await expect(vault.connect(investor).depositWithAPQuote(pausedAuth, await signAPQuote(ap, vault, pausedAuth)))
      .to.be.revertedWithCustomError(vault, "EnforcedPause");

    await vault.connect(manager).unpause();
    await vault.connect(manager).beginWindDown();
    await vault.connect(manager).closeFund();
    const closedAuth = auth("closed");
    await expect(vault.connect(investor).depositWithAPQuote(closedAuth, await signAPQuote(ap, vault, closedAuth)))
      .to.be.revertedWithCustomError(vault, "FundAlreadyClosed");
  });

  it("accrues supply-based management fees with manager/admin controls", async function () {
    const { admin, manager, ap, investor, other, receiver, feeRecipient, vault } = await deployFixture();
    await depositWithQuote(vault, ap, ap, investor, "management-fee-seed", usdc("1000"));

    await network.provider.send("evm_increaseTime", [365 * 24 * 60 * 60]);
    await network.provider.send("evm_mine");
    await vault.accrueManagementFee();
    expect(await vault.balanceOf(feeRecipient.address)).to.equal(0n);

    await expect(vault.connect(other).setManagementFee(100, feeRecipient.address))
      .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount")
      .withArgs(other.address, await vault.MANDATE_MANAGER_ROLE());
    await expect(vault.connect(manager).setManagementFee(501, feeRecipient.address))
      .to.be.revertedWithCustomError(vault, "ExcessiveManagementFee")
      .withArgs(501, 500);
    await expect(vault.connect(manager).setManagementFee(100, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(vault, "InvalidAddress");

    await expect(vault.connect(manager).setManagementFee(100, feeRecipient.address))
      .to.emit(vault, "ManagementFeeUpdated")
      .withArgs(100, feeRecipient.address, manager.address);
    expect(await vault.managementFeeBps()).to.equal(100);
    expect(await vault.managementFeeRecipient()).to.equal(feeRecipient.address);

    const firstSupply = await vault.totalSupply();
    const firstLast = await vault.lastManagementFeeAccruedAt();
    await network.provider.send("evm_increaseTime", [182 * 24 * 60 * 60]);
    const firstTx = await vault.connect(admin).setManagementFee(200, receiver.address);
    const firstReceipt = await firstTx.wait();
    const firstBlock = await ethers.provider.getBlock(firstReceipt.blockNumber);
    const firstExpected = managementFeeSharesWithRemainder(firstSupply, 100, BigInt(firstBlock.timestamp) - firstLast);
    expect(await vault.balanceOf(feeRecipient.address)).to.equal(firstExpected.shares);
    expect(await vault.managementFeeBps()).to.equal(200);
    expect(await vault.managementFeeRecipient()).to.equal(receiver.address);

    const secondSupply = await vault.totalSupply();
    const secondLast = await vault.lastManagementFeeAccruedAt();
    await network.provider.send("evm_increaseTime", [90 * 24 * 60 * 60]);
    const secondTx = await vault.accrueManagementFee();
    const secondReceipt = await secondTx.wait();
    const secondBlock = await ethers.provider.getBlock(secondReceipt.blockNumber);
    const secondExpected = managementFeeSharesWithRemainder(
      secondSupply,
      200,
      BigInt(secondBlock.timestamp) - secondLast,
      firstExpected.remainder
    );
    expect(await vault.balanceOf(receiver.address)).to.equal(secondExpected.shares);
  });

  it("accrues management fees before deposits and redemption burns", async function () {
    const { manager, ap, investor, receiver, feeRecipient, pusd, vault } = await deployFixture();
    await depositWithQuote(vault, ap, ap, investor, "lazy-fee-seed", usdc("1000"));
    await vault.connect(manager).setManagementFee(100, feeRecipient.address);

    const supplyBeforeDeposit = await vault.totalSupply();
    const lastBeforeDeposit = await vault.lastManagementFeeAccruedAt();
    await network.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
    await network.provider.send("evm_mine");
    await depositWithQuote(vault, ap, ap, investor, "lazy-fee-followup", usdc("100"));
    const depositBlock = await ethers.provider.getBlock("latest");
    const depositFee = managementFeeSharesWithRemainder(
      supplyBeforeDeposit,
      100,
      BigInt(depositBlock.timestamp) - lastBeforeDeposit
    );
    expect(await vault.balanceOf(feeRecipient.address)).to.equal(depositFee.shares);

    const sharesToRedeem = usdc("100");
    const assets = usdc("98");
    const supplyBeforeRedeem = await vault.totalSupply();
    const lastBeforeRedeem = await vault.lastManagementFeeAccruedAt();
    await network.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
    await network.provider.send("evm_mine");
    await requestRedeemWithQuote(vault, ap, investor, "lazy-fee-redeem", {
      controller: investor.address,
      owner: investor.address,
      receiver: receiver.address,
      shares: sharesToRedeem,
      assets
    });
    const redeemBlock = await ethers.provider.getBlock("latest");
    const redeemFee = managementFeeSharesWithRemainder(
      supplyBeforeRedeem,
      100,
      BigInt(redeemBlock.timestamp) - lastBeforeRedeem,
      depositFee.remainder
    );
    expect(await vault.balanceOf(feeRecipient.address)).to.equal(depositFee.shares + redeemFee.shares);
    expect(await pusd.balanceOf(receiver.address)).to.equal(assets);
  });

  it("preserves zero-share management fee accrual across permissionless checkpoints", async function () {
    const { manager, ap, investor, other, feeRecipient, vault } = await deployFixture();
    await depositWithQuote(vault, ap, ap, investor, "zero-accrual-seed", usdc("1"));
    await vault.connect(manager).setManagementFee(500, feeRecipient.address);

    let remainder = 0n;
    let totalMinted = 0n;
    for (let index = 0; index < 4; index++) {
      const supply = await vault.totalSupply();
      const previousTimestamp = await vault.lastManagementFeeAccruedAt();
      await network.provider.send("evm_increaseTime", [200]);
      const tx = await vault.connect(other).accrueManagementFee();
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      const expected = managementFeeSharesWithRemainder(
        supply,
        500,
        BigInt(block.timestamp) - previousTimestamp,
        remainder
      );
      if (index === 0) {
        expect(expected.shares).to.equal(0n);
      }
      remainder = expected.remainder;
      totalMinted += expected.shares;
      expect(await vault.lastManagementFeeAccruedAt()).to.equal(BigInt(block.timestamp));
      expect(await vault.balanceOf(feeRecipient.address)).to.equal(totalMinted);
    }

    expect(totalMinted).to.be.greaterThan(0n);
  });

  it("does not retroactively charge new deposits after zero-share fee checkpoints", async function () {
    const { manager, ap, investor, other, feeRecipient, vault } = await deployFixture();
    await depositWithQuote(vault, ap, ap, investor, "zero-deposit-seed", usdc("1"));
    await vault.connect(manager).setManagementFee(500, feeRecipient.address);

    const previousTimestamp = await vault.lastManagementFeeAccruedAt();
    await network.provider.send("evm_increaseTime", [200]);
    const checkpointTx = await vault.connect(other).accrueManagementFee();
    const checkpointReceipt = await checkpointTx.wait();
    const checkpointBlock = await ethers.provider.getBlock(checkpointReceipt.blockNumber);
    expect(await vault.balanceOf(feeRecipient.address)).to.equal(0n);
    expect(await vault.lastManagementFeeAccruedAt()).to.equal(BigInt(checkpointBlock.timestamp));
    expect(
      managementFeeShares(usdc("1"), 500, BigInt(checkpointBlock.timestamp) - previousTimestamp)
    ).to.equal(0n);

    const investorSharesBefore = await vault.balanceOf(investor.address);
    await depositWithQuote(vault, ap, ap, investor, "zero-deposit-followup", usdc("1"));
    expect((await vault.balanceOf(investor.address)) - investorSharesBefore).to.equal(usdc("1"));
    expect(await vault.balanceOf(feeRecipient.address)).to.equal(0n);
  });

  it("checkpoints zero-share fees under the old rate before management fee changes", async function () {
    const { manager, ap, investor, receiver, feeRecipient, vault } = await deployFixture();
    await depositWithQuote(vault, ap, ap, investor, "zero-config-seed", usdc("1"));
    await vault.connect(manager).setManagementFee(100, feeRecipient.address);

    const oldSupply = await vault.totalSupply();
    const oldTimestamp = await vault.lastManagementFeeAccruedAt();
    await network.provider.send("evm_increaseTime", [1000]);
    const setTx = await vault.connect(manager).setManagementFee(500, receiver.address);
    const setReceipt = await setTx.wait();
    const setBlock = await ethers.provider.getBlock(setReceipt.blockNumber);
    const oldExpected = managementFeeSharesWithRemainder(
      oldSupply,
      100,
      BigInt(setBlock.timestamp) - oldTimestamp
    );
    expect(oldExpected.shares).to.equal(0n);
    expect(await vault.balanceOf(feeRecipient.address)).to.equal(0n);
    expect(await vault.lastManagementFeeAccruedAt()).to.equal(BigInt(setBlock.timestamp));
    expect(await vault.managementFeeBps()).to.equal(500);
    expect(await vault.managementFeeRecipient()).to.equal(receiver.address);

    const newSupply = await vault.totalSupply();
    const newTimestamp = await vault.lastManagementFeeAccruedAt();
    await network.provider.send("evm_increaseTime", [440]);
    const accrueTx = await vault.accrueManagementFee();
    const accrueReceipt = await accrueTx.wait();
    const accrueBlock = await ethers.provider.getBlock(accrueReceipt.blockNumber);
    const newExpected = managementFeeSharesWithRemainder(
      newSupply,
      500,
      BigInt(accrueBlock.timestamp) - newTimestamp,
      oldExpected.remainder
    );
    const newOnlyExpected = managementFeeSharesWithRemainder(
      newSupply,
      500,
      BigInt(accrueBlock.timestamp) - newTimestamp
    );
    expect(newOnlyExpected.shares).to.equal(0n);
    expect(await vault.balanceOf(receiver.address)).to.equal(newExpected.shares);
    expect(newExpected.shares).to.be.greaterThan(newOnlyExpected.shares);
  });

  it("pushes immediately payable AP redemptions and pays AP spread outside the vault", async function () {
    const { ap, investor, receiver, feeRecipient, pusd, vault } = await deployFixture();
    await depositWithQuote(vault, ap, ap, investor, "redeem-immediate-seed", usdc("1000"));

    await expect(vault.previewRedeem(usdc("1"))).to.be.revertedWithCustomError(vault, "AsyncPreviewUnavailable");
    await expect(vault.previewWithdraw(usdc("1"))).to.be.revertedWithCustomError(vault, "AsyncPreviewUnavailable");

    const shares = usdc("300");
    const grossAssets = await vault.convertToAssets(shares);
    const owedAssets = grossAssets - usdc("3");
    const requestAuth = await redeemAuth(vault, "immediate-request", {
      controller: investor.address,
      owner: investor.address,
      receiver: receiver.address,
      shares,
      assets: owedAssets
    });

    await expect(vault.connect(investor).requestRedeemWithAPQuote(requestAuth, await signAPRedeemQuote(ap, vault, requestAuth)))
      .to.emit(vault, "RedeemRequest")
      .withArgs(investor.address, investor.address, 1, investor.address, shares)
      .and.to.emit(vault, "APQuoteRedeemRequest")
      .withArgs(
        requestAuth.quoteId,
        requestAuth.nonce,
        ap.address,
        investor.address,
        investor.address,
        receiver.address,
        shares,
        owedAssets,
        1,
        feeRecipient.address,
        grossAssets - owedAssets
      )
      .and.to.emit(vault, "RedemptionPaid")
      .withArgs(1, receiver.address, owedAssets, 0)
      .and.to.emit(vault, "APFeePaid")
      .withArgs(1, feeRecipient.address, grossAssets - owedAssets, 0)
      .and.to.emit(vault, "RedemptionCompleted")
      .withArgs(1);

    const request = await vault.redemptionRequest(1);
    expect(request.grossAssets).to.equal(grossAssets);
    expect(request.assets).to.equal(owedAssets);
    expect(request.paidAssets).to.equal(owedAssets);
    expect(request.remainingAssets).to.equal(0n);
    expect(await vault.pendingRedemptionAssets()).to.equal(0n);
    expect(await vault.balanceOf(investor.address)).to.equal(usdc("700"));
    expect(await pusd.balanceOf(receiver.address)).to.equal(owedAssets);
    expect(await pusd.balanceOf(feeRecipient.address)).to.equal(grossAssets - owedAssets);
    expect(await vault.totalAssets()).to.equal(usdc("700"));

    await expect(vault.connect(investor).requestRedeemWithAPQuote(requestAuth, await signAPRedeemQuote(ap, vault, requestAuth)))
      .to.be.revertedWithCustomError(vault, "APQuoteAlreadyUsed")
      .withArgs(anyValue);
  });

  it("queues FIFO redemptions and pays them when liquid capital is available", async function () {
    const { manager, ap, investor, receiver, feeRecipient, tradingWallet, vault, pusd } = await deployFixture({
      mandateOverrides: { minVaultCashBuffer: usdc("1000") }
    });
    await depositWithQuote(vault, ap, ap, investor, "redeem-queue-seed", usdc("1000"));

    const shares = usdc("300");
    const grossAssets = await vault.convertToAssets(shares);
    const owedAssets = grossAssets - usdc("3");
    const requestAuth = await redeemAuth(vault, "queued-request", {
      controller: investor.address,
      owner: investor.address,
      receiver: receiver.address,
      shares,
      assets: owedAssets
    });
    await vault.connect(investor).requestRedeemWithAPQuote(requestAuth, await signAPRedeemQuote(ap, vault, requestAuth));

    let request = await vault.redemptionRequest(1);
    expect(request.remainingAssets).to.equal(owedAssets);
    expect(await vault.pendingRedemptionAssets()).to.equal(grossAssets);
    expect(await pusd.balanceOf(receiver.address)).to.equal(0n);
    expect(await vault.pendingRedeemRequest(1, investor.address)).to.equal(shares);

    await vault.connect(manager).updateOrderMandate(baseMandate(tradingWallet.address, { minVaultCashBuffer: 0n }));
    await expect(vault.processRedemptions(1))
      .to.emit(vault, "RedemptionPaid")
      .withArgs(1, receiver.address, owedAssets, 0)
      .and.to.emit(vault, "APFeePaid")
      .withArgs(1, feeRecipient.address, usdc("3"), 0)
      .and.to.emit(vault, "RedemptionCompleted")
      .withArgs(1);

    request = await vault.redemptionRequest(1);
    expect(request.paidAssets).to.equal(owedAssets);
    expect(request.remainingAssets).to.equal(0n);
    expect(await vault.pendingRedemptionAssets()).to.equal(0n);
    expect(await pusd.balanceOf(receiver.address)).to.equal(owedAssets);
    expect(await pusd.balanceOf(feeRecipient.address)).to.equal(usdc("3"));
  });

  it("pays queued investor and AP claims proportionally and snapshots the recipient", async function () {
    const { manager, ap, investor, receiver, feeRecipient, other, tradingWallet, vault, pusd } =
      await deployFixture({ mandateOverrides: { minVaultCashBuffer: usdc("1000") } });
    await depositWithQuote(vault, ap, ap, investor, "proportional-seed", usdc("1000"));

    const shares = usdc("300");
    const grossAssets = await vault.convertToAssets(shares);
    const userAssets = grossAssets - usdc("3");
    await requestRedeemWithQuote(vault, ap, investor, "proportional-request", {
      controller: investor.address,
      owner: investor.address,
      receiver: receiver.address,
      shares,
      assets: userAssets
    });
    await vault.connect(ap).setMyFeeRecipient(other.address);

    await vault
      .connect(manager)
      .updateOrderMandate(baseMandate(tradingWallet.address, { minVaultCashBuffer: usdc("900") }));
    await expect(vault.processRedemptions(1))
      .to.emit(vault, "RedemptionPaid")
      .withArgs(1, receiver.address, usdc("99"), usdc("198"))
      .and.to.emit(vault, "APFeePaid")
      .withArgs(1, feeRecipient.address, usdc("1"), usdc("2"));
    expect(await vault.pendingRedemptionAssets()).to.equal(usdc("200"));
    expect(await pusd.balanceOf(feeRecipient.address)).to.equal(usdc("1"));
    expect(await pusd.balanceOf(other.address)).to.equal(0n);

    await vault
      .connect(manager)
      .updateOrderMandate(baseMandate(tradingWallet.address, { minVaultCashBuffer: 0n }));
    await expect(vault.processRedemptions(1))
      .to.emit(vault, "RedemptionPaid")
      .withArgs(1, receiver.address, usdc("198"), 0)
      .and.to.emit(vault, "APFeePaid")
      .withArgs(1, feeRecipient.address, usdc("2"), 0)
      .and.to.emit(vault, "RedemptionCompleted")
      .withArgs(1);

    expect(await pusd.balanceOf(receiver.address)).to.equal(userAssets);
    expect(await pusd.balanceOf(feeRecipient.address)).to.equal(usdc("3"));
    expect(await vault.pendingRedemptionAssets()).to.equal(0n);
  });

  it("conserves randomized deposits, fee accrual, recipient rotations, NAV reports, and partial redemptions", async function () {
    const fixture = await deployFixture();
    const {
      admin,
      manager,
      navReporter,
      ap,
      ap2,
      investor,
      receiver,
      feeRecipient,
      other,
      tradingWallet,
      vault
    } = fixture;
    await vault.connect(admin).setManagementFee(200, feeRecipient.address);

    let randomState = 0x5eed1234n;
    const random = (limit) => {
      randomState = (randomState * 1103515245n + 12345n) % 0x80000000n;
      return randomState % BigInt(limit);
    };
    const spreadOptions = [0n, 100n, 300n];

    for (let iteration = 0; iteration < 8; iteration += 1) {
      await network.provider.send("evm_increaseTime", [
        Number(60n + random(3_540))
      ]);
      await network.provider.send("evm_mine");
      const published = await publishCustomBasket(
        fixture,
        510_000n + BigInt(iteration),
        (asOf) => [basketConstituent(1001n, asOf)]
      );
      await vault
        .connect(navReporter)
        .reportTradingAssets(
          0,
          published.header.basketHash,
          published.header.roundId,
          published.header.asOf,
          hashText(`randomized-nav-${iteration}`)
        );

      const quoteAP = random(2) === 0n ? ap : ap2;
      const snapshottedRecipient =
        random(2) === 0n ? feeRecipient : other;
      await vault
        .connect(quoteAP)
        .setMyFeeRecipient(snapshottedRecipient.address);
      const depositGross = 1_000_000n + random(4_000_001);
      const depositBps = spreadOptions[Number(random(spreadOptions.length))];
      const depositFee = depositGross * depositBps / 10_000n;
      await depositWithQuote(
        vault,
        quoteAP,
        quoteAP,
        investor,
        `randomized-deposit-${iteration}`,
        depositGross,
        { spreadAssets: depositFee }
      );

      const investorShares = await vault.balanceOf(investor.address);
      const redeemShares =
        investorShares * (25n + random(51)) / 100n || 1n;
      const grossAssets = await vault.convertToAssets(redeemShares);
      const redemptionBps =
        spreadOptions[Number(random(spreadOptions.length))];
      const apFeeAssets = grossAssets * redemptionBps / 10_000n;
      const userAssets = grossAssets - apFeeAssets;
      const liquid = await vault.liquidAssets();
      const firstPayment = grossAssets / 2n;
      await vault
        .connect(manager)
        .updateOrderMandate(
          baseMandate(tradingWallet.address, {
            minVaultCashBuffer: liquid > firstPayment
              ? liquid - firstPayment
              : 0n
          })
        );

      const requestId = await vault.nextRedemptionRequestId();
      const requestTx = await requestRedeemWithQuote(
        vault,
        quoteAP,
        investor,
        `randomized-redeem-${iteration}`,
        {
          controller: investor.address,
          owner: investor.address,
          receiver: receiver.address,
          shares: redeemShares,
          assets: userAssets
        }
      );
      const receipts = [await requestTx.wait()];
      if ((await vault.pendingRedemptionAssets()) > 0n) {
        await vault
          .connect(manager)
          .updateOrderMandate(baseMandate(tradingWallet.address));
        receipts.push(await (await vault.processRedemptions(1)).wait());
      }

      const events = receipts.flatMap((receipt) =>
        receipt.logs
          .map((log) => {
            try {
              return vault.interface.parseLog(log);
            } catch (_error) {
              return null;
            }
          })
          .filter(Boolean)
      );
      const userPaid = events
        .filter(
          (event) =>
            event.name === "RedemptionPaid"
            && event.args.requestId === requestId
        )
        .reduce((total, event) => total + event.args.assets, 0n);
      const apPaid = events
        .filter(
          (event) =>
            event.name === "APFeePaid"
            && event.args.requestId === requestId
        )
        .reduce((total, event) => {
          expect(event.args.recipient).to.equal(
            snapshottedRecipient.address
          );
          return total + event.args.assets;
        }, 0n);
      const quoteEvent = events.find(
        (event) =>
          event.name === "APQuoteRedeemRequest"
          && event.args.requestId === requestId
      );
      expect(quoteEvent.args.apFeeRecipient).to.equal(
        snapshottedRecipient.address
      );
      expect(quoteEvent.args.apFeeAssets).to.equal(apFeeAssets);
      expect(userPaid).to.equal(userAssets);
      expect(apPaid).to.equal(apFeeAssets);
      expect(userPaid + apPaid).to.equal(grossAssets);

      const queued = await vault.redemptionRequest(requestId);
      expect(queued.assets).to.equal(userAssets);
      expect(queued.paidAssets).to.equal(userAssets);
      expect(queued.remainingAssets).to.equal(0n);
      expect(await vault.pendingRedemptionAssets()).to.equal(0n);
    }
  });

  it("enforces the 300 bps AP spread ceiling on deposits and redemptions", async function () {
    const { ap, investor, receiver, pusd, vault } = await deployFixture();
    await depositWithQuote(vault, ap, ap, investor, "spread-cap-pass", usdc("100"), {
      spreadAssets: usdc("3")
    });
    await expect(
      depositWithQuote(vault, ap, ap, investor, "spread-cap-fail", usdc("100"), {
        spreadAssets: usdc("3.000001")
      })
    ).to.be.revertedWithCustomError(vault, "InvalidAmount");

    const shares = usdc("10");
    const grossAssets = await vault.convertToAssets(shares);
    const passing = await redeemAuth(vault, "redeem-spread-cap-pass", {
      controller: investor.address,
      owner: investor.address,
      receiver: receiver.address,
      shares,
      assets: grossAssets - (grossAssets * 3n / 100n)
    });
    await vault
      .connect(investor)
      .requestRedeemWithAPQuote(passing, await signAPRedeemQuote(ap, vault, passing));

    const failingShares = usdc("10");
    const failingGross = await vault.convertToAssets(failingShares);
    const failing = await redeemAuth(vault, "redeem-spread-cap-fail", {
      controller: investor.address,
      owner: investor.address,
      receiver: receiver.address,
      shares: failingShares,
      assets: failingGross - (failingGross * 3n / 100n) - 1n
    });
    await expect(
      vault
        .connect(investor)
        .requestRedeemWithAPQuote(failing, await signAPRedeemQuote(ap, vault, failing))
    ).to.be.revertedWithCustomError(vault, "InvalidAmount");
    expect(await pusd.balanceOf(receiver.address)).to.be.greaterThan(0n);
  });

  for (const dustSupply of [127n, 19n, 1n]) {
    it(`does not transfer a redemption spread to ${dustSupply} remaining share base units`, async function () {
      const { ap, investor, receiver, feeRecipient, pusd, vault } = await deployFixture();
      const seedAssets = 1_000_000n + dustSupply;
      await depositWithQuote(vault, ap, ap, investor, `dust-regression-${dustSupply}`, seedAssets);
      await vault.connect(investor).transfer(feeRecipient.address, dustSupply);

      const shares = 1_000_000n;
      const grossAssets = await vault.convertToAssets(shares);
      const apFeeAssets = grossAssets / 100n;
      await requestRedeemWithQuote(vault, ap, investor, `dust-redeem-${dustSupply}`, {
        controller: investor.address,
        owner: investor.address,
        receiver: receiver.address,
        shares,
        assets: grossAssets - apFeeAssets
      });

      expect(await vault.totalSupply()).to.equal(dustSupply);
      expect(await vault.totalAssets()).to.be.lessThanOrEqual(dustSupply + 1n);
      expect(await vault.convertToAssets(dustSupply)).to.be.lessThanOrEqual(dustSupply + 1n);
      expect(await pusd.balanceOf(feeRecipient.address)).to.equal(apFeeAssets);
    });
  }

  it("rejects invalid AP-signed redemption requests while the fund is open", async function () {
    const { ap, investor, other, receiver, vault } = await deployFixture();
    await depositWithQuote(vault, ap, ap, investor, "redeem-invalid-seed", usdc("1000"));

    const base = {
      controller: investor.address,
      owner: investor.address,
      receiver: receiver.address,
      shares: usdc("25"),
      assets: await vault.convertToAssets(usdc("25"))
    };
    const valid = await redeemAuth(vault, "redeem-valid", base);
    await expect(
      vault.connect(investor).requestRedeemWithAPQuote(valid, await signAPRedeemQuote(other, vault, valid))
    )
      .to.be.revertedWithCustomError(vault, "UnauthorizedAPQuoteSigner")
      .withArgs(other.address);

    const block = await ethers.provider.getBlock("latest");
    const expired = await redeemAuth(vault, "redeem-expired", base, {
      deadline: BigInt(block.timestamp - 1)
    });
    await expect(
      vault.connect(investor).requestRedeemWithAPQuote(expired, await signAPRedeemQuote(ap, vault, expired))
    )
      .to.be.revertedWithCustomError(vault, "ExpiredAPQuote")
      .withArgs(expired.deadline);

    const tooRich = await redeemAuth(vault, "redeem-too-rich", {
      ...base,
      assets: (await vault.convertToAssets(usdc("25"))) + 1n
    });
    await expect(
      vault.connect(investor).requestRedeemWithAPQuote(tooRich, await signAPRedeemQuote(ap, vault, tooRich))
    )
      .to.be.revertedWithCustomError(vault, "ExcessiveAPQuoteAssets")
      .withArgs(tooRich.assets, await vault.convertToAssets(tooRich.shares));
  });

  it("supports operators for redemption requests", async function () {
    const { ap, investor, operator, receiver, pusd, vault } = await deployFixture();
    await depositWithQuote(vault, ap, ap, investor, "operator-seed", usdc("1000"));

    const operatorAuth = await redeemAuth(vault, "operator-request", {
      controller: investor.address,
      owner: investor.address,
      receiver: receiver.address,
      shares: usdc("50"),
      assets: await vault.convertToAssets(usdc("50"))
    });
    await expect(
      vault
        .connect(operator)
        .requestRedeemWithAPQuote(operatorAuth, await signAPRedeemQuote(ap, vault, operatorAuth))
    )
      .to.be.revertedWithCustomError(vault, "ERC20InsufficientAllowance");

    await expect(vault.connect(investor).setOperator(operator.address, true))
      .to.emit(vault, "OperatorSet")
      .withArgs(investor.address, operator.address, true);
    expect(await vault.isOperator(investor.address, operator.address)).to.equal(true);

    await vault
      .connect(operator)
      .requestRedeemWithAPQuote(operatorAuth, await signAPRedeemQuote(ap, vault, operatorAuth));
    expect(await pusd.balanceOf(receiver.address)).to.equal(operatorAuth.assets);
    expect(await vault.pendingRedemptionAssets()).to.equal(0n);
  });

  it("accepts only fresh oracle-matching NAV reports and prices later deposits from total assets", async function () {
    const { navReporter, ap, investor, vault, basket } = await deployFixture();
    await depositWithQuote(vault, ap, ap, investor, "nav-pricing-seed", usdc("1000"));

    await expect(
      vault
        .connect(navReporter)
        .reportTradingAssets(usdc("100"), ethers.ZeroHash, basket.header.roundId, basket.header.asOf, hashText("bad"))
    ).to.be.revertedWithCustomError(vault, "InvalidReport");

    await expect(
      vault
        .connect(navReporter)
        .reportTradingAssets(usdc("100"), hashText("wrong"), basket.header.roundId, basket.header.asOf, hashText("bad"))
    ).to.be.revertedWithCustomError(vault, "OracleReferenceMismatch");

    await expect(
      vault
        .connect(navReporter)
        .reportTradingAssets(
          usdc("100"),
          basket.header.basketHash,
          basket.header.roundId,
          basket.header.asOf,
          hashText("nav-1")
        )
    )
      .to.emit(vault, "TradingAssetsReported")
      .withArgs(usdc("100"), basket.header.basketHash, basket.header.roundId, basket.header.asOf, hashText("nav-1"));
    const report = await vault.latestTradingAssetsReport();
    expect(await vault.totalAssets()).to.equal(usdc("1100"));
    expect(report.externalAssets).to.equal(usdc("100"));
    expect(report.basketHash).to.equal(basket.header.basketHash);
    expect(report.oracleRoundId).to.equal(basket.header.roundId);
    expect(report.asOf).to.equal(basket.header.asOf);
    expect(report.reportedAt).to.be.greaterThan(0n);
    expect(report.reportHash).to.equal(hashText("nav-1"));

    const expectedShares = await vault.previewDeposit(usdc("110"));
    const beforeShares = await vault.balanceOf(investor.address);
    await depositWithQuote(vault, ap, ap, investor, "nav-followup-seed", usdc("110"));
    expect((await vault.balanceOf(investor.address)) - beforeShares).to.equal(expectedShares);
  });

  it("commits buy intents and lets approved solvers fill atomically", async function () {
    const { admin, manager, ap, other: solver, receiver: secondSolver, pusd, conditionalTokens, vault, basket } =
      await deployFixture();
    await depositWithQuote(vault, ap, ap, admin, "buy-intent-seed", usdc("1000"));
    await vault.connect(admin).grantRole(await vault.SOLVER_ROLE(), solver.address);
    await vault.connect(admin).grantRole(await vault.SOLVER_ROLE(), secondSolver.address);

    await expect(commitBatch(vault, manager)).to.emit(vault, "OrderIntentBatchCommitted");
    const batch = await vault.activeOrderIntentBatch();
    expect(batch.basketHash).to.equal(basket.header.basketHash);
    expect(await vault.latestOrderIntentCount()).to.equal(2n);

    const intentHash = await vault.latestOrderIntentHash(0);
    const intent = await vault.solverOrderIntents(intentHash);
    expect(intent.side).to.equal(1);
    expect(intent.tokenId).to.equal(1001n);

    const fillSize = usdc("10");
    await conditionalTokens.mint(solver.address, intent.tokenId, fillSize);
    await conditionalTokens.connect(solver).setApprovalForAll(await vault.getAddress(), true);
    const solverPusdBefore = await pusd.balanceOf(solver.address);

    await expect(vault.connect(solver).fulfillBuyIntent(batch.batchId, intentHash, fillSize, intent.priceE18))
      .to.emit(vault, "SolverOrderIntentFulfilled")
      .withArgs(batch.batchId, intentHash, solver.address, 1, intent.tokenId, fillSize, intent.priceE18, anyValue);

    const updated = await vault.solverOrderIntents(intentHash);
    expect(updated.remainingSize).to.equal(intent.remainingSize - fillSize);
    expect(await conditionalTokens.balanceOf(await vault.getAddress(), intent.tokenId)).to.equal(fillSize);
    expect(await pusd.balanceOf(solver.address)).to.be.greaterThan(solverPusdBefore);

    const secondFillSize = usdc("1");
    await conditionalTokens.mint(secondSolver.address, intent.tokenId, secondFillSize);
    await conditionalTokens.connect(secondSolver).setApprovalForAll(await vault.getAddress(), true);
    await expect(vault.connect(secondSolver).fulfillBuyIntent(batch.batchId, intentHash, secondFillSize, intent.priceE18))
      .to.emit(vault, "SolverOrderIntentFulfilled")
      .withArgs(batch.batchId, intentHash, secondSolver.address, 1, intent.tokenId, secondFillSize, intent.priceE18, anyValue);

    await expect(
      vault.connect(solver).fulfillBuyIntent(batch.batchId, intentHash, updated.remainingSize + 1n, intent.priceE18)
    ).to.be.revertedWithCustomError(vault, "IntentOverfill");
    await expect(
      vault.connect(solver).fulfillBuyIntent(batch.batchId, intentHash, 1n, intent.priceE18 + 1n)
    ).to.be.revertedWithCustomError(vault, "PriceBoundViolation");
  });

  it("rejects arbitrary inbound ERC-1155 transfers", async function () {
    const { investor, conditionalTokens, vault } = await deployFixture();
    const vaultAddress = await vault.getAddress();

    await conditionalTokens.mint(investor.address, 4242n, usdc("1"));
    await expect(
      conditionalTokens
        .connect(investor)
        .safeTransferFrom(investor.address, vaultAddress, 4242n, usdc("1"), "0x")
    )
      .to.be.revertedWithCustomError(vault, "UnauthorizedERC1155Transfer");

    await conditionalTokens.mint(investor.address, 4243n, usdc("1"));
    await expect(
      conditionalTokens
        .connect(investor)
        .safeBatchTransferFrom(investor.address, vaultAddress, [4243n], [usdc("1")], "0x")
    )
      .to.be.revertedWithCustomError(vault, "UnauthorizedERC1155Transfer");
  });

  it("blocks trading paths before bootstrap even when raw pUSD exists", async function () {
    const { admin, manager, other: solver, pusd, vault } = await deployFixture();
    await pusd.mint(solver.address, usdc("10"));
    await pusd.connect(solver).transfer(await vault.getAddress(), usdc("10"));
    await vault.connect(admin).grantRole(await vault.SOLVER_ROLE(), solver.address);

    await expect(commitBatch(vault, manager))
      .to.be.revertedWithCustomError(vault, "VaultNotBootstrapped");
    await expect(vault.connect(manager).commitOrderIntentBatchFor(hashText("basket"), 1n))
      .to.be.revertedWithCustomError(vault, "VaultNotBootstrapped");
    await expect(vault.connect(solver).fulfillBuyIntent(hashText("batch"), hashText("buy"), 1n, 1n))
      .to.be.revertedWithCustomError(vault, "VaultNotBootstrapped");
    await expect(vault.connect(solver).fulfillSellIntent(hashText("batch"), hashText("sell"), 1n, 1n))
      .to.be.revertedWithCustomError(vault, "VaultNotBootstrapped");
  });

  it("requires order committer role and supports expected oracle round guards", async function () {
    const { admin, manager, ap, other, vault, basket } = await deployFixture();
    await depositWithQuote(vault, ap, ap, admin, "commit-role-seed", usdc("1000"));

    await expect(commitBatch(vault, other))
      .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount")
      .withArgs(other.address, await vault.ORDER_COMMITTER_ROLE());

    await expect(vault.connect(manager).commitOrderIntentBatchFor(hashText("wrong"), basket.header.roundId))
      .to.be.revertedWithCustomError(vault, "OracleReferenceMismatch")
      .withArgs(basket.header.basketHash, basket.header.roundId);

    await expect(vault.connect(manager).commitOrderIntentBatchFor(basket.header.basketHash, basket.header.roundId))
      .to.emit(vault, "OrderIntentBatchCommitted");
  });

  it("commits sell intents and lets approved solvers buy vault-held positions atomically", async function () {
    const fixture = await deployFixture();
    const { admin, manager, ap, other: solver, pusd, conditionalTokens, vault } = fixture;
    const tokenId = 1001n;
    await depositWithQuote(vault, ap, ap, admin, "sell-intent-seed", usdc("1000"));
    await acquireViaBuyIntent(fixture, tokenId, usdc("1000"));
    await publishCustomBasket(fixture, 490100n, (asOf) => [
      basketConstituent(1001n, asOf, { weightE18: 10000000000000000n }),
      basketConstituent(1002n, asOf, { weightE18: 990000000000000000n, outcomeSide: 2 })
    ]);
    await pusd.mint(solver.address, usdc("1000"));
    await pusd.connect(solver).approve(await vault.getAddress(), ethers.MaxUint256);

    await expect(commitBatch(vault, manager)).to.emit(vault, "OrderIntentBatchCommitted");
    const batch = await vault.activeOrderIntentBatch();
    let intentHash;
    let intent;
    const intentCount = Number(await vault.latestOrderIntentCount());
    for (let index = 0; index < intentCount; index++) {
      const candidateHash = await vault.latestOrderIntentHash(index);
      const candidate = await vault.solverOrderIntents(candidateHash);
      if (Number(candidate.side) === 2 && candidate.tokenId === tokenId) {
        intentHash = candidateHash;
        intent = candidate;
        break;
      }
    }
    expect(intentHash).to.not.equal(undefined);
    expect(intent.side).to.equal(2);
    expect(intent.tokenId).to.equal(tokenId);

    const fillSize = usdc("5");
    const vaultPusdBefore = await pusd.balanceOf(await vault.getAddress());
    await expect(vault.connect(solver).fulfillSellIntent(batch.batchId, intentHash, fillSize, intent.priceE18))
      .to.emit(vault, "SolverOrderIntentFulfilled")
      .withArgs(batch.batchId, intentHash, solver.address, 2, tokenId, fillSize, intent.priceE18, anyValue);

    expect(await conditionalTokens.balanceOf(solver.address, tokenId)).to.equal(fillSize);
    expect(await pusd.balanceOf(await vault.getAddress())).to.be.greaterThan(vaultPusdBefore);
  });

  it("emits residual sell intents for removed held tokens and lets solvers fill them", async function () {
    const fixture = await deployFixture();
    const { admin, manager, ap, other: solver, conditionalTokens, pusd, vault } = fixture;
    await depositWithQuote(vault, ap, ap, admin, "residual-seed", usdc("1000"));
    await vault.connect(admin).grantRole(await vault.SOLVER_ROLE(), solver.address);
    await acquireRemovedResidualPosition(fixture, 9999n, usdc("1000"));
    await pusd.mint(solver.address, usdc("10"));
    await pusd.connect(solver).approve(await vault.getAddress(), ethers.MaxUint256);

    const { committed } = await commitResidual(vault, manager, [9999n]);
    expect(committed).to.not.equal(undefined);
    const batchId = committed.args.batchId;
    const intentHash = committed.args.intentHash;
    expect(committed.args.tokenId).to.equal(9999n);
    expect(committed.args.priceE18).to.equal(1000000000000000n);
    expect(committed.args.remainingSize).to.equal(usdc("1000"));

    await expect(
      vault.connect(solver).fulfillResidualSellIntent(batchId, intentHash, usdc("1000"), 2000000000000000n)
    )
      .to.emit(vault, "ResidualSellIntentFulfilled")
      .withArgs(batchId, intentHash, solver.address, 9999n, usdc("1000"), 2000000000000000n, usdc("2"));

    expect(await conditionalTokens.balanceOf(await vault.getAddress(), 9999n)).to.equal(0n);
    expect(await conditionalTokens.balanceOf(solver.address, 9999n)).to.equal(usdc("1000"));
    expect(await pusd.balanceOf(await vault.getAddress())).to.be.greaterThan(usdc("0"));
  });

  it("does not reemit a residual intent while the previous one is still open", async function () {
    const fixture = await deployFixture();
    const { admin, manager, ap, vault } = fixture;
    await depositWithQuote(vault, ap, ap, admin, "residual-open-seed", usdc("1000"));
    await acquireRemovedResidualPosition(fixture, 9999n, usdc("1000"));

    expect((await commitResidual(vault, manager, [9999n])).committed).to.not.equal(undefined);
    expect((await commitResidual(vault, manager, [9999n])).committed).to.equal(undefined);
  });

  it("does not emit residual intents for current basket constituents", async function () {
    const fixture = await deployFixture();
    const { admin, manager, ap, vault } = fixture;
    await depositWithQuote(vault, ap, ap, admin, "current-residual-seed", usdc("1000"));
    await acquireViaBuyIntent(fixture, 1001n, usdc("1000"));

    const { events } = await commitResidual(vault, manager, [1001n]);
    expect(events.some((event) => event.name === "ResidualSellIntentCommitted")).to.equal(false);
    const batch = events.find((event) => event.name === "ResidualLiquidationBatchCommitted");
    expect(batch.args.intentCount).to.equal(0n);
  });

  it("rejects empty or overlarge residual candidate lists", async function () {
    const { admin, ap, manager, vault } = await deployFixture();
    await depositWithQuote(vault, ap, ap, admin, "residual-candidate-bound-seed", usdc("1000"));
    await expect(vault.connect(manager).commitResidualLiquidationBatch([]))
      .to.be.revertedWithCustomError(vault, "InvalidAmount");
    await expect(
      vault.connect(manager).commitResidualLiquidationBatch(Array.from({ length: 26 }, (_, index) => BigInt(index + 1)))
    )
      .to.be.revertedWithCustomError(vault, "InvalidAmount");
  });

  it("skips unknown candidates and closes known zero-balance candidates", async function () {
    const fixture = await deployFixture();
    const { admin, ap, manager, vault } = fixture;
    await depositWithQuote(vault, ap, ap, admin, "residual-zero-balance-seed", usdc("1000"));
    await vault.connect(manager).registerResidualToken(5555n);

    const { events } = await commitResidual(vault, manager, [4444n, 5555n]);
    expect(events.some((event) => event.name === "ResidualSellIntentCommitted")).to.equal(false);
    expect(events.some((event) => event.name === "ResidualInventoryClosed" && event.args.tokenId === 5555n))
      .to.equal(true);
    const batch = events.find((event) => event.name === "ResidualLiquidationBatchCommitted");
    expect(batch.args.intentCount).to.equal(0n);
  });

  it("does not create duplicate residual intents for duplicate candidates", async function () {
    const fixture = await deployFixture();
    const { admin, manager, ap, vault } = fixture;
    await depositWithQuote(vault, ap, ap, admin, "residual-duplicate-seed", usdc("1000"));
    await acquireRemovedResidualPosition(fixture, 6666n, usdc("1000"));

    const { events } = await commitResidual(vault, manager, [6666n, 6666n]);
    const committed = events.filter((event) => event.name === "ResidualSellIntentCommitted");
    expect(committed).to.have.length(1);
    expect(committed[0].args.tokenId).to.equal(6666n);
    const batch = events.find((event) => event.name === "ResidualLiquidationBatchCommitted");
    expect(batch.args.intentCount).to.equal(1n);
  });

  it("rejects residual fills below the floor, over the remainder, after expiry, and on replay", async function () {
    const fixture = await deployFixture({
      mandateOverrides: { orderExpirySeconds: 300 }
    });
    const { admin, manager, ap, other: solver, pusd, vault } = fixture;
    await depositWithQuote(vault, ap, ap, admin, "residual-guard-seed", usdc("1000"));
    await vault.connect(admin).grantRole(await vault.SOLVER_ROLE(), solver.address);
    await acquireRemovedResidualPosition(fixture, 9999n, usdc("1000"));
    await pusd.mint(solver.address, usdc("100"));
    await pusd.connect(solver).approve(await vault.getAddress(), ethers.MaxUint256);

    let first = (await commitResidual(vault, manager, [9999n])).committed;
    let batchId = first.args.batchId;
    let intentHash = first.args.intentHash;
    let remainingSize = first.args.remainingSize;
    let priceE18 = first.args.priceE18;

    await expect(
      vault.connect(solver).fulfillResidualSellIntent(batchId, intentHash, 1n, 999999999999999n)
    ).to.be.revertedWithCustomError(vault, "ResidualPriceTooLow");
    await expect(
      vault.connect(solver).fulfillResidualSellIntent(batchId, intentHash, remainingSize + 1n, priceE18)
    ).to.be.revertedWithCustomError(vault, "ResidualIntentOverfill");

    await network.provider.send("evm_increaseTime", [301]);
    await network.provider.send("evm_mine");
    await expect(
      vault.connect(solver).fulfillResidualSellIntent(batchId, intentHash, 1n, priceE18)
    ).to.be.revertedWithCustomError(vault, "ResidualIntentExpired");

    const cooldown = await commitResidual(vault, manager, [9999n]);
    expect(cooldown.committed).to.equal(undefined);
    await network.provider.send("evm_increaseTime", [3600]);
    await network.provider.send("evm_mine");
    const second = (await commitResidual(vault, manager, [9999n])).committed;
    batchId = second.args.batchId;
    intentHash = second.args.intentHash;
    remainingSize = second.args.remainingSize;
    priceE18 = second.args.priceE18;
    await vault.connect(solver).fulfillResidualSellIntent(batchId, intentHash, remainingSize, priceE18);
    await expect(
      vault.connect(solver).fulfillResidualSellIntent(batchId, intentHash, 1n, priceE18)
    ).to.be.revertedWithCustomError(vault, "ResidualIntentOverfill");
  });

  it("marks residual inventory ignored after the max failed attempts", async function () {
    const fixture = await deployFixture({
      mandateOverrides: { orderExpirySeconds: 10 }
    });
    const { admin, manager, ap, vault } = fixture;
    await depositWithQuote(vault, ap, ap, admin, "residual-max-attempt-seed", usdc("1000"));
    await acquireRemovedResidualPosition(fixture, 8888n, usdc("1000"));

    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await commitResidual(vault, manager, [8888n])).committed).to.not.equal(undefined);
      await network.provider.send("evm_increaseTime", [11]);
      await network.provider.send("evm_mine");
      expect((await commitResidual(vault, manager, [8888n])).committed).to.equal(undefined);
      await network.provider.send("evm_increaseTime", [3600]);
      await network.provider.send("evm_mine");
    }

    expect((await commitResidual(vault, manager, [8888n])).committed).to.not.equal(undefined);
    await network.provider.send("evm_increaseTime", [11]);
    await network.provider.send("evm_mine");
    await expect(vault.connect(manager).commitResidualLiquidationBatch([8888n]))
      .to.emit(vault, "ResidualInventoryIgnored")
      .withArgs(8888n, usdc("1000"), 0, usdc("1"), hashText("RESIDUAL_MAX_ATTEMPTS"));
  });

  it("hashes residual sell intents with the explicit vault domain", async function () {
    const fixture = await deployFixture();
    const { admin, manager, ap, vault } = fixture;
    await depositWithQuote(vault, ap, ap, admin, "residual-hash-domain-seed", usdc("1000"));
    await acquireRemovedResidualPosition(fixture, 9999n, usdc("1000"));

    const { committed } = await commitResidual(vault, manager, [9999n]);
    const { chainId } = await ethers.provider.getNetwork();
    const expected = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "address", "uint256", "bytes32", "uint256", "uint256", "uint256", "uint64", "uint64"],
        [
          "PMF_RESIDUAL_SELL_INTENT",
          await vault.getAddress(),
          chainId,
          committed.args.batchId,
          9999n,
          committed.args.priceE18,
          committed.args.targetSize,
          committed.args.expiresAt,
          0n
        ]
      )
    );
    expect(committed.args.intentHash).to.equal(expected);
  });

  it("rejects residual commits and fills when the active basket source is stale", async function () {
    const staleCommitFixture = await deployFixture();
    const { admin, manager, ap, vault } = staleCommitFixture;
    await depositWithQuote(vault, ap, ap, admin, "residual-stale-commit-seed", usdc("1000"));
    await acquireRemovedResidualPosition(staleCommitFixture, 9999n, usdc("1000"));
    await network.provider.send("evm_increaseTime", [4 * 60 * 60 + 1]);
    await network.provider.send("evm_mine");
    await expect(vault.connect(manager).commitResidualLiquidationBatch([9999n]))
      .to.be.revertedWithCustomError(vault, "StaleBasketSource");

    const staleFillFixture = await deployFixture({
      mandateOverrides: { orderExpirySeconds: 6 * 60 * 60 }
    });
    const {
      admin: admin2,
      manager: manager2,
      ap: ap2,
      other: solver,
      pusd,
      vault: vault2
    } = staleFillFixture;
    await depositWithQuote(vault2, ap2, ap2, admin2, "residual-stale-fill-seed", usdc("1000"));
    await vault2.connect(admin2).grantRole(await vault2.SOLVER_ROLE(), solver.address);
    await acquireRemovedResidualPosition(staleFillFixture, 9999n, usdc("1000"));
    await pusd.mint(solver.address, usdc("10"));
    await pusd.connect(solver).approve(await vault2.getAddress(), ethers.MaxUint256);
    const committed = (await commitResidual(vault2, manager2, [9999n])).committed;
    await network.provider.send("evm_increaseTime", [4 * 60 * 60 + 1]);
    await network.provider.send("evm_mine");
    await expect(
      vault2.connect(solver).fulfillResidualSellIntent(
        committed.args.batchId,
        committed.args.intentHash,
        1n,
        committed.args.priceE18
      )
    ).to.be.revertedWithCustomError(vault2, "StaleBasketSource");
  });

  it("rejects cross-vault residual intent replay", async function () {
    const source = await deployFixture();
    const { admin, manager, ap, other: solver, vault } = source;
    await depositWithQuote(vault, ap, ap, admin, "residual-cross-vault-source-seed", usdc("1000"));
    await acquireRemovedResidualPosition(source, 9999n, usdc("1000"));
    const committed = (await commitResidual(vault, manager, [9999n])).committed;

    const target = await deployFixture();
    await depositWithQuote(
      target.vault,
      target.ap,
      target.ap,
      target.admin,
      "residual-cross-vault-target-seed",
      usdc("1000")
    );
    await target.vault.connect(target.admin).grantRole(await target.vault.SOLVER_ROLE(), solver.address);
    await expect(
      target.vault.connect(solver).fulfillResidualSellIntent(
        committed.args.batchId,
        committed.args.intentHash,
        1n,
        committed.args.priceE18
      )
    ).to.be.revertedWithCustomError(target.vault, "InvalidResidualIntent");
  });

  it("allows managers to reset only ignored residual inventory", async function () {
    const fixture = await deployFixture();
    const { admin, manager, ap, other, vault } = fixture;
    await depositWithQuote(vault, ap, ap, admin, "residual-reset-seed", usdc("1000"));

    await expect(vault.connect(manager).resetIgnoredResidualToken(4444n))
      .to.be.revertedWithCustomError(vault, "ResidualTokenUnknown");
    await vault.connect(manager).registerResidualToken(5555n);
    await expect(vault.connect(manager).resetIgnoredResidualToken(5555n))
      .to.be.revertedWithCustomError(vault, "InvalidResidualState")
      .withArgs(5555n, 1);

    await acquireRemovedResidualPosition(fixture, 9999n, usdc("1000"));
    const open = (await commitResidual(vault, manager, [9999n])).committed;
    expect(open).to.not.equal(undefined);
    await expect(vault.connect(manager).resetIgnoredResidualToken(9999n))
      .to.be.revertedWithCustomError(vault, "InvalidResidualState")
      .withArgs(9999n, 2);

    await acquireRemovedResidualPosition(fixture, 7777n, usdc("100"), 490300n);
    expect((await commitResidual(vault, manager, [7777n])).committed).to.equal(undefined);
    await expect(vault.connect(other).resetIgnoredResidualToken(7777n))
      .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    await expect(vault.connect(manager).resetIgnoredResidualToken(7777n))
      .to.emit(vault, "ResidualTokenTracked")
      .withArgs(7777n, 1, manager.address);

    const ignoredAgain = await commitResidual(vault, manager, [7777n]);
    expect(ignoredAgain.events.some((event) => event.name === "ResidualInventoryIgnored")).to.equal(true);
  });

  it("ignores residual dust at the 0.1 cent floor without direct redemption", async function () {
    const fixture = await deployFixture();
    const { admin, manager, ap, vault } = fixture;
    await depositWithQuote(vault, ap, ap, admin, "residual-dust-seed", usdc("1000"));
    await acquireRemovedResidualPosition(fixture, 7777n, usdc("100"));

    const tx = await vault.connect(manager).commitResidualLiquidationBatch([7777n]);
    await expect(tx)
      .to.emit(vault, "ResidualInventoryIgnored")
      .withArgs(7777n, usdc("100"), usdc("0.1"), usdc("1"), hashText("RESIDUAL_DUST"));
    const receipt = await tx.wait();
    const batch = receipt.logs
      .map((log) => {
        try {
          return vault.interface.parseLog(log);
        } catch (_error) {
          return null;
        }
      })
      .filter(Boolean)
      .find((event) => event.name === "ResidualLiquidationBatchCommitted");
    expect(batch.args.intentCount).to.equal(0n);

    const ignored = await commitResidual(vault, manager, [7777n]);
    expect(ignored.events.some((event) => event.name === "ResidualSellIntentCommitted")).to.equal(false);
    expect(ignored.events.some((event) => event.name === "ResidualInventoryIgnored")).to.equal(false);
  });

  it("reactivates dust-ignored residual inventory after legitimate reacquisition", async function () {
    const fixture = await deployFixture();
    const { admin, manager, ap, vault } = fixture;
    await depositWithQuote(vault, ap, ap, admin, "residual-reactivate-dust-seed", usdc("1000"));
    await acquireRemovedResidualPosition(fixture, 7777n, usdc("100"));
    expect((await commitResidual(vault, manager, [7777n])).committed).to.equal(undefined);

    await acquireRemovedResidualPosition(fixture, 7777n, usdc("1000"), 490200n);
    const { committed } = await commitResidual(vault, manager, [7777n]);
    expect(committed).to.not.equal(undefined);
    expect(committed.args.tokenId).to.equal(7777n);
  });

  it("reactivates closed residual inventory after legitimate reacquisition", async function () {
    const fixture = await deployFixture();
    const { admin, manager, ap, other: solver, conditionalTokens, pusd, vault } = fixture;
    await depositWithQuote(vault, ap, ap, admin, "residual-reactivate-closed-seed", usdc("1000"));
    await vault.connect(admin).grantRole(await vault.SOLVER_ROLE(), solver.address);
    await acquireRemovedResidualPosition(fixture, 9999n, usdc("1000"), 490200n);
    await pusd.mint(solver.address, usdc("1000"));
    await pusd.connect(solver).approve(await vault.getAddress(), ethers.MaxUint256);

    const first = (await commitResidual(vault, manager, [9999n])).committed;
    await vault.connect(solver).fulfillResidualSellIntent(
      first.args.batchId,
      first.args.intentHash,
      first.args.remainingSize,
      1000000000000000000n
    );
    expect(await conditionalTokens.balanceOf(await vault.getAddress(), 9999n)).to.equal(0n);

    await acquireRemovedResidualPosition(fixture, 9999n, usdc("1000"), 490300n);
    const second = (await commitResidual(vault, manager, [9999n])).committed;
    expect(second).to.not.equal(undefined);
    expect(second.args.tokenId).to.equal(9999n);
  });

  it("does not transfer residual CTF when solver pUSD payment fails", async function () {
    const fixture = await deployFixture();
    const { admin, manager, ap, other: solver, conditionalTokens, vault } = fixture;
    await depositWithQuote(vault, ap, ap, admin, "residual-payment-fail-seed", usdc("1000"));
    await vault.connect(admin).grantRole(await vault.SOLVER_ROLE(), solver.address);
    await acquireRemovedResidualPosition(fixture, 9999n, usdc("1000"));

    const committed = (await commitResidual(vault, manager, [9999n])).committed;
    await expect(
      vault.connect(solver).fulfillResidualSellIntent(
        committed.args.batchId,
        committed.args.intentHash,
        usdc("1000"),
        2000000000000000n
      )
    ).to.be.reverted;
    expect(await conditionalTokens.balanceOf(await vault.getAddress(), 9999n)).to.equal(usdc("1000"));
    expect(await conditionalTokens.balanceOf(solver.address, 9999n)).to.equal(0n);
  });

  it("rejects residual fills if the token becomes a current basket constituent before fill", async function () {
    const fixture = await deployFixture();
    const {
      admin,
      manager,
      ap,
      oracle,
      oracleSigner,
      relayer,
      other: solver,
      conditionalTokens,
      pusd,
      vault
    } = fixture;
    await depositWithQuote(vault, ap, ap, admin, "residual-basket-change-seed", usdc("1000"));
    await vault.connect(admin).grantRole(await vault.SOLVER_ROLE(), solver.address);
    await acquireRemovedResidualPosition(fixture, 9999n, usdc("1000"));
    await pusd.mint(solver.address, usdc("10"));
    await pusd.connect(solver).approve(await vault.getAddress(), ethers.MaxUint256);
    const committed = (await commitResidual(vault, manager, [9999n])).committed;
    const batchId = committed.args.batchId;
    const intentHash = committed.args.intentHash;
    const priceE18 = committed.args.priceE18;
    const block = await ethers.provider.getBlock("latest");

    await publishBasket(
      { admin, oracle, oracleSigner, relayer, feedId: hashText("PMF:stability:basket:v1") },
      {
        roundId: 490999n,
        constituents: [
          {
            tokenId: 9999n,
            conditionId: hashText("condition-residual"),
            marketIdHash: hashText("market-residual"),
            questionHash: hashText("question-residual"),
            outcomeHash: hashText("Yes"),
            outcomeSide: 1,
            weightE18: 1000000000000000000n,
            referencePriceE18: 1000000000000000n,
            executionCapacityE6: usdc("100"),
            bestBidE18: 1000000000000000n,
            bestAskE18: 2000000000000000n,
            spreadBps: 100,
            depthBidE6: usdc("100"),
            depthAskE6: usdc("100"),
            marketDataAsOf: BigInt(block.timestamp)
          }
        ]
      }
    );

    await expect(
      vault.connect(solver).fulfillResidualSellIntent(batchId, intentHash, 1n, priceE18)
    ).to.be.revertedWithCustomError(vault, "CurrentBasketConstituent");
  });

  it("rejects invalid future primary-pricing quote bindings", async function () {
    const { admin, ap, investor, pricingRouter, pricingFeedId, vault } = await deployFixture();
    await pricingRouter.connect(admin).setPrimaryEnabled(pricingFeedId, true);
    const block = await ethers.provider.getBlock("latest");
    const quoteReference = await currentQuoteReference(vault);
    const auth = {
      quoteId: hashText("deposit-quote:primary-pricing-invalid"),
      nonce: hashText("deposit-nonce:primary-pricing-invalid"),
      payer: ap.address,
      receiver: investor.address,
      grossAssets: usdc("10"),
      spreadAssets: 0n,
      minShares: usdc("10"),
      quoteReference: {
        ...quoteReference,
        pricingMode: 2,
        pricingSource: ethers.ZeroAddress,
        pricingReportHash: ethers.ZeroHash,
        pricingAsOf: 0
      },
      deadline: BigInt(block.timestamp + 3600)
    };

    await expect(vault.connect(ap).depositWithAPQuote(auth, await signAPQuote(ap, vault, auth)))
      .to.be.revertedWithCustomError(vault, "InvalidQuoteReference");
  });

  it("runs two-state wind-down, zero-markdown close, and direct final exits", async function () {
    const {
      admin,
      manager,
      navReporter,
      ap,
      investor,
      tradingWallet,
      other: solver,
      receiver,
      pusd,
      conditionalTokens,
      vault,
      basket
    } = await deployFixture();
    const vaultAddress = await vault.getAddress();
    const tokenId = 1001n;
    const dustTokenId = 1002n;
    await depositWithQuote(vault, ap, ap, investor, "wind-down-seed", usdc("3000"));
    await vault.connect(admin).grantRole(await vault.SOLVER_ROLE(), solver.address);
    await acquireViaBuyIntent(
      { admin, manager, other: solver, conditionalTokens, vault },
      tokenId,
      usdc("100")
    );
    await acquireViaBuyIntent(
      { admin, manager, other: solver, conditionalTokens, vault },
      dustTokenId,
      1n
    );
    await vault
      .connect(manager)
      .updateOrderMandate(baseMandate(tradingWallet.address, { minVaultCashBuffer: usdc("10000") }));
    await pusd.mint(solver.address, usdc("1000"));
    await pusd.connect(solver).approve(vaultAddress, ethers.MaxUint256);
    await vault
      .connect(navReporter)
      .reportTradingAssets(
        usdc("500"),
        basket.header.basketHash,
        basket.header.roundId,
        basket.header.asOf,
        hashText("wind-down-nav")
      );

    await expect(vault.connect(manager).closeFund())
      .to.be.revertedWithCustomError(vault, "FundWindDownNotStarted");
    await expect(vault.connect(manager).beginWindDown())
      .to.emit(vault, "WindDownStarted")
      .withArgs(manager.address, anyValue);
    expect(await vault.windDownStarted()).to.equal(true);

    await expect(depositWithQuote(vault, ap, ap, investor, "wind-down-blocked-deposit", usdc("10")))
      .to.be.revertedWithCustomError(vault, "FundWindDownActive");

    const queuedShares = usdc("100");
    const queuedAssets = await vault.convertToAssets(queuedShares);
    const queuedAuth = await redeemAuth(vault, "wind-down-ap-queue", {
      controller: investor.address,
      owner: investor.address,
      receiver: receiver.address,
      shares: queuedShares,
      assets: queuedAssets
    });
    await expect(
      vault.connect(investor).requestRedeemWithAPQuote(
        queuedAuth,
        await signAPRedeemQuote(ap, vault, queuedAuth)
      )
    ).to.emit(vault, "RedemptionQueued");
    expect(await vault.pendingRedemptionAssets()).to.equal(queuedAssets);

    await expect(commitBatch(vault, manager))
      .to.emit(vault, "OrderIntentBatchCommitted");
    const batch = await vault.activeOrderIntentBatch();
    const intentCount = Number(await vault.latestOrderIntentCount());
    expect(intentCount).to.be.greaterThan(0);
    for (let index = 0; index < intentCount; index++) {
      const intentHash = await vault.latestOrderIntentHash(index);
      const intent = await vault.solverOrderIntents(intentHash);
      expect(intent.side).to.equal(2);
    }
    const { intentHash, intent } = await findIntent(vault, { side: 2, tokenId });
    expect(intentHash).to.not.equal(undefined);

    const sellFillSize = usdc("10");
    await expect(vault.connect(solver).fulfillSellIntent(batch.batchId, intentHash, sellFillSize, intent.priceE18))
      .to.emit(vault, "SolverOrderIntentFulfilled")
      .withArgs(batch.batchId, intentHash, solver.address, 2, tokenId, sellFillSize, intent.priceE18, anyValue);
    expect(await conditionalTokens.balanceOf(vaultAddress, dustTokenId)).to.equal(1n);

    await expect(vault.connect(manager).pause()).to.emit(vault, "Paused");
    expect(await vault.maxRedeem(investor.address)).to.equal(0n);
    await expect(vault.connect(manager).unpause()).to.emit(vault, "Unpaused");

    const totalAssetsBeforeClose = await vault.totalAssets();
    expect(totalAssetsBeforeClose).to.be.greaterThan(0n);
    await expect(vault.connect(manager).closeFund())
      .to.emit(vault, "NonPUSDAssetsMarkedDown")
      .withArgs(usdc("500"), hashText("wind-down-nav"), anyValue)
      .and.to.emit(vault, "FundClosed")
      .withArgs(manager.address, anyValue);
    expect(await vault.fundClosed()).to.equal(true);
    expect(await vault.markedDownExternalAssets()).to.equal(usdc("500"));
    expect(await vault.totalAssets()).to.equal((await vault.liquidAssets()) - queuedAssets);

    const blockedRedeemAuth = await redeemAuth(vault, "closed-ap-redeem", {
      controller: investor.address,
      owner: investor.address,
      receiver: receiver.address,
      shares: usdc("1"),
      assets: await vault.convertToAssets(usdc("1"))
    });
    await expect(
      vault.connect(investor).requestRedeemWithAPQuote(
        blockedRedeemAuth,
        await signAPRedeemQuote(ap, vault, blockedRedeemAuth)
      )
    ).to.be.revertedWithCustomError(vault, "FundAlreadyClosed");

    const directShares = usdc("100");
    const directAssets = await vault.previewRedeem(directShares);
    await expect(vault.connect(investor).redeem(directShares, solver.address, investor.address))
      .to.emit(vault, "Withdraw")
      .withArgs(investor.address, solver.address, investor.address, directAssets, directShares);
    expect(await pusd.balanceOf(solver.address)).to.be.greaterThan(usdc("0"));
    expect(await vault.liquidAssets()).to.be.greaterThanOrEqual(await vault.pendingRedemptionAssets());

    await expect(vault.processRedemptions(1))
      .to.emit(vault, "RedemptionPaid")
      .withArgs(1, receiver.address, queuedAssets, 0)
      .and.to.emit(vault, "RedemptionCompleted")
      .withArgs(1);
    expect(await vault.pendingRedemptionAssets()).to.equal(0n);
    expect(await pusd.balanceOf(receiver.address)).to.equal(queuedAssets);
  });

  it("blocks pre-wind-down buy fills and does not reopen deposits after unpause", async function () {
    const { admin, manager, ap, investor, other: solver, pusd, conditionalTokens, vault } =
      await deployFixture();
    await depositWithQuote(vault, ap, ap, investor, "wind-down-buy-block-seed", usdc("1000"));
    await vault.connect(admin).grantRole(await vault.SOLVER_ROLE(), solver.address);
    await commitBatch(vault, manager);
    const batch = await vault.activeOrderIntentBatch();
    const { intentHash, intent } = await findIntent(vault, { side: 1 });
    expect(intentHash).to.not.equal(undefined);
    await conditionalTokens.mint(solver.address, intent.tokenId, usdc("1"));
    await conditionalTokens.connect(solver).setApprovalForAll(await vault.getAddress(), true);

    await vault.connect(manager).beginWindDown();
    await expect(vault.connect(solver).fulfillBuyIntent(batch.batchId, intentHash, usdc("1"), intent.priceE18))
      .to.be.revertedWithCustomError(vault, "FundWindDownActive");
    await vault.connect(manager).closeFund();
    await vault.connect(manager).pause();
    expect(await vault.maxRedeem(investor.address)).to.equal(0n);
    await vault.connect(manager).unpause();
    expect(await vault.maxRedeem(investor.address)).to.equal(await vault.balanceOf(investor.address));
    await expect(depositWithQuote(vault, ap, ap, investor, "closed-still-blocks-deposit", usdc("1")))
      .to.be.revertedWithCustomError(vault, "FundAlreadyClosed");
  });

  it("rejects unauthorized and expired solver fills", async function () {
    const { admin, manager, ap, other: solver, receiver: unapproved, conditionalTokens, vault } = await deployFixture({
      mandateOverrides: { orderExpirySeconds: 1 }
    });
    await depositWithQuote(vault, ap, ap, admin, "fill-expiry-seed", usdc("1000"));
    await vault.connect(admin).grantRole(await vault.SOLVER_ROLE(), solver.address);

    await commitBatch(vault, manager);
    const batch = await vault.activeOrderIntentBatch();
    const intentHash = await vault.latestOrderIntentHash(0);
    const intent = await vault.solverOrderIntents(intentHash);

    await expect(vault.connect(unapproved).fulfillBuyIntent(batch.batchId, intentHash, 1n, intent.priceE18))
      .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount")
      .withArgs(unapproved.address, await vault.SOLVER_ROLE());
    await expect(vault.connect(manager).fulfillBuyIntent(batch.batchId, intentHash, 1n, intent.priceE18))
      .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount")
      .withArgs(manager.address, await vault.SOLVER_ROLE());

    await conditionalTokens.mint(solver.address, intent.tokenId, usdc("1"));
    await conditionalTokens.connect(solver).setApprovalForAll(await vault.getAddress(), true);
    await network.provider.send("evm_increaseTime", [2]);
    await network.provider.send("evm_mine");

    await expect(
      vault.connect(solver).fulfillBuyIntent(batch.batchId, intentHash, 1n, intent.priceE18)
    ).to.be.revertedWithCustomError(vault, "IntentExpired");
  });

  it("rejects solver fills when the mandate, basket, or active batch has changed", async function () {
    const { admin, manager, ap, tradingWallet, other: solver, conditionalTokens, vault } = await deployFixture();
    await depositWithQuote(vault, ap, ap, admin, "batch-change-seed", usdc("1000"));
    await vault.connect(admin).grantRole(await vault.SOLVER_ROLE(), solver.address);

    await commitBatch(vault, manager);
    const firstBatch = await vault.activeOrderIntentBatch();
    const firstIntentHash = await vault.latestOrderIntentHash(0);
    const firstIntent = await vault.solverOrderIntents(firstIntentHash);
    await conditionalTokens.mint(solver.address, firstIntent.tokenId, usdc("5"));
    await conditionalTokens.connect(solver).setApprovalForAll(await vault.getAddress(), true);

    await vault.connect(manager).updateOrderMandate(baseMandate(tradingWallet.address, { maxSlippageBps: 75 }));
    await expect(
      vault.connect(solver).fulfillBuyIntent(firstBatch.batchId, firstIntentHash, 1n, firstIntent.priceE18)
    ).to.be.revertedWithCustomError(vault, "InvalidIntentBatch");

    await commitBatch(vault, manager);
    const secondBatch = await vault.activeOrderIntentBatch();
    const secondIntentHash = await vault.latestOrderIntentHash(0);
    await expect(
      vault.connect(solver).fulfillBuyIntent(firstBatch.batchId, firstIntentHash, 1n, firstIntent.priceE18)
    ).to.be.revertedWithCustomError(vault, "InvalidIntentBatch");

    await network.provider.send("evm_increaseTime", [1]);
    await network.provider.send("evm_mine");
    await commitBatch(vault, manager);
    await expect(
      vault.connect(solver).fulfillBuyIntent(secondBatch.batchId, secondIntentHash, 1n, firstIntent.priceE18)
    ).to.be.revertedWithCustomError(vault, "InvalidIntentBatch");
  });

  it("rejects solver fills when the oracle basket changes after commit", async function () {
    const {
      admin,
      ap,
      oracle,
      oracleSigner,
      relayer,
      manager,
      other: solver,
      conditionalTokens,
      vault
    } = await deployFixture();
    await depositWithQuote(vault, ap, ap, admin, "oracle-change-seed", usdc("1000"));
    await vault.connect(admin).grantRole(await vault.SOLVER_ROLE(), solver.address);

    await commitBatch(vault, manager);
    const batch = await vault.activeOrderIntentBatch();
    const intentHash = await vault.latestOrderIntentHash(0);
    const intent = await vault.solverOrderIntents(intentHash);
    await conditionalTokens.mint(solver.address, intent.tokenId, usdc("1"));
    await conditionalTokens.connect(solver).setApprovalForAll(await vault.getAddress(), true);

    await publishBasket(
      {
        oracle,
        oracleSigner,
        relayer,
        feedId: hashText("PMF:stability:basket:v1")
      },
      { roundId: 490001n }
    );

    await expect(
      vault.connect(solver).fulfillBuyIntent(batch.batchId, intentHash, 1n, intent.priceE18)
    ).to.be.revertedWithCustomError(vault, "InvalidIntentBatch");
  });

  it("rejects NAV reports when the oracle round is no longer fresh", async function () {
    const oracleContext = await deployOracle();
    const basket = await publishBasket(oracleContext, { roundId: 490100n, validSeconds: 2 });

    const Token = await ethers.getContractFactory("MockERC20");
    const pusd = await Token.deploy("Polymarket USD", "pUSD", 6);
    const ConditionalTokens = await ethers.getContractFactory("MockERC1155");
    const conditionalTokens = await ConditionalTokens.deploy();
    await conditionalTokens.waitForDeployment();
    const [, manager, navReporter, , , ap, , , , tradingWallet, , , feeRecipient] =
      await ethers.getSigners();
    const pricingFeedId = hashText("PMF:pricing:snapshot:v1");
    const BasketRouter = await ethers.getContractFactory("PMFBasketOracleRouter");
    const basketRouter = await BasketRouter.deploy(oracleContext.admin.address);
    await basketRouter.waitForDeployment();
    await basketRouter.connect(oracleContext.admin).setSourceAllowed(
      oracleContext.feedId,
      await oracleContext.oracle.getAddress(),
      true
    );
    await basketRouter.connect(oracleContext.admin).setInitialSource(oracleContext.feedId, await oracleContext.oracle.getAddress());
    const PricingRouter = await ethers.getContractFactory("PMFPricingRouter");
    const pricingRouter = await PricingRouter.deploy(oracleContext.admin.address);
    await pricingRouter.waitForDeployment();
    await pricingRouter.connect(oracleContext.admin).setInitialSource(pricingFeedId, ethers.ZeroAddress, false);
    const Vault = await deployVaultFactory();
    const vault = await Vault.deploy(
      VAULT_EIP712_NAME,
      "pmfSTBL",
      await pusd.getAddress(),
      await conditionalTokens.getAddress(),
      await basketRouter.getAddress(),
      oracleContext.feedId,
      await pricingRouter.getAddress(),
      pricingFeedId,
      vaultInit(
        oracleContext.admin.address,
        manager.address,
        navReporter.address,
        feeRecipient.address,
        [ap.address],
        baseMandate(tradingWallet.address)
      )
    );
    await vault.waitForDeployment();

    await network.provider.send("evm_increaseTime", [3]);
    await network.provider.send("evm_mine");

    await expect(
      vault
        .connect(navReporter)
        .reportTradingAssets(
          usdc("1"),
          basket.header.basketHash,
          basket.header.roundId,
          basket.header.asOf,
          hashText("stale")
        )
    ).to.be.revertedWithCustomError(vault, "StaleOracle");
  });

  it("updates order mandates and validates trading parameters", async function () {
    const { admin, manager, ap, tradingWallet, other, vault } = await deployFixture({
      mandateOverrides: { minVaultCashBuffer: usdc("100") }
    });

    const newMandate = baseMandate(other.address, { maxOrdersPerPlan: 12, minVaultCashBuffer: usdc("100") });
    await expect(vault.connect(other).updateOrderMandate(newMandate))
      .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount")
      .withArgs(other.address, await vault.MANDATE_MANAGER_ROLE());

    await expect(vault.connect(manager).updateOrderMandate({ ...newMandate, allowedSides: 0 }))
      .to.be.revertedWithCustomError(vault, "InvalidSideMask");
    await expect(
      vault.connect(manager).updateOrderMandate({
        ...newMandate,
        minOrderNotional: usdc("10"),
        maxOrderNotional: usdc("1")
      })
    ).to.be.revertedWithCustomError(vault, "InvalidMandate");

    await expect(vault.connect(manager).updateOrderMandate(newMandate))
      .to.emit(vault, "OrderMandateUpdated")
      .withArgs(2, anyValue, other.address, anyValue);
    const mandate = await vault.orderMandate();
    expect(mandate.tradingWallet).to.equal(other.address);
    expect(mandate.maxOrdersPerPlan).to.equal(12);

    await depositWithQuote(vault, ap, ap, admin, "mandate-validation-seed", usdc("1000"));
    await vault.connect(manager).updateOrderMandate(baseMandate(tradingWallet.address, { tradingEnabled: false }));
    await expect(commitBatch(vault, manager))
      .to.be.revertedWithCustomError(vault, "TradingDisabled");
  });

  it("rejects validation edge cases across redeem, reporting, and mandate flows", async function () {
    const { manager, navReporter, ap, investor, other, vault, basket } = await deployFixture({
      mandateOverrides: { minVaultCashBuffer: usdc("2000") }
    });
    await depositWithQuote(vault, ap, ap, investor, "validation-seed", usdc("1000"));

    expect(await vault.pendingRedeemRequest(1, investor.address)).to.equal(0n);
    await expect(vault.processRedemptions(0)).to.be.revertedWithCustomError(vault, "InvalidAmount");
    await expect(vault.connect(investor).redeem(usdc("1"), ethers.ZeroAddress, investor.address))
      .to.be.revertedWithCustomError(vault, "ERC4626ExceededMaxRedeem");

    const badAmountAuth = await redeemAuth(vault, "bad-redeem-amount", {
      controller: investor.address,
      owner: investor.address,
      receiver: investor.address,
      shares: 0n,
      assets: 1n
    });
    await expect(
      vault.connect(investor).requestRedeemWithAPQuote(
        badAmountAuth,
        await signAPRedeemQuote(ap, vault, badAmountAuth)
      )
    ).to.be.revertedWithCustomError(vault, "InvalidAmount");
    const badControllerAuth = await redeemAuth(vault, "bad-redeem-controller", {
      controller: ethers.ZeroAddress,
      owner: investor.address,
      receiver: investor.address,
      shares: usdc("1"),
      assets: usdc("1")
    });
    await expect(
      vault.connect(investor).requestRedeemWithAPQuote(
        badControllerAuth,
        await signAPRedeemQuote(ap, vault, badControllerAuth)
      )
    ).to.be.revertedWithCustomError(vault, "InvalidAddress");

    await requestRedeemWithQuote(vault, ap, investor, "valid-pending", {
      controller: investor.address,
      owner: investor.address,
      receiver: investor.address,
      shares: usdc("10"),
      assets: await vault.convertToAssets(usdc("10"))
    });
    const queued = await vault.redemptionRequest(1);
    expect(queued.remainingAssets).to.equal(await vault.pendingRedemptionAssets());

    await vault.connect(manager).updateOrderMandate(baseMandate(other.address, { minVaultCashBuffer: 0n }));
    await vault.processRedemptions(1);
    expect(await vault.pendingRedemptionAssets()).to.equal(0n);
    await expect(vault.connect(investor).redeem(usdc("1"), investor.address, investor.address))
      .to.be.revertedWithCustomError(vault, "ERC4626ExceededMaxRedeem");

    await expect(vault.connect(investor).setOperator(ethers.ZeroAddress, true))
      .to.be.revertedWithCustomError(vault, "InvalidAddress");
    await vault.connect(investor).setOperator(other.address, true);
    await expect(vault.connect(investor).setOperator(other.address, false))
      .to.emit(vault, "OperatorSet")
      .withArgs(investor.address, other.address, false);

    const futureAsOf = BigInt((await ethers.provider.getBlock("latest")).timestamp + 3600);
    await expect(
      vault
        .connect(navReporter)
        .reportTradingAssets(
          usdc("1"),
          basket.header.basketHash,
          basket.header.roundId,
          futureAsOf,
          hashText("future-report")
        )
    ).to.be.revertedWithCustomError(vault, "InvalidReport");
    await expect(
      vault
        .connect(other)
        .reportTradingAssets(
          usdc("1"),
          basket.header.basketHash,
          basket.header.roundId,
          basket.header.asOf,
          hashText("no-role-report")
        )
    )
      .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount")
      .withArgs(other.address, await vault.NAV_REPORTER_ROLE());

    await expect(
      vault.connect(manager).updateOrderMandate(baseMandate(ethers.ZeroAddress))
    ).to.be.revertedWithCustomError(vault, "InvalidAddress");
    await expect(
      vault.connect(manager).updateOrderMandate(baseMandate(other.address, { maxSlippageBps: 10001 }))
    ).to.be.revertedWithCustomError(vault, "InvalidMandate");
    await expect(
      vault.connect(manager).updateOrderMandate(baseMandate(other.address, { maxOrdersPerPlan: 0 }))
    ).to.be.revertedWithCustomError(vault, "InvalidMandate");

  });

  it("adversarial: the AP spread ceiling blocks a compromised AP from draining overstated NAV", async function () {
    const { navReporter, ap, investor, receiver, pusd, vault, basket } = await deployFixture();
    await depositWithQuote(vault, ap, ap, investor, "nav-overstatement-seed", usdc("1000"));

    await vault
      .connect(navReporter)
      .reportTradingAssets(
        usdc("1000000"),
        basket.header.basketHash,
        basket.header.roundId,
        basket.header.asOf,
        hashText("adversarial-overstated-nav")
      );

    const shares = usdc("1");
    const grossAssets = await vault.convertToAssets(shares);
    expect(grossAssets).to.be.greaterThan(usdc("1000"));

    const requestAuth = await redeemAuth(vault, "overstated-nav-drain", {
      controller: investor.address,
      owner: investor.address,
      receiver: receiver.address,
      shares,
      assets: grossAssets / 2n
    });

    await expect(
      vault
        .connect(investor)
        .requestRedeemWithAPQuote(requestAuth, await signAPRedeemQuote(ap, vault, requestAuth))
    )
      .to.be.revertedWithCustomError(vault, "InvalidAmount");

    expect(await pusd.balanceOf(receiver.address)).to.equal(0n);
    expect(await vault.liquidAssets()).to.equal(usdc("1000"));
    expect(await vault.balanceOf(investor.address)).to.equal(usdc("1000"));
  });

  it("adversarial: final close no longer strands holders because direct pUSD exits open", async function () {
    const { manager, navReporter, ap, investor, receiver, pusd, vault, basket } = await deployFixture();
    await depositWithQuote(vault, ap, ap, investor, "close-direct-exit-seed", usdc("1000"));
    await vault
      .connect(navReporter)
      .reportTradingAssets(
        usdc("500"),
        basket.header.basketHash,
        basket.header.roundId,
        basket.header.asOf,
        hashText("close-direct-exit-nav")
      );

    await vault.connect(manager).beginWindDown();
    await vault.connect(manager).closeFund();
    expect(await vault.totalAssets()).to.equal(usdc("1000"));
    expect(await vault.markedDownExternalAssets()).to.equal(usdc("500"));

    const requestAuth = await redeemAuth(vault, "closed-fund-redeem", {
      controller: investor.address,
      owner: investor.address,
      receiver: receiver.address,
      shares: usdc("100"),
      assets: await vault.convertToAssets(usdc("100"))
    });
    await expect(
      vault.connect(investor).requestRedeemWithAPQuote(
        requestAuth,
        await signAPRedeemQuote(ap, vault, requestAuth)
      )
    ).to.be.revertedWithCustomError(vault, "FundAlreadyClosed");

    const directAssets = await vault.previewRedeem(usdc("100"));
    await expect(vault.connect(investor).redeem(usdc("100"), receiver.address, investor.address))
      .to.emit(vault, "Withdraw")
      .withArgs(investor.address, receiver.address, investor.address, directAssets, usdc("100"));
    expect(await pusd.balanceOf(receiver.address)).to.equal(directAssets);
  });

  it("adversarial: AP quote IDs and nonces are single-use across deposits and redemptions", async function () {
    const { ap, investor, receiver, pusd, vault } = await deployFixture();
    const block = await ethers.provider.getBlock("latest");
    const sharedNonce = hashText("shared-nonce");
    const sharedQuoteId = hashText("shared-quote-id");
    const baseAuth = {
      nonce: sharedNonce,
      payer: investor.address,
      receiver: receiver.address,
      grossAssets: usdc("10"),
      spreadAssets: 0n,
      minShares: usdc("10"),
      deadline: BigInt(block.timestamp + 3600)
    };
    const firstAuth = { ...baseAuth, quoteId: sharedQuoteId };
    const sameNonceAuth = {
      ...baseAuth,
      quoteId: hashText("quote:same-nonce:second"),
      grossAssets: usdc("20"),
      minShares: usdc("20")
    };
    const sameQuoteIdAuth = {
      ...baseAuth,
      quoteId: sharedQuoteId,
      nonce: hashText("nonce:same-quote-id:second"),
      grossAssets: usdc("20"),
      minShares: usdc("20")
    };

    await pusd.mint(investor.address, usdc("50"));
    await pusd.connect(investor).approve(await vault.getAddress(), usdc("50"));

    await vault.connect(investor).depositWithAPQuote(firstAuth, await signAPQuote(ap, vault, firstAuth));
    await expect(vault.connect(investor).depositWithAPQuote(sameNonceAuth, await signAPQuote(ap, vault, sameNonceAuth)))
      .to.be.revertedWithCustomError(vault, "APQuoteNonceAlreadyUsed")
      .withArgs(ap.address, sharedNonce);
    await expect(vault.connect(investor).depositWithAPQuote(sameQuoteIdAuth, await signAPQuote(ap, vault, sameQuoteIdAuth)))
      .to.be.revertedWithCustomError(vault, "APQuoteIdAlreadyUsed")
      .withArgs(ap.address, sharedQuoteId);

    const sameQuoteIdRedeem = await redeemAuth(vault, "same-quote-id-redeem", {
      controller: receiver.address,
      owner: receiver.address,
      receiver: investor.address,
      shares: usdc("1"),
      assets: await vault.convertToAssets(usdc("1"))
    }, { quoteId: sharedQuoteId });
    await expect(
      vault.connect(receiver).requestRedeemWithAPQuote(
        sameQuoteIdRedeem,
        await signAPRedeemQuote(ap, vault, sameQuoteIdRedeem)
      )
    )
      .to.be.revertedWithCustomError(vault, "APQuoteIdAlreadyUsed")
      .withArgs(ap.address, sharedQuoteId);

    const sameNonceRedeem = await redeemAuth(vault, "same-nonce-redeem", {
      controller: receiver.address,
      owner: receiver.address,
      receiver: investor.address,
      shares: usdc("1"),
      assets: await vault.convertToAssets(usdc("1"))
    }, { nonce: sharedNonce });
    await expect(
      vault.connect(receiver).requestRedeemWithAPQuote(
        sameNonceRedeem,
        await signAPRedeemQuote(ap, vault, sameNonceRedeem)
      )
    )
      .to.be.revertedWithCustomError(vault, "APQuoteNonceAlreadyUsed")
      .withArgs(ap.address, sharedNonce);

    expect(await vault.balanceOf(receiver.address)).to.equal(usdc("10"));
  });
});
