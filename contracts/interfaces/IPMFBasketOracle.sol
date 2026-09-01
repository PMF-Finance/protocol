// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IPMFBasketOracle {
    struct BasketHeader {
        bytes32 feedId;
        uint80 roundId;
        uint64 asOf;
        uint64 validUntil;
        bytes32 runIdHash;
        bytes32 basketHash;
        uint16 constituentCount;
        uint256 levelE18;
        uint8 qualityStatus;
    }

    struct BasketConstituent {
        uint256 tokenId;
        bytes32 conditionId;
        bytes32 marketIdHash;
        bytes32 questionHash;
        bytes32 outcomeHash;
        uint8 outcomeSide;
        uint256 weightE18;
        uint256 referencePriceE18;
        uint256 executionCapacityE6;
        uint256 bestBidE18;
        uint256 bestAskE18;
        uint16 spreadBps;
        uint256 depthBidE6;
        uint256 depthAskE6;
        uint64 marketDataAsOf;
    }

    function latestBasket() external view returns (BasketHeader memory);
    function getConstituent(uint256 index) external view returns (BasketConstituent memory);
    function getConstituentCount() external view returns (uint256);
    function isFresh() external view returns (bool);
}
