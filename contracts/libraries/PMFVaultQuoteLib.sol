// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IPMFBasketOracle} from "../interfaces/IPMFBasketOracle.sol";
import {IPMFPricingRouter} from "../interfaces/IPMFPricingRouter.sol";
import {PMFVaultTypes} from "./PMFVaultTypes.sol";

library PMFVaultQuoteLib {
    uint8 private constant PRICING_MODE_SNAPSHOT = 1;
    uint8 private constant PRICING_MODE_PRIMARY = 2;
    bytes32 private constant QUOTE_REFERENCE_TYPEHASH = keccak256(
        "QuoteReference(bytes32 basketFeedId,bytes32 basketHash,uint80 basketRoundId,address basketSource,"
        "uint64 basketSourceRevision,bytes32 pricingFeedId,uint8 pricingMode,address pricingSource,"
        "bytes32 pricingReportHash,uint64 pricingAsOf)"
    );
    bytes32 private constant AP_DEPOSIT_QUOTE_TYPEHASH = keccak256(
        "APDepositQuote(bytes32 quoteId,bytes32 nonce,address payer,address receiver,uint256 grossAssets,"
        "uint256 spreadAssets,uint256 minShares,QuoteReference quoteReference,uint64 deadline)"
        "QuoteReference(bytes32 basketFeedId,bytes32 basketHash,uint80 basketRoundId,address basketSource,"
        "uint64 basketSourceRevision,bytes32 pricingFeedId,uint8 pricingMode,address pricingSource,"
        "bytes32 pricingReportHash,uint64 pricingAsOf)"
    );
    bytes32 private constant AP_REDEEM_QUOTE_TYPEHASH = keccak256(
        "APRedeemQuote(bytes32 quoteId,bytes32 nonce,address controller,address owner,address receiver,"
        "uint256 shares,uint256 assets,QuoteReference quoteReference,uint64 deadline)"
        "QuoteReference(bytes32 basketFeedId,bytes32 basketHash,uint80 basketRoundId,address basketSource,"
        "uint64 basketSourceRevision,bytes32 pricingFeedId,uint8 pricingMode,address pricingSource,"
        "bytes32 pricingReportHash,uint64 pricingAsOf)"
    );

    struct QuoteContext {
        address basketOracle;
        address pricingRouter;
        bytes32 basketFeedId;
        bytes32 pricingFeedId;
        address basketSource;
        uint64 basketSourceRevision;
        bytes32 latestReportHash;
        uint64 latestReportAsOf;
    }

    error InvalidAddress();
    error InvalidAmount();
    error InvalidQuoteReference();
    error ExpiredAPQuote(uint64 deadline);
    error QuotePayerMismatch(address expectedPayer, address actualPayer);

    function hashDeposit(PMFVaultTypes.APDepositQuote calldata auth) external pure returns (bytes32) {
        return keccak256(
            abi.encode(
                AP_DEPOSIT_QUOTE_TYPEHASH,
                auth.quoteId,
                auth.nonce,
                auth.payer,
                auth.receiver,
                auth.grossAssets,
                auth.spreadAssets,
                auth.minShares,
                hashQuoteReference(auth.quoteReference),
                auth.deadline
            )
        );
    }

    function hashRedeem(PMFVaultTypes.APRedeemQuote calldata auth) external pure returns (bytes32) {
        return keccak256(
            abi.encode(
                AP_REDEEM_QUOTE_TYPEHASH,
                auth.quoteId,
                auth.nonce,
                auth.controller,
                auth.owner,
                auth.receiver,
                auth.shares,
                auth.assets,
                hashQuoteReference(auth.quoteReference),
                auth.deadline
            )
        );
    }

    function validateDeposit(PMFVaultTypes.APDepositQuote calldata auth, address sender, QuoteContext memory context)
        external
        view
    {
        if (block.timestamp > auth.deadline) {
            revert ExpiredAPQuote(auth.deadline);
        }
        if (auth.payer != sender) {
            revert QuotePayerMismatch(auth.payer, sender);
        }
        if (auth.receiver == address(0) || auth.payer == address(0)) {
            revert InvalidAddress();
        }
        if (auth.grossAssets == 0 || auth.minShares == 0 || auth.spreadAssets >= auth.grossAssets) {
            revert InvalidAmount();
        }
        validateQuoteReference(auth.quoteReference, context);
    }

    function validateRedeem(PMFVaultTypes.APRedeemQuote calldata auth, QuoteContext memory context) external view {
        if (block.timestamp > auth.deadline) {
            revert ExpiredAPQuote(auth.deadline);
        }
        if (auth.controller == address(0) || auth.owner == address(0) || auth.receiver == address(0)) {
            revert InvalidAddress();
        }
        if (auth.shares == 0 || auth.assets == 0) {
            revert InvalidAmount();
        }
        validateQuoteReference(auth.quoteReference, context);
    }

    function hashQuoteReference(PMFVaultTypes.QuoteReference calldata quoteRef) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                QUOTE_REFERENCE_TYPEHASH,
                quoteRef.basketFeedId,
                quoteRef.basketHash,
                quoteRef.basketRoundId,
                quoteRef.basketSource,
                quoteRef.basketSourceRevision,
                quoteRef.pricingFeedId,
                quoteRef.pricingMode,
                quoteRef.pricingSource,
                quoteRef.pricingReportHash,
                quoteRef.pricingAsOf
            )
        );
    }

    function validateQuoteReference(PMFVaultTypes.QuoteReference calldata quoteRef, QuoteContext memory context)
        private
        view
    {
        IPMFBasketOracle.BasketHeader memory header = IPMFBasketOracle(context.basketOracle).latestBasket();
        if (
            quoteRef.basketFeedId != context.basketFeedId || quoteRef.basketHash != header.basketHash
                || quoteRef.basketRoundId != header.roundId || quoteRef.basketSource != context.basketSource
                || quoteRef.basketSourceRevision != context.basketSourceRevision
                || quoteRef.pricingFeedId != context.pricingFeedId
        ) {
            revert InvalidQuoteReference();
        }
        IPMFPricingRouter(context.pricingRouter).validatePricingReference(
            quoteRef.pricingFeedId,
            quoteRef.pricingMode,
            quoteRef.pricingSource
        );
        if (quoteRef.pricingMode == PRICING_MODE_SNAPSHOT) {
            if (
                quoteRef.pricingReportHash != context.latestReportHash
                    || quoteRef.pricingAsOf != context.latestReportAsOf
            ) {
                revert InvalidQuoteReference();
            }
            return;
        }
        if (
            quoteRef.pricingMode != PRICING_MODE_PRIMARY || quoteRef.pricingReportHash == bytes32(0)
                || quoteRef.pricingAsOf == 0 || quoteRef.pricingAsOf > block.timestamp
        ) {
            revert InvalidQuoteReference();
        }
    }
}
