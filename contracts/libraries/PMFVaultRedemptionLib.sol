// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PMFVaultTypes} from "./PMFVaultTypes.sol";

library PMFVaultRedemptionLib {
    using SafeERC20 for IERC20;
    using Math for uint256;

    event RedeemRequest(
        address indexed controller,
        address indexed owner,
        uint256 indexed requestId,
        address sender,
        uint256 shares
    );
    event RedemptionQueued(
        uint256 indexed requestId,
        address indexed controller,
        address indexed receiver,
        uint256 shares,
        uint256 grossAssets,
        uint256 assets
    );
    event RedemptionPaid(
        uint256 indexed requestId,
        address indexed receiver,
        uint256 assets,
        uint256 remainingAssets
    );
    event APFeePaid(
        uint256 indexed requestId,
        address indexed recipient,
        uint256 assets,
        uint256 remainingAssets
    );
    event RedemptionCompleted(uint256 indexed requestId);

    error InvalidAddress();
    error InvalidAmount();
    function enqueue(
        PMFVaultTypes.RedemptionState storage self,
        address controller,
        address owner,
        address receiver,
        address sender,
        uint256 shares,
        uint256 grossAssets,
        uint256 assets,
        address apSigner,
        address apFeeRecipient
    ) public returns (uint256 requestId) {
        if (
            controller == address(0) || owner == address(0) || receiver == address(0)
                || apFeeRecipient == address(0)
        ) {
            revert InvalidAddress();
        }
        if (shares == 0 || grossAssets == 0 || assets == 0 || assets > grossAssets) {
            revert InvalidAmount();
        }
        uint256 apFeeAssets = grossAssets - assets;
        if (self.nextRequestId == 0) {
            self.nextRequestId = 1;
        }

        requestId = self.nextRequestId;
        self.nextRequestId = requestId + 1;

        PMFVaultTypes.RedemptionRequest storage queued = self.requests[requestId];
        queued.requestId = requestId;
        queued.controller = controller;
        queued.owner = owner;
        queued.receiver = receiver;
        queued.shares = shares;
        queued.grossAssets = grossAssets;
        queued.assets = assets;
        queued.remainingAssets = assets;
        queued.requestedAt = uint64(block.timestamp);
        self.apFeeClaims[requestId] = PMFVaultTypes.APFeeClaim({
            apSigner: apSigner,
            recipient: apFeeRecipient,
            originalAssets: apFeeAssets,
            paidAssets: 0,
            remainingAssets: apFeeAssets
        });

        if (self.queueHead == 0) {
            self.queueHead = requestId;
        } else {
            self.requests[self.queueTail].nextRequestId = requestId;
        }
        self.queueTail = requestId;
        self.totalPendingAssets += grossAssets;

        emit RedeemRequest(controller, owner, requestId, sender, shares);
        emit RedemptionQueued(requestId, controller, receiver, shares, grossAssets, assets);
    }

    // The vault's only entry paths are nonReentrant and all claim state is
    // updated before transfers. A later loop iteration can emit after an
    // earlier iteration's transfer, which is safe but triggers this detector.
    // slither-disable-next-line reentrancy-events
    function process(
        PMFVaultTypes.RedemptionState storage self,
        IERC20 asset,
        uint256 availableAssets,
        uint256 maxRequests
    ) public returns (uint256 paidAssets, uint256 processedRequests) {
        if (maxRequests == 0) {
            revert InvalidAmount();
        }

        uint256 current = self.queueHead;
        while (current != 0 && availableAssets > 0 && processedRequests < maxRequests) {
            PMFVaultTypes.RedemptionRequest storage queued = self.requests[current];
            PMFVaultTypes.APFeeClaim storage apFeeClaim = self.apFeeClaims[current];
            uint256 totalRemaining = queued.remainingAssets + apFeeClaim.remainingAssets;
            uint256 payment = totalRemaining < availableAssets ? totalRemaining : availableAssets;
            uint256 apFeePayment;
            uint256 userPayment;
            if (payment == totalRemaining) {
                userPayment = queued.remainingAssets;
                apFeePayment = apFeeClaim.remainingAssets;
            } else {
                apFeePayment =
                    payment.mulDiv(apFeeClaim.remainingAssets, totalRemaining, Math.Rounding.Floor);
                userPayment = payment - apFeePayment;
                if (userPayment > queued.remainingAssets) {
                    userPayment = queued.remainingAssets;
                    apFeePayment = payment - userPayment;
                }
            }

            queued.remainingAssets -= userPayment;
            queued.paidAssets += userPayment;
            apFeeClaim.remainingAssets -= apFeePayment;
            apFeeClaim.paidAssets += apFeePayment;
            self.totalPendingAssets -= payment;
            self.totalPaidAssets += userPayment;
            availableAssets -= payment;
            paidAssets += payment;

            address receiver = queued.receiver;
            address apFeeRecipient = apFeeClaim.recipient;
            bool completed = queued.remainingAssets == 0 && apFeeClaim.remainingAssets == 0;
            uint256 next = queued.nextRequestId;
            if (completed) {
                self.queueHead = next;
                if (next == 0) {
                    self.queueTail = 0;
                }
                processedRequests += 1;
            }

            if (userPayment > 0) {
                emit RedemptionPaid(current, receiver, userPayment, queued.remainingAssets);
            }
            if (apFeePayment > 0) {
                emit APFeePaid(
                    current,
                    apFeeRecipient,
                    apFeePayment,
                    apFeeClaim.remainingAssets
                );
            }
            if (completed) {
                emit RedemptionCompleted(current);
            }
            if (userPayment > 0) {
                asset.safeTransfer(receiver, userPayment);
            }
            if (apFeePayment > 0) {
                asset.safeTransfer(apFeeRecipient, apFeePayment);
            }

            if (!completed) {
                break;
            }
            current = next;
        }
    }
    function getRequest(PMFVaultTypes.RedemptionState storage self, uint256 requestId)
        public
        view
        returns (PMFVaultTypes.RedemptionRequest memory)
    {
        return self.requests[requestId];
    }

}
