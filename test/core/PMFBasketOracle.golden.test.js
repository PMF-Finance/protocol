const { expect } = require("chai");
const { ethers } = require("hardhat");

const fixture = require("./fixtures/oracle-basket.json");

const TYPES = {
  BasketHeader: fixture.eip712.types.BasketHeader
};

describe("PMFBasketOracle golden fixture", function () {
  it("matches Python basket hashing and EIP-712 signer recovery", async function () {
    const [admin] = await ethers.getSigners();
    const Oracle = await ethers.getContractFactory("PMFBasketOracle");
    const oracle = await Oracle.deploy(
      fixture.feed_id,
      admin.address,
      fixture.signer_address,
      50,
      15 * 60,
      100000000000000n
    );
    await oracle.waitForDeployment();

    const solidityHash = await oracle.hashBasket(fixture.compact_constituents);
    expect(solidityHash).to.equal(fixture.basket_hash);
    expect(fixture.header.basketHash).to.equal(solidityHash);

    const recovered = ethers.verifyTypedData(
      fixture.eip712.domain,
      TYPES,
      fixture.eip712.message,
      fixture.signature
    );
    expect(recovered).to.equal(fixture.signer_address);
  });
});
