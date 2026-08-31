const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const USDCE = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const COLLATERAL_ONRAMP = "0x93070a847efEf7F70739046A929D47a521F5B8ee";
// This contract account retains a deterministic USDC.e balance at block 85,000,000.
// It is used only inside the ephemeral fork and never signs or broadcasts on mainnet.
const USDCE_FORK_FUNDER = "0x32f4b0adde3fe1b71902f76d470215f1b766b1a0";
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

const describeFork = process.env.POLYGON_RPC_URL ? describe : describe.skip;

describeFork("FateDepositRouter Polygon fork", function () {
  this.timeout(180000);

  before(async function () {
    if (network.name !== "hardhat") this.skip();
    const forking = { jsonRpcUrl: process.env.POLYGON_RPC_URL };
    if (process.env.POLYGON_FORK_BLOCK) {
      forking.blockNumber = Number(process.env.POLYGON_FORK_BLOCK);
    }
    await network.provider.request({ method: "hardhat_reset", params: [{ forking }] });
  });

  it("wraps official Polygon USDC.e through the official Polymarket onramp", async function () {
    const [admin, beneficiary] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("MockDepositVault");
    const vault = await Vault.deploy(PUSD);
    const Router = await ethers.getContractFactory("FateDepositRouter");
    const router = await Router.deploy(PUSD, USDCE, COLLATERAL_ONRAMP, admin.address);
    await router.waitForDeployment();
    await router.grantRole(await router.ADMISSION_SIGNER_ROLE(), admin.address);
    await router.setProduct(PRODUCT, await vault.getAddress(), 0, true);

    const usdce = await ethers.getContractAt("IERC20", USDCE);
    const pusd = await ethers.getContractAt("IERC20", PUSD);
    // Match Fate's authoritative minimum so the free fork gate exercises the
    // same direct-Polygon order size accepted by production checkout.
    const amount = 15_000_000n;
    expect(await usdce.balanceOf(USDCE_FORK_FUNDER)).to.be.greaterThanOrEqual(amount);
    await network.provider.request({
      method: "hardhat_setBalance",
      params: [USDCE_FORK_FUNDER, "0x56BC75E2D63100000"]
    });
    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [USDCE_FORK_FUNDER]
    });
    const funder = await ethers.getSigner(USDCE_FORK_FUNDER);
    await usdce.connect(funder).approve(await router.getAddress(), amount);

    const latest = await ethers.provider.getBlock("latest");
    const authorization = {
      orderId: ethers.hexlify(ethers.randomBytes(32)),
      productId: PRODUCT,
      beneficiary: beneficiary.address,
      amount,
      maxSpreadBps: 200,
      ttlSeconds: 7 * 24 * 60 * 60,
      fundingAsset: USDCE,
      fundingDeadline: latest.timestamp + 7 * 24 * 60 * 60
    };
    const signature = await admin.signTypedData(
      {
        name: "Fate Deposit Router",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await router.getAddress()
      },
      DEPOSIT_AUTHORIZATION_TYPES,
      authorization
    );

    await router.connect(funder).depositUSDCe(authorization, signature);
    const order = await router.orders(authorization.orderId);
    expect(order.remainingAssets).to.equal(amount);
    expect(await pusd.balanceOf(await router.getAddress())).to.equal(amount);
    expect(await usdce.allowance(await router.getAddress(), COLLATERAL_ONRAMP)).to.equal(0);
    await network.provider.request({
      method: "hardhat_stopImpersonatingAccount",
      params: [USDCE_FORK_FUNDER]
    });
  });
});
