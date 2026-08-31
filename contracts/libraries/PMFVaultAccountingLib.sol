// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

library PMFVaultAccountingLib {
    function netAssets(
        uint256 liquidAssets,
        uint256 reportedTradingAssets,
        uint256 pendingRedemptionAssets
    ) public pure returns (uint256) {
        uint256 grossAssets = liquidAssets + reportedTradingAssets;
        if (grossAssets <= pendingRedemptionAssets) {
            return 0;
        }
        return grossAssets - pendingRedemptionAssets;
    }

    function unallocatedCapital(
        uint256 liquidAssets,
        uint256 pendingRedemptionAssets,
        uint256 minVaultCashBuffer
    ) public pure returns (uint256) {
        uint256 reserve = pendingRedemptionAssets + minVaultCashBuffer;
        if (liquidAssets <= reserve) {
            return 0;
        }
        return liquidAssets - reserve;
    }

    function redemptionAvailableAssets(uint256 liquidAssets, uint256 minVaultCashBuffer)
        public
        pure
        returns (uint256)
    {
        if (liquidAssets <= minVaultCashBuffer) {
            return 0;
        }
        return liquidAssets - minVaultCashBuffer;
    }

    function redemptionShortfall(
        uint256 liquidAssets,
        uint256 pendingRedemptionAssets,
        uint256 minVaultCashBuffer
    ) public pure returns (uint256) {
        uint256 available = redemptionAvailableAssets(liquidAssets, minVaultCashBuffer);
        if (available >= pendingRedemptionAssets) {
            return 0;
        }
        return pendingRedemptionAssets - available;
    }

    function tradeablePortfolioValue(
        uint256 liquidAssets,
        uint256 positionValue,
        uint256 pendingRedemptionAssets,
        uint256 minVaultCashBuffer
    ) public pure returns (uint256) {
        uint256 grossValue = liquidAssets + positionValue;
        uint256 reserve = pendingRedemptionAssets + minVaultCashBuffer;
        if (grossValue <= reserve) {
            return 0;
        }
        return grossValue - reserve;
    }
}
