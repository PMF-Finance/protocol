// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {PMFVaultTypes} from "../libraries/PMFVaultTypes.sol";

interface IFateDepositRouterReentryTarget {
    function cancel(bytes32 orderId) external;
}

contract MockAdversarialDepositVault {
    using SafeERC20 for IERC20;

    error InvalidAddress();
    error ReentryUnexpectedlySucceeded();

    address public immutable vaultAsset;
    uint16 public immutable pullBps;
    bool public immutable attemptReentry;

    constructor(address asset_, uint16 pullBps_, bool attemptReentry_) {
        if (asset_ == address(0)) revert InvalidAddress();
        vaultAsset = asset_;
        pullBps = pullBps_;
        attemptReentry = attemptReentry_;
    }

    function asset() external view returns (address) {
        return vaultAsset;
    }

    function depositWithAPQuote(PMFVaultTypes.APDepositQuote calldata auth, bytes calldata signature)
        external
        returns (uint256 shares)
    {
        if (attemptReentry) {
            bytes32 orderId = abi.decode(signature, (bytes32));
            bool reentryBlocked = false;
            try IFateDepositRouterReentryTarget(msg.sender).cancel(orderId) {
                reentryBlocked = false;
            } catch {
                reentryBlocked = true;
            }
            if (!reentryBlocked) revert ReentryUnexpectedlySucceeded();
        }
        uint256 pulled = auth.grossAssets * pullBps / 10_000;
        IERC20(vaultAsset).safeTransferFrom(msg.sender, address(this), pulled);
        return pulled;
    }
}
