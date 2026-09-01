// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IMintableToken {
    function mint(address account, uint256 amount) external;
}

contract MockCollateralOnramp {
    using SafeERC20 for IERC20;

    error InvalidAddress();
    error UnsupportedAsset();

    address public immutable usdce;
    address public immutable pusd;

    constructor(address usdce_, address pusd_) {
        if (usdce_ == address(0) || pusd_ == address(0)) revert InvalidAddress();
        usdce = usdce_;
        pusd = pusd_;
    }

    function wrap(address asset, address to, uint256 amount) external {
        if (asset != usdce) revert UnsupportedAsset();
        IERC20(usdce).safeTransferFrom(msg.sender, address(this), amount);
        IMintableToken(pusd).mint(to, amount);
    }
}
