// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {PMFVaultTypes} from "../libraries/PMFVaultTypes.sol";

contract MockDepositVault is ERC20 {
    using SafeERC20 for IERC20;

    error InvalidAddress();
    error PayerMismatch();

    address private immutable vaultAsset;

    event APQuoteDeposit(
        bytes32 indexed quoteId,
        bytes32 indexed nonce,
        address indexed signer,
        address payer,
        address receiver,
        uint256 grossAssets,
        uint256 spreadAssets,
        uint256 shares,
        address spreadRecipient
    );

    constructor(address asset_) ERC20("Mock Vault Share", "MVS") {
        if (asset_ == address(0)) revert InvalidAddress();
        vaultAsset = asset_;
    }

    function asset() external view returns (address) {
        return vaultAsset;
    }

    function depositWithAPQuote(PMFVaultTypes.APDepositQuote calldata auth, bytes calldata)
        external
        returns (uint256 shares)
    {
        if (auth.payer != msg.sender) revert PayerMismatch();
        IERC20(vaultAsset).safeTransferFrom(msg.sender, address(this), auth.grossAssets);
        shares = auth.grossAssets - auth.spreadAssets;
        _mint(auth.receiver, shares);
        emit APQuoteDeposit(
            auth.quoteId,
            auth.nonce,
            address(0xA11CE),
            auth.payer,
            auth.receiver,
            auth.grossAssets,
            auth.spreadAssets,
            shares,
            address(this)
        );
    }
}
