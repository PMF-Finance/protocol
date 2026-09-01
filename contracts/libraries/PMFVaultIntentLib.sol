// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPMFBasketOracle} from "../interfaces/IPMFBasketOracle.sol";
import {PMFVaultAccountingLib} from "./PMFVaultAccountingLib.sol";
import {PMFVaultTypes} from "./PMFVaultTypes.sol";

library PMFVaultIntentLib {
    using Math for uint256;

    uint8 private constant SIDE_BUY = 1;
    uint8 private constant SIDE_SELL = 2;
    uint8 private constant SIDE_BOTH = 3;
    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant E18 = 1e18;
    uint256 private constant MAX_ROUTED_CONSTITUENTS = 50;

    event OrderIntentBatchCommitted(
        bytes32 indexed batchId,
        bytes32 indexed basketHash,
        uint80 indexed oracleRoundId,
        bytes32 mandateHash,
        uint64 expiresAt,
        uint256 intentCount
    );
    event SolverOrderIntentCommitted(
        bytes32 indexed batchId,
        bytes32 indexed intentHash,
        uint256 indexed tokenId,
        uint8 side,
        uint256 priceE18,
        uint256 targetSize,
        uint256 remainingSize,
        uint64 expiresAt
    );

    error InvalidAddress();
    error InvalidAmount();
    error InvalidMandate();
    error InvalidSideMask(uint8 allowedSides);
    error TradingDisabled();
    error StaleOracle();
    error OracleReferenceMismatch(bytes32 expectedBasketHash, uint80 expectedRoundId);
    error InvalidIntentBatch();
    error NoOrderIntents();
    error TooManyBasketConstituents(uint256 count, uint256 maxCount);
    error InvalidOrderIntent(bytes32 intentHash);
    error IntentExpired(bytes32 intentHash);
    error IntentOverfill(bytes32 intentHash, uint256 requested, uint256 remaining);
    error PriceBoundViolation(uint256 requestedPrice, uint256 boundPrice);

    struct CommitContext {
        address vault;
        IPMFBasketOracle basketOracle;
        IERC1155 conditionalTokens;
        uint256 liquidAssets;
        uint256 pendingRedemptionAssets;
        bytes32 mandateHash;
        bytes32 basketFeedId;
        address basketSource;
        uint64 basketSourceRevision;
        bytes32 expectedBasketHash;
        uint80 expectedRoundId;
        bool requireExpected;
        bool liquidationOnly;
    }

    function applyMandate(PMFVaultTypes.OrderMandate storage mandate, PMFVaultTypes.OrderMandateUpdate memory update)
        public
        returns (bytes32 mandateHash)
    {
        validateMandate(update);
        mandate.tradingWallet = update.tradingWallet;
        mandate.tradingEnabled = update.tradingEnabled;
        mandate.allowedSides = update.allowedSides;
        mandate.maxSlippageBps = update.maxSlippageBps;
        mandate.maxSpreadBps = update.maxSpreadBps;
        mandate.maxDepthParticipationBps = update.maxDepthParticipationBps;
        mandate.maxOrdersPerPlan = update.maxOrdersPerPlan;
        mandate.staleAfterSeconds = update.staleAfterSeconds;
        mandate.orderExpirySeconds = update.orderExpirySeconds;
        mandate.minOrderNotional = update.minOrderNotional;
        mandate.maxOrderNotional = update.maxOrderNotional;
        mandate.minVaultCashBuffer = update.minVaultCashBuffer;
        mandate.mandateRevision += 1;
        mandate.updatedAt = uint64(block.timestamp);
        mandateHash = hashMandate(mandate);
    }

    function validateMandate(PMFVaultTypes.OrderMandateUpdate memory update) public pure {
        if (update.tradingWallet == address(0)) {
            revert InvalidAddress();
        }
        if (update.allowedSides != SIDE_BUY && update.allowedSides != SIDE_SELL && update.allowedSides != SIDE_BOTH) {
            revert InvalidSideMask(update.allowedSides);
        }
        if (
            update.maxSlippageBps > BPS_DENOMINATOR
                || update.maxSpreadBps > BPS_DENOMINATOR
                || update.maxDepthParticipationBps > BPS_DENOMINATOR
        ) {
            revert InvalidMandate();
        }
        if (
            update.maxOrdersPerPlan == 0
                || update.staleAfterSeconds == 0
                || update.orderExpirySeconds == 0
                || update.minOrderNotional == 0
                || update.maxOrderNotional < update.minOrderNotional
        ) {
            revert InvalidMandate();
        }
    }

    function commitOrderIntentBatch(
        PMFVaultTypes.IntentState storage self,
        PMFVaultTypes.OrderMandate storage mandate,
        CommitContext memory context
    ) public returns (bytes32 batchId) {
        if (!mandate.tradingEnabled && !context.liquidationOnly) {
            revert TradingDisabled();
        }

        IPMFBasketOracle.BasketHeader memory header = context.basketOracle.latestBasket();
        if (!context.basketOracle.isFresh()) {
            revert StaleOracle();
        }
        if (block.timestamp > header.asOf + mandate.staleAfterSeconds) {
            revert StaleOracle();
        }
        if (
            context.requireExpected
                && (header.basketHash != context.expectedBasketHash || header.roundId != context.expectedRoundId)
        ) {
            revert OracleReferenceMismatch(header.basketHash, header.roundId);
        }

        uint256 constituentCount = context.basketOracle.getConstituentCount();
        if (constituentCount == 0) {
            revert InvalidIntentBatch();
        }
        if (constituentCount > MAX_ROUTED_CONSTITUENTS) {
            revert TooManyBasketConstituents(constituentCount, MAX_ROUTED_CONSTITUENTS);
        }

        uint64 expiresAt = uint64(block.timestamp) + mandate.orderExpirySeconds;
        uint256 availableCash = PMFVaultAccountingLib.unallocatedCapital(
            context.liquidAssets,
            context.pendingRedemptionAssets,
            mandate.minVaultCashBuffer
        );
        batchId = keccak256(
            abi.encode(
                "PMF_ORDER_INTENT_BATCH",
                context.vault,
                block.chainid,
                context.basketFeedId,
                context.basketSource,
                context.basketSourceRevision,
                header.basketHash,
                header.roundId,
                context.mandateHash,
                expiresAt,
                availableCash,
                context.pendingRedemptionAssets,
                constituentCount,
                context.liquidationOnly
            )
        );

        clearLatestOrderIntents(self);
        self.latestOrderIntentBatch = PMFVaultTypes.OrderIntentBatch({
            batchId: batchId,
            basketFeedId: context.basketFeedId,
            basketHash: header.basketHash,
            oracleRoundId: header.roundId,
            basketSource: context.basketSource,
            basketSourceRevision: context.basketSourceRevision,
            mandateHash: context.mandateHash,
            expiresAt: expiresAt,
            committedAt: uint64(block.timestamp),
            intentCount: 0,
            active: true
        });

        uint256 positionValue = positionValueE6(
            context.basketOracle,
            context.conditionalTokens,
            context.vault,
            constituentCount
        );
        uint256 portfolioValue = context.liquidationOnly
            ? positionValue
            : PMFVaultAccountingLib.tradeablePortfolioValue(
                context.liquidAssets,
                positionValue,
                context.pendingRedemptionAssets,
                mandate.minVaultCashBuffer
            );
        if (portfolioValue == 0) {
            revert NoOrderIntents();
        }

        uint256 emitted = 0;
        for (uint256 index = 0; index < constituentCount; index++) {
            if (emitted >= mandate.maxOrdersPerPlan) {
                break;
            }
            (bool committed, uint256 reservedAssets) =
                maybeCommitIntent(self, mandate, context, index, batchId, expiresAt, portfolioValue, availableCash);
            if (committed) {
                emitted += 1;
                if (reservedAssets >= availableCash) {
                    availableCash = 0;
                } else {
                    availableCash -= reservedAssets;
                }
            }
        }

        if (emitted == 0) {
            revert NoOrderIntents();
        }

        self.latestOrderIntentBatch.intentCount = emitted;
        emit OrderIntentBatchCommitted(
            batchId,
            header.basketHash,
            header.roundId,
            context.mandateHash,
            expiresAt,
            emitted
        );
    }

    function consumeIntent(
        PMFVaultTypes.IntentState storage self,
        PMFVaultTypes.OrderMandate storage mandate,
        IPMFBasketOracle basketOracle,
        address basketSource,
        uint64 basketSourceRevision,
        bytes32 batchId,
        bytes32 intentHash,
        uint8 side,
        uint256 fillSize,
        uint256 priceE18
    ) public returns (PMFVaultTypes.SolverOrderIntent memory intent) {
        if (fillSize == 0) {
            revert InvalidAmount();
        }
        if (!self.latestOrderIntentBatch.active || self.latestOrderIntentBatch.batchId != batchId) {
            revert InvalidIntentBatch();
        }
        IPMFBasketOracle.BasketHeader memory header = basketOracle.latestBasket();
        if (
            self.latestOrderIntentBatch.basketHash != header.basketHash
                || self.latestOrderIntentBatch.oracleRoundId != header.roundId
                || self.latestOrderIntentBatch.basketSource != basketSource
                || self.latestOrderIntentBatch.basketSourceRevision != basketSourceRevision
                || self.latestOrderIntentBatch.mandateHash != hashMandate(mandate)
        ) {
            revert InvalidIntentBatch();
        }
        if (!basketOracle.isFresh()) {
            revert StaleOracle();
        }

        PMFVaultTypes.SolverOrderIntent storage stored = self.solverOrderIntents[intentHash];
        if (stored.batchId != batchId || stored.side != side || stored.intentHash != intentHash) {
            revert InvalidOrderIntent(intentHash);
        }
        if (block.timestamp > stored.expiresAt) {
            revert IntentExpired(intentHash);
        }
        if (fillSize > stored.remainingSize) {
            revert IntentOverfill(intentHash, fillSize, stored.remainingSize);
        }
        if (side == SIDE_BUY && (priceE18 == 0 || priceE18 > stored.priceE18)) {
            revert PriceBoundViolation(priceE18, stored.priceE18);
        }
        if (side == SIDE_SELL && priceE18 < stored.priceE18) {
            revert PriceBoundViolation(priceE18, stored.priceE18);
        }

        stored.remainingSize -= fillSize;
        intent = stored;
    }

    function hashMandate(PMFVaultTypes.OrderMandate storage mandate) public pure returns (bytes32) {
        return keccak256(abi.encode(mandate));
    }

    function latestOrderIntentCount(PMFVaultTypes.IntentState storage self) public view returns (uint256) {
        return self.latestIntentHashes.length;
    }

    function latestOrderIntentHash(PMFVaultTypes.IntentState storage self, uint256 index)
        public
        view
        returns (bytes32)
    {
        return self.latestIntentHashes[index];
    }

    function solverOrderIntent(PMFVaultTypes.IntentState storage self, bytes32 intentHash)
        public
        view
        returns (PMFVaultTypes.SolverOrderIntent memory)
    {
        return self.solverOrderIntents[intentHash];
    }

    function positionValueE6(
        IPMFBasketOracle basketOracle,
        IERC1155 conditionalTokens,
        address vault,
        uint256 constituentCount
    ) private view returns (uint256 value) {
        for (uint256 index = 0; index < constituentCount; index++) {
            IPMFBasketOracle.BasketConstituent memory item = basketOracle.getConstituent(index);
            uint256 size = conditionalTokens.balanceOf(vault, item.tokenId);
            value += size.mulDiv(item.referencePriceE18, E18, Math.Rounding.Floor);
        }
    }

    function maybeCommitIntent(
        PMFVaultTypes.IntentState storage self,
        PMFVaultTypes.OrderMandate storage mandate,
        CommitContext memory context,
        uint256 constituentIndex,
        bytes32 batchId,
        uint64 expiresAt,
        uint256 portfolioValue,
        uint256 availableCash
    ) private returns (bool committed, uint256 reservedAssets) {
        IPMFBasketOracle.BasketConstituent memory item = context.basketOracle.getConstituent(constituentIndex);
        if (block.timestamp > item.marketDataAsOf + mandate.staleAfterSeconds) {
            revert StaleOracle();
        }
        if (item.spreadBps > mandate.maxSpreadBps) {
            return (false, 0);
        }

        uint256 currentSize = context.conditionalTokens.balanceOf(context.vault, item.tokenId);
        uint256 currentValue = currentSize.mulDiv(item.referencePriceE18, E18, Math.Rounding.Floor);
        if (context.liquidationOnly) {
            return commitSellIntent(self, mandate, item, batchId, expiresAt, currentValue, currentSize);
        }

        uint256 targetValue = portfolioValue.mulDiv(item.weightE18, E18, Math.Rounding.Floor);

        if (targetValue > currentValue) {
            if (!sideAllowed(mandate.allowedSides, SIDE_BUY)) {
                return (false, 0);
            }
            return commitBuyIntent(self, mandate, item, batchId, expiresAt, targetValue - currentValue, availableCash);
        }
        if (currentValue > targetValue) {
            if (!sideAllowed(mandate.allowedSides, SIDE_SELL)) {
                return (false, 0);
            }
            return commitSellIntent(self, mandate, item, batchId, expiresAt, currentValue - targetValue, currentSize);
        }
        return (false, 0);
    }

    function commitBuyIntent(
        PMFVaultTypes.IntentState storage self,
        PMFVaultTypes.OrderMandate storage mandate,
        IPMFBasketOracle.BasketConstituent memory item,
        bytes32 batchId,
        uint64 expiresAt,
        uint256 deltaValue,
        uint256 availableCash
    ) private returns (bool committed, uint256 reservedAssets) {
        uint256 priceE18 = boundedBuyPrice(mandate.maxSlippageBps, item.bestAskE18);
        if (priceE18 == 0 || availableCash < mandate.minOrderNotional) {
            return (false, 0);
        }
        uint256 size = desiredSize(deltaValue, item.referencePriceE18);
        size = min(size, item.depthAskE6.mulDiv(mandate.maxDepthParticipationBps, BPS_DENOMINATOR));
        size = min(size, mandate.maxOrderNotional.mulDiv(E18, priceE18));
        size = min(size, availableCash.mulDiv(E18, priceE18));
        reservedAssets = assetsForFill(size, priceE18);
        if (size == 0 || reservedAssets < mandate.minOrderNotional) {
            return (false, 0);
        }
        storeOrderIntent(self, batchId, SIDE_BUY, item.tokenId, priceE18, size, expiresAt);
        return (true, reservedAssets);
    }

    function commitSellIntent(
        PMFVaultTypes.IntentState storage self,
        PMFVaultTypes.OrderMandate storage mandate,
        IPMFBasketOracle.BasketConstituent memory item,
        bytes32 batchId,
        uint64 expiresAt,
        uint256 deltaValue,
        uint256 currentSize
    ) private returns (bool committed, uint256 reservedAssets) {
        uint256 priceE18 = boundedSellPrice(mandate.maxSlippageBps, item.bestBidE18);
        if (priceE18 == 0) {
            return (false, 0);
        }
        uint256 size = desiredSize(deltaValue, item.referencePriceE18);
        size = min(size, item.depthBidE6.mulDiv(mandate.maxDepthParticipationBps, BPS_DENOMINATOR));
        size = min(size, mandate.maxOrderNotional.mulDiv(E18, priceE18));
        size = min(size, currentSize);
        reservedAssets = assetsForFill(size, priceE18);
        if (size == 0 || reservedAssets < mandate.minOrderNotional) {
            return (false, 0);
        }
        storeOrderIntent(self, batchId, SIDE_SELL, item.tokenId, priceE18, size, expiresAt);
        return (true, 0);
    }

    function storeOrderIntent(
        PMFVaultTypes.IntentState storage self,
        bytes32 batchId,
        uint8 side,
        uint256 tokenId,
        uint256 priceE18,
        uint256 size,
        uint64 expiresAt
    ) private returns (bytes32 intentHash) {
        intentHash = keccak256(
            abi.encode(
                "PMF_SOLVER_ORDER_INTENT",
                address(this),
                block.chainid,
                batchId,
                self.latestOrderIntentBatch.basketHash,
                self.latestOrderIntentBatch.oracleRoundId,
                self.latestOrderIntentBatch.mandateHash,
                side,
                tokenId,
                priceE18,
                size,
                expiresAt
            )
        );
        self.solverOrderIntents[intentHash] = PMFVaultTypes.SolverOrderIntent({
            intentHash: intentHash,
            batchId: batchId,
            side: side,
            tokenId: tokenId,
            priceE18: priceE18,
            targetSize: size,
            remainingSize: size,
            expiresAt: expiresAt
        });
        self.latestIntentHashes.push(intentHash);
        emit SolverOrderIntentCommitted(batchId, intentHash, tokenId, side, priceE18, size, size, expiresAt);
    }

    function clearLatestOrderIntents(PMFVaultTypes.IntentState storage self) private {
        for (uint256 index = 0; index < self.latestIntentHashes.length; index++) {
            delete self.solverOrderIntents[self.latestIntentHashes[index]];
        }
        delete self.latestIntentHashes;
    }

    function boundedBuyPrice(uint16 maxSlippageBps, uint256 bestAskE18) private pure returns (uint256) {
        uint256 price = bestAskE18.mulDiv(BPS_DENOMINATOR + maxSlippageBps, BPS_DENOMINATOR, Math.Rounding.Ceil);
        return price <= E18 ? price : 0;
    }

    function boundedSellPrice(uint16 maxSlippageBps, uint256 bestBidE18) private pure returns (uint256) {
        if (maxSlippageBps >= BPS_DENOMINATOR) {
            return 0;
        }
        return bestBidE18.mulDiv(BPS_DENOMINATOR - maxSlippageBps, BPS_DENOMINATOR, Math.Rounding.Floor);
    }

    function desiredSize(uint256 deltaValue, uint256 referencePriceE18) private pure returns (uint256) {
        return deltaValue.mulDiv(E18, referencePriceE18, Math.Rounding.Floor);
    }

    function assetsForFill(uint256 fillSize, uint256 priceE18) public pure returns (uint256) {
        return fillSize.mulDiv(priceE18, E18, Math.Rounding.Ceil);
    }

    function sideAllowed(uint8 allowedSides, uint8 side) private pure returns (bool) {
        return (allowedSides & side) == side;
    }

    function min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
