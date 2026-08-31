// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IPMFBasketOracle} from "../interfaces/IPMFBasketOracle.sol";

contract MockBasketOracle is IPMFBasketOracle {
    BasketHeader private header;
    uint256 private immutable actualConstituentCount;
    bool private fresh;

    constructor(bytes32 feedId, uint16 headerCount, uint256 actualCount, bool fresh_) {
        header = BasketHeader({
            feedId: feedId,
            roundId: 1,
            asOf: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 1 days),
            runIdHash: keccak256("mock-run"),
            basketHash: keccak256("mock-basket"),
            constituentCount: headerCount,
            levelE18: 1e18,
            qualityStatus: 1
        });
        actualConstituentCount = actualCount;
        fresh = fresh_;
    }

    function setFresh(bool fresh_) external {
        fresh = fresh_;
    }

    function latestBasket() external view returns (BasketHeader memory) {
        return header;
    }

    function getConstituent(uint256 index) external view returns (BasketConstituent memory) {
        return BasketConstituent({
            tokenId: index + 1,
            conditionId: keccak256(abi.encode("condition", index)),
            marketIdHash: keccak256(abi.encode("market", index)),
            questionHash: keccak256(abi.encode("question", index)),
            outcomeHash: keccak256("Yes"),
            outcomeSide: 1,
            weightE18: 1e18,
            referencePriceE18: 5e17,
            executionCapacityE6: 1_000_000,
            bestBidE18: 49e16,
            bestAskE18: 51e16,
            spreadBps: 200,
            depthBidE6: 1_000_000,
            depthAskE6: 1_000_000,
            marketDataAsOf: header.asOf
        });
    }

    function getConstituentCount() external view returns (uint256) {
        return actualConstituentCount;
    }

    function isFresh() external view returns (bool) {
        return fresh;
    }
}
