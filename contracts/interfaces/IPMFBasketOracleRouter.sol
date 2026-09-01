// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IPMFBasketOracle} from "./IPMFBasketOracle.sol";

interface IPMFBasketOracleRouter {
    struct BasketSource {
        address source;
        uint64 revision;
    }

    function activeSource(bytes32 feedId) external view returns (address);
    function sourceAllowed(bytes32 feedId, address source) external view returns (bool);
    function sourceRevision(bytes32 feedId) external view returns (uint64);
    function setSourceAllowed(bytes32 feedId, address source, bool allowed) external;
    function latestBasket(bytes32 feedId) external view returns (IPMFBasketOracle.BasketHeader memory);
    function getConstituent(bytes32 feedId, uint256 index)
        external
        view
        returns (IPMFBasketOracle.BasketConstituent memory);
    function getConstituentCount(bytes32 feedId) external view returns (uint256);
    function isFresh(bytes32 feedId) external view returns (bool);
}
