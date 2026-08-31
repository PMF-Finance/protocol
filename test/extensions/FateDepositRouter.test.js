const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const DAY = 24 * 60 * 60;
const PRODUCT = ethers.keccak256(ethers.toUtf8Bytes("stbl"));

const DEPOSIT_AUTHORIZATION_TYPES = {
  DepositAuthorization: [
    { name: "orderId", type: "bytes32" },
    { name: "productId", type: "bytes32" },
    { name: "beneficiary", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "maxSpreadBps", type: "uint16" },
    { name: "ttlSeconds", type: "uint32" },
    { name: "fundingAsset", type: "address" },
    { name: "fundingDeadline", type: "uint64" }
  ]
};

function quote({ router, beneficiary, gross, spread = 0n, quoteId = null }) {
  return {
    quoteId: quoteId ?? ethers.hexlify(ethers.randomBytes(32)),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
    payer: router,
    receiver: beneficiary,
    grossAssets: gross,
    spreadAssets: spread,
    minShares: 1n,
    quoteReference: {
      basketFeedId: ethers.ZeroHash,
      basketHash: ethers.ZeroHash,
      basketRoundId: 0,
      basketSource: ethers.ZeroAddress,
      basketSourceRevision: 0,
      pricingFeedId: ethers.ZeroHash,
      pricingMode: 0,
      pricingSource: ethers.ZeroAddress,
      pricingReportHash: ethers.ZeroHash,
      pricingAsOf: 0
    },
    deadline: Math.floor(Date.now() / 1000) + DAY
  };
}

async function fixture() {
  const [admin, user, relayer, other] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("MockERC20");
  const usdce = await Token.deploy("USD Coin (PoS)", "USDC.e", 6);
  const pusd = await Token.deploy("Polymarket USD", "pUSD", 6);
  const Onramp = await ethers.getContractFactory("MockCollateralOnramp");
  const onramp = await Onramp.deploy(await usdce.getAddress(), await pusd.getAddress());
  const Vault = await ethers.getContractFactory("MockDepositVault");
  const vault = await Vault.deploy(await pusd.getAddress());
  const Router = await ethers.getContractFactory("FateDepositRouter");
  const router = await Router.deploy(
    await pusd.getAddress(),
    await usdce.getAddress(),
    await onramp.getAddress(),
    admin.address
  );
  await router.grantRole(await router.ADMISSION_SIGNER_ROLE(), admin.address);
  await router.setProduct(PRODUCT, await vault.getAddress(), 10_000_000_000n, true);
  await usdce.mint(user.address, 20_000_000n);
  await pusd.mint(user.address, 20_000_000n);
  return { admin, user, relayer, other, usdce, pusd, onramp, vault, router };
}

async function admission(ctx, { kind = "pusd", amount = 10_000_000n, overrides = {} } = {}) {
  const latest = await ethers.provider.getBlock("latest");
  const authorization = {
    orderId: overrides.orderId ?? ethers.hexlify(ethers.randomBytes(32)),
    productId: overrides.productId ?? PRODUCT,
    beneficiary: overrides.beneficiary ?? ctx.user.address,
    amount,
    maxSpreadBps: overrides.maxSpreadBps ?? 200,
    ttlSeconds: overrides.ttl ?? 7 * DAY,
    fundingAsset:
      overrides.fundingAsset ??
      (kind === "pusd" ? await ctx.pusd.getAddress() : await ctx.usdce.getAddress()),
    fundingDeadline: overrides.fundingDeadline ?? latest.timestamp + 7 * DAY
  };
  const { chainId } = await ethers.provider.getNetwork();
  const signature = await ctx.admin.signTypedData(
    {
      name: "Fate Deposit Router",
      version: "1",
      chainId,
      verifyingContract: await ctx.router.getAddress()
    },
    DEPOSIT_AUTHORIZATION_TYPES,
    authorization
  );
  return { authorization, signature };
}

async function boundQuote(ctx, orderId, values) {
  return quote({
    ...values,
    quoteId: await ctx.router.expectedRouterQuoteId(orderId, values.gross)
  });
}

async function depositPusd(ctx, amount = 10_000_000n, overrides = {}) {
  const { authorization, signature } = await admission(ctx, {
    amount,
    overrides: { ...overrides, orderId: overrides.orderId }
  });
  await ctx.pusd.connect(ctx.user).approve(await ctx.router.getAddress(), amount);
  await ctx.router.connect(ctx.user).depositPUSD(authorization, signature);
  return authorization.orderId;
}

describe("FateDepositRouter", function () {
  it("rejects invalid constructor dependencies and non-six-decimal tokens", async function () {
    const [admin] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const pusd = await Token.deploy("Polymarket USD", "pUSD", 6);
    const usdce = await Token.deploy("USD Coin (PoS)", "USDC.e", 6);
    const wrongDecimals = await Token.deploy("Wrong", "WRONG", 18);
    const Onramp = await ethers.getContractFactory("MockCollateralOnramp");
    const onramp = await Onramp.deploy(await usdce.getAddress(), await pusd.getAddress());
    const Router = await ethers.getContractFactory("FateDepositRouter");

    await expect(
      Router.deploy(admin.address, await usdce.getAddress(), await onramp.getAddress(), admin.address)
    ).to.be.revertedWithCustomError(Router, "InvalidContract");
    await expect(
      Router.deploy(await pusd.getAddress(), await pusd.getAddress(), await onramp.getAddress(), admin.address)
    ).to.be.revertedWithCustomError(Router, "InvalidAddress");
    await expect(
      Router.deploy(
        await wrongDecimals.getAddress(),
        await usdce.getAddress(),
        await onramp.getAddress(),
        admin.address
      )
    ).to.be.revertedWithCustomError(Router, "InvalidTokenDecimals");
  });

  it("wraps exact USDC.e, records an escrow order, and assigns sequence", async function () {
    const ctx = await fixture();
    const orderId = ethers.hexlify(ethers.randomBytes(32));
    const amount = 5_000_000n;
    const { authorization, signature } = await admission(ctx, {
      kind: "usdce",
      amount,
      overrides: { orderId }
    });
    await ctx.usdce.connect(ctx.user).approve(await ctx.router.getAddress(), amount);

    await expect(ctx.router.connect(ctx.user).depositUSDCe(authorization, signature))
      .to.emit(ctx.router, "DepositOrderFunded")
      .withArgs(
        orderId,
        PRODUCT,
        ctx.user.address,
        await ctx.vault.getAddress(),
        amount,
        200,
        1,
        anyValue,
        anyValue
      );

    const order = await ctx.router.orders(orderId);
    expect(order.fundedAssets).to.equal(amount);
    expect(order.remainingAssets).to.equal(amount);
    expect(order.sequence).to.equal(1n);
    expect(order.status).to.equal(1n);
    expect(await ctx.router.totalEscrowedPusd()).to.equal(amount);
    expect(await ctx.pusd.balanceOf(await ctx.router.getAddress())).to.equal(amount);
  });

  it("supports full and partial fills while delivering shares directly", async function () {
    const ctx = await fixture();
    const orderId = await depositPusd(ctx);
    const routerAddress = await ctx.router.getAddress();
    const first = await boundQuote(ctx, orderId, {
      router: routerAddress,
      beneficiary: ctx.user.address,
      gross: 4_000_000n,
      spread: 40_000n
    });
    await expect(ctx.router.connect(ctx.relayer).fill(orderId, first, "0x"))
      .to.emit(ctx.router, "DepositOrderFilled")
      .withArgs(orderId, first.quoteId, 4_000_000n, 3_960_000n, 6_000_000n, 3_960_000n);

    let order = await ctx.router.orders(orderId);
    expect(order.remainingAssets).to.equal(6_000_000n);
    expect(order.status).to.equal(1n);
    expect(await ctx.vault.balanceOf(ctx.user.address)).to.equal(3_960_000n);

    const second = await boundQuote(ctx, orderId, {
      router: routerAddress,
      beneficiary: ctx.user.address,
      gross: 6_000_000n
    });
    await ctx.router.connect(ctx.relayer).fill(orderId, second, "0x");
    order = await ctx.router.orders(orderId);
    expect(order.remainingAssets).to.equal(0n);
    expect(order.status).to.equal(2n);
    expect(await ctx.router.totalEscrowedPusd()).to.equal(0n);
    expect(await ctx.vault.balanceOf(ctx.user.address)).to.equal(9_960_000n);
  });

  it("rejects quotes with the wrong payer, receiver, amount, or spread", async function () {
    const ctx = await fixture();
    const orderId = await depositPusd(ctx, 10_000_000n, { maxSpreadBps: 200 });
    const routerAddress = await ctx.router.getAddress();

    await expect(
      ctx.router.fill(
        orderId,
        await boundQuote(ctx, orderId, {
          router: ctx.other.address,
          beneficiary: ctx.user.address,
          gross: 1_000_000n
        }),
        "0x"
      )
    ).to.be.revertedWithCustomError(ctx.router, "QuotePayerMismatch");
    await expect(
      ctx.router.fill(
        orderId,
        await boundQuote(ctx, orderId, {
          router: routerAddress,
          beneficiary: ctx.other.address,
          gross: 1_000_000n
        }),
        "0x"
      )
    ).to.be.revertedWithCustomError(ctx.router, "QuoteReceiverMismatch");
    await expect(
      ctx.router.fill(
        orderId,
        await boundQuote(ctx, orderId, {
          router: routerAddress,
          beneficiary: ctx.user.address,
          gross: 11_000_000n
        }),
        "0x"
      )
    ).to.be.revertedWithCustomError(ctx.router, "QuoteAmountExceeded");
    await expect(
      ctx.router.fill(
        orderId,
        await boundQuote(ctx, orderId, {
          router: routerAddress,
          beneficiary: ctx.user.address,
          gross: 1_000_000n,
          spread: 20_001n
        }),
        "0x"
      )
    ).to.be.revertedWithCustomError(ctx.router, "QuoteSpreadExceeded");
  });

  it("cancels directly or with a beneficiary signature and refunds Polygon pUSD", async function () {
    const ctx = await fixture();
    const directOrder = await depositPusd(ctx, 2_000_000n);
    const before = await ctx.pusd.balanceOf(ctx.user.address);
    await expect(ctx.router.connect(ctx.user).cancel(directOrder))
      .to.emit(ctx.router, "DepositOrderCancelled")
      .withArgs(directOrder, ctx.user.address, 2_000_000n);
    expect(await ctx.pusd.balanceOf(ctx.user.address)).to.equal(before + 2_000_000n);

    const signedOrder = await depositPusd(ctx, 3_000_000n);
    const { chainId } = await ethers.provider.getNetwork();
    const latest = await ethers.provider.getBlock("latest");
    const deadline = latest.timestamp + 3600;
    const signature = await ctx.user.signTypedData(
      {
        name: "Fate Deposit Router",
        version: "1",
        chainId,
        verifyingContract: await ctx.router.getAddress()
      },
      {
        CancelDepositOrder: [
          { name: "orderId", type: "bytes32" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint64" }
        ]
      },
      { orderId: signedOrder, nonce: 0, deadline }
    );
    expect(await ctx.router.cancelDigest(signedOrder, 0, deadline)).to.match(/^0x[0-9a-f]{64}$/);
    await expect(ctx.router.connect(ctx.relayer).cancelWithSig(signedOrder, 0, deadline, signature))
      .to.emit(ctx.router, "DepositOrderCancelled")
      .withArgs(signedOrder, ctx.user.address, 3_000_000n);
    expect(await ctx.router.cancellationNonces(signedOrder)).to.equal(1n);
  });

  it("allows permissionless expiry and keeps refunds available while admission is paused", async function () {
    const ctx = await fixture();
    const orderId = await depositPusd(ctx, 1_000_000n, { ttl: DAY });
    await ctx.router.pauseAdmission();
    await expect(depositPusd(ctx, 1_000_000n)).to.be.revertedWithCustomError(
      ctx.router,
      "EnforcedPause"
    );
    await ctx.router.unpauseAdmission();
    await network.provider.send("evm_increaseTime", [DAY]);
    await network.provider.send("evm_mine");
    await expect(ctx.router.connect(ctx.other).expire(orderId))
      .to.emit(ctx.router, "DepositOrderExpired")
      .withArgs(orderId, ctx.user.address, 1_000_000n);
  });

  it("prevents duplicate/invalid orders and protects escrow from rescue", async function () {
    const ctx = await fixture();
    const orderId = await depositPusd(ctx, 1_000_000n);
    const duplicate = await admission(ctx, { amount: 1_000_000n, overrides: { orderId } });
    await ctx.pusd.connect(ctx.user).approve(await ctx.router.getAddress(), 1_000_000n);
    await expect(ctx.router.connect(ctx.user).depositPUSD(duplicate.authorization, duplicate.signature))
      .to.be.revertedWithCustomError(ctx.router, "DuplicateOrder");
    await expect(
      ctx.router.rescueSurplus(await ctx.pusd.getAddress(), ctx.admin.address, 1n)
    ).to.be.revertedWithCustomError(ctx.router, "EscrowRescueExceeded");

    await ctx.pusd.mint(await ctx.router.getAddress(), 100n);
    await expect(ctx.router.rescueSurplus(await ctx.pusd.getAddress(), ctx.admin.address, 100n))
      .to.emit(ctx.router, "SurplusRescued")
      .withArgs(await ctx.pusd.getAddress(), ctx.admin.address, 100n);
    expect(await ctx.router.totalEscrowedPusd()).to.equal(1_000_000n);
  });

  it("enforces the absolute 10,000 pUSD escrow ceiling", async function () {
    const ctx = await fixture();
    const ceiling = await ctx.router.ABSOLUTE_ESCROW_CEILING();
    await ctx.pusd.mint(ctx.user.address, ceiling);
    await depositPusd(ctx, ceiling);

    const extra = await admission(ctx, { amount: 1n });
    await ctx.pusd.connect(ctx.user).approve(await ctx.router.getAddress(), 1n);
    await expect(ctx.router.connect(ctx.user).depositPUSD(extra.authorization, extra.signature))
      .to.be.revertedWithCustomError(ctx.router, "EscrowCeilingExceeded")
      .withArgs(ceiling + 1n, ceiling);
  });

  it("requires an authorized exact deposit authorization and blocks order-id squatting", async function () {
    const ctx = await fixture();
    const approved = await admission(ctx, { amount: 2_000_000n });
    expect(await ctx.router.depositAuthorizationDigest(approved.authorization)).to.match(
      /^0x[0-9a-f]{64}$/
    );
    await ctx.pusd.connect(ctx.other).approve(await ctx.router.getAddress(), 2_000_000n);
    await ctx.pusd.mint(ctx.other.address, 2_000_000n);

    await expect(
      ctx.router.connect(ctx.other).depositPUSD(approved.authorization, "0x")
    ).to.be.reverted;
    await expect(
      ctx.router.connect(ctx.other).depositPUSD(
        { ...approved.authorization, amount: 1n },
        approved.signature
      )
    ).to.be.revertedWithCustomError(ctx.router, "InvalidAdmissionSignature");

    await expect(ctx.router.connect(ctx.other).depositPUSD(approved.authorization, approved.signature))
      .to.emit(ctx.router, "DepositAuthorizationUsed")
      .withArgs(
        approved.authorization.orderId,
        ctx.admin.address,
        await ctx.pusd.getAddress(),
        approved.authorization.fundingDeadline
      );
    expect((await ctx.router.orders(approved.authorization.orderId)).beneficiary).to.equal(
      ctx.user.address
    );
  });

  it("rejects expired, wrong-chain, wrong-router, wrong-token, and replayed authorizations", async function () {
    const ctx = await fixture();
    const { chainId } = await ethers.provider.getNetwork();
    const domain = {
      name: "Fate Deposit Router",
      version: "1",
      chainId,
      verifyingContract: await ctx.router.getAddress()
    };
    const expired = await admission(ctx, {
      amount: 1_000_000n,
      overrides: { fundingDeadline: (await ethers.provider.getBlock("latest")).timestamp - 1 }
    });
    await ctx.pusd.connect(ctx.user).approve(await ctx.router.getAddress(), 5_000_000n);
    await expect(ctx.router.connect(ctx.user).depositPUSD(expired.authorization, expired.signature))
      .to.be.revertedWithCustomError(ctx.router, "ExpiredDepositAuthorization");

    const approved = await admission(ctx, { amount: 1_000_000n });
    const wrongChainSignature = await ctx.admin.signTypedData(
      { ...domain, chainId: chainId + 1n },
      DEPOSIT_AUTHORIZATION_TYPES,
      approved.authorization
    );
    await expect(ctx.router.connect(ctx.user).depositPUSD(approved.authorization, wrongChainSignature))
      .to.be.revertedWithCustomError(ctx.router, "InvalidAdmissionSignature");

    const Router = await ethers.getContractFactory("FateDepositRouter");
    const otherRouter = await Router.deploy(
      await ctx.pusd.getAddress(),
      await ctx.usdce.getAddress(),
      await ctx.onramp.getAddress(),
      ctx.admin.address
    );
    const wrongRouterSignature = await ctx.admin.signTypedData(
      { ...domain, verifyingContract: await otherRouter.getAddress() },
      DEPOSIT_AUTHORIZATION_TYPES,
      approved.authorization
    );
    await expect(ctx.router.connect(ctx.user).depositPUSD(approved.authorization, wrongRouterSignature))
      .to.be.revertedWithCustomError(ctx.router, "InvalidAdmissionSignature");

    const wrongToken = await admission(ctx, { kind: "usdce", amount: 1_000_000n });
    await expect(ctx.router.connect(ctx.user).depositPUSD(wrongToken.authorization, wrongToken.signature))
      .to.be.revertedWithCustomError(ctx.router, "FundingAssetMismatch");

    await ctx.router.connect(ctx.user).depositPUSD(approved.authorization, approved.signature);
    await expect(ctx.router.connect(ctx.user).depositPUSD(approved.authorization, approved.signature))
      .to.be.revertedWithCustomError(ctx.router, "DuplicateOrder");
  });

  it("binds router quotes to one order and the current partial-fill offset", async function () {
    const ctx = await fixture();
    const routerAddress = await ctx.router.getAddress();
    const firstOrder = await depositPusd(ctx, 4_000_000n);
    const secondOrder = await depositPusd(ctx, 4_000_000n);
    const firstQuote = await boundQuote(ctx, firstOrder, {
      router: routerAddress,
      beneficiary: ctx.user.address,
      gross: 1_000_000n
    });

    await expect(ctx.router.fill(secondOrder, firstQuote, "0x"))
      .to.be.revertedWithCustomError(ctx.router, "QuoteOrderMismatch");
    await ctx.router.fill(firstOrder, firstQuote, "0x");
    await expect(ctx.router.fill(firstOrder, firstQuote, "0x"))
      .to.be.revertedWithCustomError(ctx.router, "QuoteOrderMismatch");
  });

  it("uses independent cancellation nonces for simultaneous orders", async function () {
    const ctx = await fixture();
    const firstOrder = await depositPusd(ctx, 1_000_000n);
    const secondOrder = await depositPusd(ctx, 1_000_000n);
    const { chainId } = await ethers.provider.getNetwork();
    const latest = await ethers.provider.getBlock("latest");
    const deadline = latest.timestamp + 3600;
    const domain = {
      name: "Fate Deposit Router",
      version: "1",
      chainId,
      verifyingContract: await ctx.router.getAddress()
    };
    const types = {
      CancelDepositOrder: [
        { name: "orderId", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint64" }
      ]
    };
    const firstSignature = await ctx.user.signTypedData(
      domain,
      types,
      { orderId: firstOrder, nonce: 0, deadline }
    );
    const secondSignature = await ctx.user.signTypedData(
      domain,
      types,
      { orderId: secondOrder, nonce: 0, deadline }
    );

    await ctx.router.cancelWithSig(firstOrder, 0, deadline, firstSignature);
    await ctx.router.cancelWithSig(secondOrder, 0, deadline, secondSignature);
    expect(await ctx.router.cancellationNonces(firstOrder)).to.equal(1n);
    expect(await ctx.router.cancellationNonces(secondOrder)).to.equal(1n);
  });

  it("supports unlimited product order size while clearing temporary allowances", async function () {
    const ctx = await fixture();
    await ctx.router.setProduct(PRODUCT, await ctx.vault.getAddress(), 0, true);
    const amount = 25_000_000n;
    await ctx.pusd.mint(ctx.user.address, amount);
    const orderId = await depositPusd(ctx, amount);
    const auth = await boundQuote(ctx, orderId, {
      router: await ctx.router.getAddress(),
      beneficiary: ctx.user.address,
      gross: amount
    });
    await ctx.router.fill(orderId, auth, "0x");
    expect(
      await ctx.pusd.allowance(await ctx.router.getAddress(), await ctx.vault.getAddress())
    ).to.equal(0n);
  });

  it("reverts an under-consuming vault without changing escrow accounting", async function () {
    const ctx = await fixture();
    const AdversarialVault = await ethers.getContractFactory("MockAdversarialDepositVault");
    const vault = await AdversarialVault.deploy(await ctx.pusd.getAddress(), 9_000, false);
    await ctx.router.setProduct(PRODUCT, await vault.getAddress(), 0, true);
    const orderId = await depositPusd(ctx, 2_000_000n);
    const auth = await boundQuote(ctx, orderId, {
      router: await ctx.router.getAddress(),
      beneficiary: ctx.user.address,
      gross: 2_000_000n
    });

    await expect(ctx.router.fill(orderId, auth, "0x"))
      .to.be.revertedWithCustomError(ctx.router, "VaultAssetConsumptionMismatch")
      .withArgs(2_000_000n, 1_800_000n);
    expect((await ctx.router.orders(orderId)).remainingAssets).to.equal(2_000_000n);
    expect(await ctx.router.totalEscrowedPusd()).to.equal(2_000_000n);
    expect(await ctx.pusd.balanceOf(await ctx.router.getAddress())).to.equal(2_000_000n);
  });

  it("blocks vault reentrancy while permitting an otherwise exact fill", async function () {
    const ctx = await fixture();
    const AdversarialVault = await ethers.getContractFactory("MockAdversarialDepositVault");
    const vault = await AdversarialVault.deploy(await ctx.pusd.getAddress(), 10_000, true);
    await ctx.router.setProduct(PRODUCT, await vault.getAddress(), 0, true);
    const orderId = await depositPusd(ctx, 2_000_000n);
    const auth = await boundQuote(ctx, orderId, {
      router: await ctx.router.getAddress(),
      beneficiary: ctx.user.address,
      gross: 2_000_000n
    });

    await ctx.router.fill(orderId, auth, ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [orderId]));
    expect((await ctx.router.orders(orderId)).status).to.equal(2n);
    expect(await ctx.router.totalEscrowedPusd()).to.equal(0n);
  });

  it("keeps aggregate liabilities equal to open-order remaining assets across transitions", async function () {
    const ctx = await fixture();
    const first = await depositPusd(ctx, 5_000_000n);
    const second = await depositPusd(ctx, 3_000_000n);
    const third = await depositPusd(ctx, 2_000_000n, { ttl: DAY });
    const routerAddress = await ctx.router.getAddress();

    await ctx.router.fill(
      first,
      await boundQuote(ctx, first, {
        router: routerAddress,
        beneficiary: ctx.user.address,
        gross: 2_000_000n
      }),
      "0x"
    );
    await ctx.router.connect(ctx.user).cancel(second);
    await network.provider.send("evm_increaseTime", [DAY]);
    await network.provider.send("evm_mine");
    await ctx.router.expire(third);

    const orders = await Promise.all([first, second, third].map((orderId) => ctx.router.orders(orderId)));
    const openRemaining = orders
      .filter((order) => order.status === 1n)
      .reduce((total, order) => total + order.remainingAssets, 0n);
    expect(openRemaining).to.equal(await ctx.router.totalEscrowedPusd());
    expect(await ctx.pusd.balanceOf(routerAddress)).to.be.greaterThanOrEqual(openRemaining);
    expect(orders[0].fundedAssets).to.equal(orders[0].remainingAssets + 2_000_000n);
    expect(orders[1].remainingAssets).to.equal(0n);
    expect(orders[2].remainingAssets).to.equal(0n);
  });
});
