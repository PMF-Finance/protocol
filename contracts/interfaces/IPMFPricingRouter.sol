// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IPMFPricingRouter {
    function activePricingSource(bytes32 feedId) external view returns (address);
    function sourceAllowed(bytes32 feedId, address source) external view returns (bool);
    function pricingSourceRevision(bytes32 feedId) external view returns (uint64);
    function primaryEnabled(bytes32 feedId) external view returns (bool);
    function setSourceAllowed(bytes32 feedId, address source, bool allowed) external;
    function validatePricingReference(bytes32 feedId, uint8 pricingMode, address source) external view;
}
