// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPMFBasketOracleRouter} from "../interfaces/IPMFBasketOracleRouter.sol";
import {PMFVaultIntentLib} from "./PMFVaultIntentLib.sol";
import {PMFVaultTypes} from "./PMFVaultTypes.sol";

library PMFVaultResidualLib {
    using Math for uint256;

    uint8 private constant RESIDUAL_STATE_TRACKED = 1;
    uint8 private constant RESIDUAL_STATE_INTENT_OPEN = 2;
    uint8 private constant RESIDUAL_STATE_COOLDOWN = 3;
    uint8 private constant RESIDUAL_STATE_IGNORED_DUST = 4;
    uint8 private constant RESIDUAL_STATE_CLOSED = 5;
    uint256 private constant RESIDUAL_MIN_PRICE_E18 = 1e15;
    uint64 private constant RESIDUAL_MAX_ATTEMPTS = 3;
    uint64 private constant RESIDUAL_COOLDOWN_SECONDS = 1 hours;
    uint256 private constant MAX_ROUTED_CONSTITUENTS = 50;

    struct CommitContext {
        address vault;
        IERC1155 conditionalTokens;
        IPMFBasketOracleRouter basketRouter;
        bytes32 basketFeedId;
        bytes32 mandateHash;
    }

    event ResidualTokenTracked(uint256 indexed tokenId, uint8 indexed state, address indexed trackedBy);
    event ResidualInventoryIgnored(
        uint256 indexed tokenId,
        uint256 balance,
        uint256 floorValue,
        uint256 threshold,
        bytes32 indexed reason
    );
    event ResidualInventoryClosed(uint256 indexed tokenId);
    event ResidualLiquidationBatchCommitted(
        bytes32 indexed batchId,
        bytes32 indexed mandateHash,
        uint64 expiresAt,
        uint256 intentCount
    );
    event ResidualSellIntentCommitted(
        bytes32 indexed batchId,
        bytes32 indexed intentHash,
        uint256 indexed tokenId,
        uint256 priceE18,
        uint256 targetSize,
        uint256 remainingSize,
        uint64 expiresAt
    );

    error InvalidAmount();
    error CurrentBasketConstituent(uint256 tokenId);
    error ResidualTokenUnknown(uint256 tokenId);
    error InvalidResidualState(uint256 tokenId, uint8 state);
    error InvalidResidualIntent(bytes32 intentHash);
    error ResidualIntentExpired(bytes32 intentHash);
    error ResidualIntentOverfill(bytes32 intentHash, uint256 requested, uint256 remaining);
    error ResidualPriceTooLow(uint256 requestedPrice, uint256 minimumPrice);
    error InsufficientResidualBalance(uint256 tokenId, uint256 requested, uint256 balance);
    error StaleBasketSource(bytes32 feedId);
    error TooManyBasketConstituents(uint256 count, uint256 maxCount);

    function trackKnownToken(
        PMFVaultTypes.ResidualState storage self,
        uint256 tokenId,
        address trackedBy
    ) public {
        if (tokenId == 0) {
            return;
        }
        if (!self.knownTokenId[tokenId]) {
            self.knownTokenId[tokenId] = true;
            self.residualInventory[tokenId] = PMFVaultTypes.ResidualInventory({
                tokenId: tokenId,
                state: RESIDUAL_STATE_TRACKED,
                attemptCount: 0,
                cooldownUntil: 0,
                lastUpdatedAt: uint64(block.timestamp),
                lastIntentHash: bytes32(0)
            });
            emit ResidualTokenTracked(tokenId, RESIDUAL_STATE_TRACKED, trackedBy);
            return;
        }

        PMFVaultTypes.ResidualInventory storage inventory = self.residualInventory[tokenId];
        if (inventory.state != RESIDUAL_STATE_CLOSED && inventory.state != RESIDUAL_STATE_IGNORED_DUST) {
            return;
        }
        inventory.state = RESIDUAL_STATE_TRACKED;
        inventory.attemptCount = 0;
        inventory.cooldownUntil = 0;
        inventory.lastUpdatedAt = uint64(block.timestamp);
        inventory.lastIntentHash = bytes32(0);
        emit ResidualTokenTracked(tokenId, RESIDUAL_STATE_TRACKED, trackedBy);
    }

    function resetIgnoredToken(
        PMFVaultTypes.ResidualState storage self,
        uint256 tokenId,
        address resetBy
    ) public {
        if (!self.knownTokenId[tokenId]) {
            revert ResidualTokenUnknown(tokenId);
        }
        PMFVaultTypes.ResidualInventory storage inventory = self.residualInventory[tokenId];
        if (inventory.state != RESIDUAL_STATE_IGNORED_DUST) {
            revert InvalidResidualState(tokenId, inventory.state);
        }
        trackKnownToken(self, tokenId, resetBy);
    }

    function commitResidualLiquidationBatch(
        PMFVaultTypes.ResidualState storage self,
        PMFVaultTypes.OrderMandate storage mandate,
        CommitContext memory context,
        uint256[] calldata tokenIds
    ) public returns (bytes32 batchId) {
        if (tokenIds.length == 0 || tokenIds.length > mandate.maxOrdersPerPlan) {
            revert InvalidAmount();
        }
        _requireFreshBasketSource(context.basketRouter, context.basketFeedId);
        delete self.latestResidualIntentHashes;

        uint64 expiresAt = uint64(block.timestamp) + mandate.orderExpirySeconds;
        bytes32 candidateHash = keccak256(abi.encode(tokenIds));
        batchId = keccak256(
            abi.encode(
                "PMF_RESIDUAL_LIQUIDATION_BATCH",
                context.vault,
                block.chainid,
                context.mandateHash,
                expiresAt,
                candidateHash,
                tokenIds.length
            )
        );
        self.latestResidualIntentBatch = PMFVaultTypes.ResidualIntentBatch({
            batchId: batchId,
            mandateHash: context.mandateHash,
            expiresAt: expiresAt,
            committedAt: uint64(block.timestamp),
            intentCount: 0,
            active: true
        });

        uint256 emitted = 0;
        for (uint256 index = 0; index < tokenIds.length && emitted < mandate.maxOrdersPerPlan; index++) {
            uint256 tokenId = tokenIds[index];
            if (_maybeCommitResidualSellIntent(self, mandate, context, tokenId, batchId, expiresAt)) {
                emitted += 1;
            }
        }
        self.latestResidualIntentBatch.intentCount = emitted;
        self.latestResidualIntentBatch.active = emitted > 0;
        emit ResidualLiquidationBatchCommitted(batchId, context.mandateHash, expiresAt, emitted);
    }

    function consumeResidualSellIntent(
        PMFVaultTypes.ResidualState storage self,
        IERC1155 conditionalTokens,
        IPMFBasketOracleRouter basketRouter,
        bytes32 basketFeedId,
        address vault,
        bytes32 batchId,
        bytes32 intentHash,
        uint256 fillSize,
        uint256 priceE18
    ) public returns (PMFVaultTypes.ResidualSellIntent memory intent) {
        _requireFreshBasketSource(basketRouter, basketFeedId);
        PMFVaultTypes.ResidualSellIntent storage stored = self.residualSellIntents[intentHash];
        if (
            !self.latestResidualIntentBatch.active || self.latestResidualIntentBatch.batchId != batchId
                || stored.batchId != batchId || stored.intentHash != intentHash
        ) {
            revert InvalidResidualIntent(intentHash);
        }
        if (block.timestamp > stored.expiresAt) {
            revert ResidualIntentExpired(intentHash);
        }
        if (fillSize == 0) {
            revert InvalidAmount();
        }
        if (fillSize > stored.remainingSize) {
            revert ResidualIntentOverfill(intentHash, fillSize, stored.remainingSize);
        }
        if (priceE18 < stored.priceE18 || priceE18 < RESIDUAL_MIN_PRICE_E18) {
            revert ResidualPriceTooLow(priceE18, RESIDUAL_MIN_PRICE_E18);
        }
        if (_isCurrentBasketToken(basketRouter, basketFeedId, stored.tokenId)) {
            revert CurrentBasketConstituent(stored.tokenId);
        }
        uint256 balance = conditionalTokens.balanceOf(vault, stored.tokenId);
        if (fillSize > balance) {
            revert InsufficientResidualBalance(stored.tokenId, fillSize, balance);
        }
        stored.remainingSize -= fillSize;
        intent = stored;
    }

    function afterResidualFill(
        PMFVaultTypes.ResidualState storage self,
        IERC1155 conditionalTokens,
        address vault,
        uint256 tokenId,
        uint256 remainingSize
    ) public {
        PMFVaultTypes.ResidualInventory storage inventory = self.residualInventory[tokenId];
        uint256 balance = conditionalTokens.balanceOf(vault, tokenId);
        if (balance == 0) {
            _markResidualClosed(inventory);
            return;
        }
        inventory.state = remainingSize == 0 ? RESIDUAL_STATE_TRACKED : RESIDUAL_STATE_INTENT_OPEN;
        inventory.lastUpdatedAt = uint64(block.timestamp);
    }

    function _maybeCommitResidualSellIntent(
        PMFVaultTypes.ResidualState storage self,
        PMFVaultTypes.OrderMandate storage mandate,
        CommitContext memory context,
        uint256 tokenId,
        bytes32 batchId,
        uint64 expiresAt
    ) private returns (bool) {
        PMFVaultTypes.ResidualInventory storage inventory = self.residualInventory[tokenId];
        if (!self.knownTokenId[tokenId] || _isCurrentBasketToken(context.basketRouter, context.basketFeedId, tokenId)) {
            return false;
        }
        uint256 balance = context.conditionalTokens.balanceOf(context.vault, tokenId);
        if (balance == 0) {
            _markResidualClosed(inventory);
            return false;
        }
        if (!_residualStateReady(self, context.conditionalTokens, context.vault, mandate, inventory)) {
            return false;
        }
        uint256 floorValue = PMFVaultIntentLib.assetsForFill(balance, RESIDUAL_MIN_PRICE_E18);
        if (floorValue < mandate.minOrderNotional) {
            _markResidualIgnored(inventory, balance, floorValue, mandate.minOrderNotional, keccak256("RESIDUAL_DUST"));
            return false;
        }
        uint256 maxSize = mandate.maxOrderNotional.mulDiv(1e18, RESIDUAL_MIN_PRICE_E18, Math.Rounding.Floor);
        uint256 size = _min(balance, maxSize);
        uint256 notional = PMFVaultIntentLib.assetsForFill(size, RESIDUAL_MIN_PRICE_E18);
        if (size == 0 || notional < mandate.minOrderNotional) {
            _markResidualIgnored(inventory, balance, floorValue, mandate.minOrderNotional, keccak256("RESIDUAL_DUST"));
            return false;
        }
        _storeResidualSellIntent(self, inventory, context.vault, batchId, tokenId, size, expiresAt);
        return true;
    }

    function _residualStateReady(
        PMFVaultTypes.ResidualState storage self,
        IERC1155 conditionalTokens,
        address vault,
        PMFVaultTypes.OrderMandate storage mandate,
        PMFVaultTypes.ResidualInventory storage inventory
    ) private returns (bool) {
        if (inventory.state == RESIDUAL_STATE_IGNORED_DUST) {
            return false;
        }
        if (inventory.state == RESIDUAL_STATE_CLOSED) {
            inventory.state = RESIDUAL_STATE_TRACKED;
            inventory.lastUpdatedAt = uint64(block.timestamp);
            return true;
        }
        if (inventory.state == RESIDUAL_STATE_COOLDOWN) {
            if (block.timestamp < inventory.cooldownUntil) {
                return false;
            }
            inventory.state = RESIDUAL_STATE_TRACKED;
            inventory.cooldownUntil = 0;
            inventory.lastUpdatedAt = uint64(block.timestamp);
            return true;
        }
        if (inventory.state == RESIDUAL_STATE_INTENT_OPEN) {
            PMFVaultTypes.ResidualSellIntent memory lastIntent = self.residualSellIntents[inventory.lastIntentHash];
            if (lastIntent.remainingSize == 0) {
                inventory.state = RESIDUAL_STATE_TRACKED;
                inventory.lastUpdatedAt = uint64(block.timestamp);
                return true;
            }
            if (block.timestamp <= lastIntent.expiresAt) {
                return false;
            }
            inventory.attemptCount += 1;
            if (inventory.attemptCount >= RESIDUAL_MAX_ATTEMPTS) {
                uint256 balance = conditionalTokens.balanceOf(vault, inventory.tokenId);
                _markResidualIgnored(
                    inventory,
                    balance,
                    0,
                    mandate.minOrderNotional,
                    keccak256("RESIDUAL_MAX_ATTEMPTS")
                );
                return false;
            }
            inventory.state = RESIDUAL_STATE_COOLDOWN;
            inventory.cooldownUntil = uint64(block.timestamp + RESIDUAL_COOLDOWN_SECONDS);
            inventory.lastUpdatedAt = uint64(block.timestamp);
            return false;
        }
        if (inventory.state == RESIDUAL_STATE_TRACKED) {
            return true;
        }
        revert InvalidResidualState(inventory.tokenId, inventory.state);
    }

    function _storeResidualSellIntent(
        PMFVaultTypes.ResidualState storage self,
        PMFVaultTypes.ResidualInventory storage inventory,
        address vault,
        bytes32 batchId,
        uint256 tokenId,
        uint256 size,
        uint64 expiresAt
    ) private returns (bytes32 intentHash) {
        intentHash = keccak256(
            abi.encode(
                "PMF_RESIDUAL_SELL_INTENT",
                vault,
                block.chainid,
                batchId,
                tokenId,
                RESIDUAL_MIN_PRICE_E18,
                size,
                expiresAt,
                inventory.attemptCount
            )
        );
        self.residualSellIntents[intentHash] = PMFVaultTypes.ResidualSellIntent({
            intentHash: intentHash,
            batchId: batchId,
            tokenId: tokenId,
            priceE18: RESIDUAL_MIN_PRICE_E18,
            targetSize: size,
            remainingSize: size,
            expiresAt: expiresAt
        });
        self.latestResidualIntentHashes.push(intentHash);
        inventory.state = RESIDUAL_STATE_INTENT_OPEN;
        inventory.lastIntentHash = intentHash;
        inventory.lastUpdatedAt = uint64(block.timestamp);
        emit ResidualSellIntentCommitted(batchId, intentHash, tokenId, RESIDUAL_MIN_PRICE_E18, size, size, expiresAt);
    }

    function _markResidualClosed(PMFVaultTypes.ResidualInventory storage inventory) private {
        if (inventory.state != RESIDUAL_STATE_CLOSED) {
            inventory.state = RESIDUAL_STATE_CLOSED;
            inventory.cooldownUntil = 0;
            inventory.lastUpdatedAt = uint64(block.timestamp);
            emit ResidualInventoryClosed(inventory.tokenId);
        }
    }

    function _markResidualIgnored(
        PMFVaultTypes.ResidualInventory storage inventory,
        uint256 balance,
        uint256 floorValue,
        uint256 threshold,
        bytes32 reason
    ) private {
        inventory.state = RESIDUAL_STATE_IGNORED_DUST;
        inventory.cooldownUntil = 0;
        inventory.lastUpdatedAt = uint64(block.timestamp);
        emit ResidualInventoryIgnored(inventory.tokenId, balance, floorValue, threshold, reason);
    }

    function _isCurrentBasketToken(IPMFBasketOracleRouter basketRouter, bytes32 basketFeedId, uint256 tokenId)
        private
        view
        returns (bool)
    {
        uint256 constituentCount = basketRouter.getConstituentCount(basketFeedId);
        if (constituentCount > MAX_ROUTED_CONSTITUENTS) {
            revert TooManyBasketConstituents(constituentCount, MAX_ROUTED_CONSTITUENTS);
        }
        for (uint256 index = 0; index < constituentCount; index++) {
            if (basketRouter.getConstituent(basketFeedId, index).tokenId == tokenId) {
                return true;
            }
        }
        return false;
    }

    function _requireFreshBasketSource(IPMFBasketOracleRouter basketRouter, bytes32 basketFeedId) private view {
        if (!basketRouter.isFresh(basketFeedId)) {
            revert StaleBasketSource(basketFeedId);
        }
        uint256 constituentCount = basketRouter.getConstituentCount(basketFeedId);
        if (constituentCount > MAX_ROUTED_CONSTITUENTS) {
            revert TooManyBasketConstituents(constituentCount, MAX_ROUTED_CONSTITUENTS);
        }
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
