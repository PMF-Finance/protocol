// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

library PMFVaultTypes {
    struct OrderMandate {
        address tradingWallet;
        bool tradingEnabled;
        uint8 allowedSides;
        uint16 maxSlippageBps;
        uint16 maxSpreadBps;
        uint16 maxDepthParticipationBps;
        uint16 maxOrdersPerPlan;
        uint64 staleAfterSeconds;
        uint64 orderExpirySeconds;
        uint256 minOrderNotional;
        uint256 maxOrderNotional;
        uint256 minVaultCashBuffer;
        uint64 mandateRevision;
        uint64 updatedAt;
    }

    struct OrderMandateUpdate {
        address tradingWallet;
        bool tradingEnabled;
        uint8 allowedSides;
        uint16 maxSlippageBps;
        uint16 maxSpreadBps;
        uint16 maxDepthParticipationBps;
        uint16 maxOrdersPerPlan;
        uint64 staleAfterSeconds;
        uint64 orderExpirySeconds;
        uint256 minOrderNotional;
        uint256 maxOrderNotional;
        uint256 minVaultCashBuffer;
    }

    struct VaultInit {
        address admin;
        address manager;
        address navReporter;
        address managementFeeRecipient;
        uint16 managementFeeBps;
        address[] initialAPs;
        OrderMandateUpdate initialMandate;
    }

    struct TradingAssetsReport {
        uint256 externalAssets;
        bytes32 basketFeedId;
        bytes32 basketHash;
        uint80 oracleRoundId;
        address basketSource;
        uint64 basketSourceRevision;
        uint64 asOf;
        uint64 reportedAt;
        bytes32 reportHash;
    }

    struct QuoteReference {
        bytes32 basketFeedId;
        bytes32 basketHash;
        uint80 basketRoundId;
        address basketSource;
        uint64 basketSourceRevision;
        bytes32 pricingFeedId;
        uint8 pricingMode;
        address pricingSource;
        bytes32 pricingReportHash;
        uint64 pricingAsOf;
    }

    struct APDepositQuote {
        bytes32 quoteId;
        bytes32 nonce;
        address payer;
        address receiver;
        uint256 grossAssets;
        uint256 spreadAssets;
        uint256 minShares;
        QuoteReference quoteReference;
        uint64 deadline;
    }

    struct APRedeemQuote {
        bytes32 quoteId;
        bytes32 nonce;
        address controller;
        address owner;
        address receiver;
        uint256 shares;
        uint256 assets;
        QuoteReference quoteReference;
        uint64 deadline;
    }

    struct OrderIntentBatch {
        bytes32 batchId;
        bytes32 basketFeedId;
        bytes32 basketHash;
        uint80 oracleRoundId;
        address basketSource;
        uint64 basketSourceRevision;
        bytes32 mandateHash;
        uint64 expiresAt;
        uint64 committedAt;
        uint256 intentCount;
        bool active;
    }

    struct SolverOrderIntent {
        bytes32 intentHash;
        bytes32 batchId;
        uint8 side;
        uint256 tokenId;
        uint256 priceE18;
        uint256 targetSize;
        uint256 remainingSize;
        uint64 expiresAt;
    }

    struct IntentState {
        OrderIntentBatch latestOrderIntentBatch;
        bytes32[] latestIntentHashes;
        mapping(bytes32 intentHash => SolverOrderIntent intent) solverOrderIntents;
    }

    struct ResidualIntentBatch {
        bytes32 batchId;
        bytes32 mandateHash;
        uint64 expiresAt;
        uint64 committedAt;
        uint256 intentCount;
        bool active;
    }

    struct ResidualSellIntent {
        bytes32 intentHash;
        bytes32 batchId;
        uint256 tokenId;
        uint256 priceE18;
        uint256 targetSize;
        uint256 remainingSize;
        uint64 expiresAt;
    }

    struct ResidualInventory {
        uint256 tokenId;
        uint8 state;
        uint64 attemptCount;
        uint64 cooldownUntil;
        uint64 lastUpdatedAt;
        bytes32 lastIntentHash;
    }

    struct ResidualState {
        ResidualIntentBatch latestResidualIntentBatch;
        bytes32[] latestResidualIntentHashes;
        mapping(uint256 tokenId => bool known) knownTokenId;
        mapping(uint256 tokenId => ResidualInventory inventory) residualInventory;
        mapping(bytes32 intentHash => ResidualSellIntent intent) residualSellIntents;
    }

    struct RedemptionRequest {
        uint256 requestId;
        address controller;
        address owner;
        address receiver;
        uint256 shares;
        uint256 grossAssets;
        uint256 assets;
        uint256 paidAssets;
        uint256 remainingAssets;
        uint64 requestedAt;
        uint256 nextRequestId;
    }

    struct APFeeClaim {
        address apSigner;
        address recipient;
        uint256 originalAssets;
        uint256 paidAssets;
        uint256 remainingAssets;
    }

    struct RedemptionState {
        uint256 nextRequestId;
        uint256 queueHead;
        uint256 queueTail;
        uint256 totalPendingAssets;
        uint256 totalPaidAssets;
        mapping(uint256 requestId => RedemptionRequest request) requests;
        mapping(uint256 requestId => APFeeClaim claim) apFeeClaims;
    }
}
