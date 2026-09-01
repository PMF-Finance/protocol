// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {PMFVaultTypes} from "./libraries/PMFVaultTypes.sol";

interface ICollateralOnramp {
    function wrap(address asset, address to, uint256 amount) external;
}

interface IPMFDepositVault {
    function asset() external view returns (address);

    function depositWithAPQuote(PMFVaultTypes.APDepositQuote calldata auth, bytes calldata signature)
        external
        returns (uint256 shares);
}

/**
 * @title FateDepositRouter
 * @notice Escrows Polygon pUSD for asynchronous, AP-priced PMF vault deposits.
 * @dev Admission can be paused without disabling fills, cancellations, or expiry refunds.
 *      The contract is intentionally not upgradeable. Existing orders retain the vault
 *      selected when they were funded even if product admission is later reconfigured.
 */
contract FateDepositRouter is AccessControl, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    bytes32 public constant PRODUCT_MANAGER_ROLE = keccak256("PRODUCT_MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant ADMISSION_SIGNER_ROLE = keccak256("ADMISSION_SIGNER_ROLE");

    uint16 public constant DEFAULT_MAX_SPREAD_BPS = 200;
    uint16 public constant MAX_SPREAD_BPS = 1_000;
    uint32 public constant MIN_TTL_SECONDS = 1 days;
    uint32 public constant MAX_TTL_SECONDS = 30 days;
    uint32 public constant DEFAULT_TTL_SECONDS = 7 days;
    uint256 public constant ABSOLUTE_ESCROW_CEILING = 10_000e6;

    bytes32 private constant CANCEL_TYPEHASH =
        keccak256("CancelDepositOrder(bytes32 orderId,uint256 nonce,uint64 deadline)");
    bytes32 private constant DEPOSIT_AUTHORIZATION_TYPEHASH = keccak256(
        // solhint-disable-next-line max-line-length
        "DepositAuthorization(bytes32 orderId,bytes32 productId,address beneficiary,uint256 amount,uint16 maxSpreadBps,uint32 ttlSeconds,address fundingAsset,uint64 fundingDeadline)"
    );
    bytes32 private constant ROUTER_FILL_TYPEHASH =
        keccak256("RouterFill(bytes32 orderId,uint256 filledAssets,uint256 grossAssets)");

    enum OrderStatus {
        None,
        Open,
        Filled,
        Cancelled,
        Expired
    }

    struct ProductConfig {
        address vault;
        uint256 maxOrderAssets;
        uint64 nextSequence;
        bool admissionEnabled;
    }

    struct DepositOrder {
        bytes32 productId;
        address vault;
        address beneficiary;
        uint256 fundedAssets;
        uint256 remainingAssets;
        uint256 sharesDelivered;
        uint16 maxSpreadBps;
        uint64 sequence;
        uint64 fundedAt;
        uint64 expiresAt;
        OrderStatus status;
    }

    struct DepositAuthorization {
        bytes32 orderId;
        bytes32 productId;
        address beneficiary;
        uint256 amount;
        uint16 maxSpreadBps;
        uint32 ttlSeconds;
        address fundingAsset;
        uint64 fundingDeadline;
    }

    IERC20 public immutable pUSD;
    IERC20 public immutable usdce;
    ICollateralOnramp public immutable collateralOnramp;

    uint256 public totalEscrowedPusd;
    mapping(bytes32 productId => ProductConfig config) public products;
    mapping(bytes32 orderId => DepositOrder order) public orders;
    mapping(bytes32 orderId => uint256 nonce) public cancellationNonces;

    event ProductConfigured(
        bytes32 indexed productId,
        address indexed vault,
        uint256 maxOrderAssets,
        bool admissionEnabled
    );
    event DepositOrderFunded(
        bytes32 indexed orderId,
        bytes32 indexed productId,
        address indexed beneficiary,
        address vault,
        uint256 fundedAssets,
        uint16 maxSpreadBps,
        uint64 sequence,
        uint64 fundedAt,
        uint64 expiresAt
    );
    event DepositOrderFilled(
        bytes32 indexed orderId,
        bytes32 indexed quoteId,
        uint256 grossAssets,
        uint256 shares,
        uint256 remainingAssets,
        uint256 totalSharesDelivered
    );
    event DepositOrderCancelled(bytes32 indexed orderId, address indexed beneficiary, uint256 refundedAssets);
    event DepositOrderExpired(bytes32 indexed orderId, address indexed beneficiary, uint256 refundedAssets);
    event DepositAuthorizationUsed(
        bytes32 indexed orderId,
        address indexed signer,
        address indexed fundingAsset,
        uint64 fundingDeadline
    );
    event SurplusRescued(address indexed token, address indexed recipient, uint256 amount);

    error InvalidAddress();
    error InvalidContract(address account);
    error InvalidTokenDecimals(address token, uint8 expected, uint8 actual);
    error InvalidProduct();
    error InvalidAmount();
    error InvalidExpiry();
    error InvalidSpread();
    error InvalidOrderStatus(OrderStatus expected, OrderStatus actual);
    error DuplicateOrder(bytes32 orderId);
    error ProductAdmissionDisabled(bytes32 productId);
    error OrderLimitExceeded(uint256 amount, uint256 limit);
    error OrderExpired(uint64 expiresAt);
    error OrderNotExpired(uint64 expiresAt);
    error UnauthorizedBeneficiary(address expected, address actual);
    error QuotePayerMismatch(address expected, address actual);
    error QuoteReceiverMismatch(address expected, address actual);
    error QuoteAmountExceeded(uint256 requested, uint256 remaining);
    error QuoteSpreadExceeded(uint256 spreadAssets, uint256 grossAssets, uint16 maxSpreadBps);
    error WrappedAmountMismatch(uint256 expected, uint256 actual);
    error VaultAssetConsumptionMismatch(uint256 expected, uint256 actual);
    error InvalidAdmissionSignature();
    error ExpiredDepositAuthorization(uint64 deadline);
    error FundingAssetMismatch(address expected, address actual);
    error QuoteOrderMismatch(bytes32 expected, bytes32 actual);
    error InvalidCancellationNonce(uint256 expected, uint256 actual);
    error ExpiredCancellationSignature(uint64 deadline);
    error InvalidCancellationSignature();
    error EscrowRescueExceeded(uint256 requested, uint256 available);
    error EscrowCeilingExceeded(uint256 requestedTotal, uint256 ceiling);

    constructor(address pusd_, address usdce_, address collateralOnramp_, address admin_)
        EIP712("Fate Deposit Router", "1")
    {
        if (pusd_ == address(0) || usdce_ == address(0) || collateralOnramp_ == address(0) || admin_ == address(0)) {
            revert InvalidAddress();
        }
        if (pusd_ == usdce_) revert InvalidAddress();
        if (pusd_.code.length == 0) revert InvalidContract(pusd_);
        if (usdce_.code.length == 0) revert InvalidContract(usdce_);
        if (collateralOnramp_.code.length == 0) revert InvalidContract(collateralOnramp_);
        uint8 pusdDecimals = IERC20Metadata(pusd_).decimals();
        if (pusdDecimals != 6) revert InvalidTokenDecimals(pusd_, 6, pusdDecimals);
        uint8 usdceDecimals = IERC20Metadata(usdce_).decimals();
        if (usdceDecimals != 6) revert InvalidTokenDecimals(usdce_, 6, usdceDecimals);
        pUSD = IERC20(pusd_);
        usdce = IERC20(usdce_);
        collateralOnramp = ICollateralOnramp(collateralOnramp_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(PRODUCT_MANAGER_ROLE, admin_);
        _grantRole(PAUSER_ROLE, admin_);
    }

    function setProduct(bytes32 productId, address vault, uint256 maxOrderAssets, bool admissionEnabled)
        external
        onlyRole(PRODUCT_MANAGER_ROLE)
    {
        if (productId == bytes32(0)) revert InvalidProduct();
        if (vault == address(0)) revert InvalidAddress();
        if (vault.code.length == 0) revert InvalidContract(vault);
        if (IPMFDepositVault(vault).asset() != address(pUSD)) revert InvalidAddress();
        ProductConfig storage config = products[productId];
        config.vault = vault;
        config.maxOrderAssets = maxOrderAssets;
        config.admissionEnabled = admissionEnabled;
        emit ProductConfigured(productId, vault, maxOrderAssets, admissionEnabled);
    }

    /// @dev Balance deltas enforce exact 1:1 wrapping; nonReentrant protects the full interaction.
    // slither-disable-next-line reentrancy-balance,reentrancy-no-eth
    function depositUSDCe(DepositAuthorization calldata authorization, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
    {
        address signer = _validateAdmission(authorization, address(usdce), signature);
        uint256 balanceBefore = pUSD.balanceOf(address(this));
        usdce.safeTransferFrom(msg.sender, address(this), authorization.amount);
        usdce.forceApprove(address(collateralOnramp), authorization.amount);
        collateralOnramp.wrap(address(usdce), address(this), authorization.amount);
        usdce.forceApprove(address(collateralOnramp), 0);
        uint256 wrapped = pUSD.balanceOf(address(this)) - balanceBefore;
        if (wrapped != authorization.amount) revert WrappedAmountMismatch(authorization.amount, wrapped);
        _createOrder(authorization, wrapped, signer);
    }

    /// @dev Balance deltas reject fee-on-transfer behavior; nonReentrant protects the full interaction.
    // slither-disable-next-line reentrancy-balance,reentrancy-no-eth
    function depositPUSD(DepositAuthorization calldata authorization, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
    {
        address signer = _validateAdmission(authorization, address(pUSD), signature);
        uint256 balanceBefore = pUSD.balanceOf(address(this));
        pUSD.safeTransferFrom(msg.sender, address(this), authorization.amount);
        uint256 received = pUSD.balanceOf(address(this)) - balanceBefore;
        if (received != authorization.amount) revert WrappedAmountMismatch(authorization.amount, received);
        _createOrder(authorization, received, signer);
    }

    /// @dev Remaining escrow is reduced before the guarded external vault call.
    // slither-disable-next-line reentrancy-balance,reentrancy-no-eth
    function fill(bytes32 orderId, PMFVaultTypes.APDepositQuote calldata auth, bytes calldata signature)
        external
        nonReentrant
        returns (uint256 shares)
    {
        DepositOrder storage order = orders[orderId];
        _requireOpen(order);
        if (block.timestamp >= order.expiresAt) revert OrderExpired(order.expiresAt);
        if (auth.payer != address(this)) revert QuotePayerMismatch(address(this), auth.payer);
        if (auth.receiver != order.beneficiary) {
            revert QuoteReceiverMismatch(order.beneficiary, auth.receiver);
        }
        if (auth.grossAssets == 0 || auth.grossAssets > order.remainingAssets) {
            revert QuoteAmountExceeded(auth.grossAssets, order.remainingAssets);
        }
        bytes32 expectedQuoteId = expectedRouterQuoteId(orderId, auth.grossAssets);
        if (auth.quoteId != expectedQuoteId) revert QuoteOrderMismatch(expectedQuoteId, auth.quoteId);
        if (auth.spreadAssets * 10_000 > auth.grossAssets * order.maxSpreadBps) {
            revert QuoteSpreadExceeded(auth.spreadAssets, auth.grossAssets, order.maxSpreadBps);
        }

        order.remainingAssets -= auth.grossAssets;
        totalEscrowedPusd -= auth.grossAssets;
        uint256 balanceBefore = pUSD.balanceOf(address(this));
        pUSD.forceApprove(order.vault, auth.grossAssets);
        shares = IPMFDepositVault(order.vault).depositWithAPQuote(auth, signature);
        pUSD.forceApprove(order.vault, 0);
        uint256 balanceAfter = pUSD.balanceOf(address(this));
        uint256 consumed = balanceBefore >= balanceAfter ? balanceBefore - balanceAfter : 0;
        if (consumed != auth.grossAssets) {
            revert VaultAssetConsumptionMismatch(auth.grossAssets, consumed);
        }
        order.sharesDelivered += shares;
        if (order.remainingAssets == 0) order.status = OrderStatus.Filled;

        emit DepositOrderFilled(
            orderId,
            auth.quoteId,
            auth.grossAssets,
            shares,
            order.remainingAssets,
            order.sharesDelivered
        );
    }

    function cancel(bytes32 orderId) external nonReentrant {
        DepositOrder storage order = orders[orderId];
        _requireOpen(order);
        if (msg.sender != order.beneficiary) {
            revert UnauthorizedBeneficiary(order.beneficiary, msg.sender);
        }
        _refund(orderId, order, OrderStatus.Cancelled);
    }

    function cancelWithSig(bytes32 orderId, uint256 nonce, uint64 deadline, bytes calldata signature)
        external
        nonReentrant
    {
        DepositOrder storage order = orders[orderId];
        _requireOpen(order);
        if (block.timestamp > deadline) revert ExpiredCancellationSignature(deadline);
        uint256 expectedNonce = cancellationNonces[orderId];
        if (nonce != expectedNonce) revert InvalidCancellationNonce(expectedNonce, nonce);
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CANCEL_TYPEHASH, orderId, nonce, deadline)));
        if (!SignatureChecker.isValidSignatureNow(order.beneficiary, digest, signature)) {
            revert InvalidCancellationSignature();
        }
        cancellationNonces[orderId] = expectedNonce + 1;
        _refund(orderId, order, OrderStatus.Cancelled);
    }

    function expire(bytes32 orderId) external nonReentrant {
        DepositOrder storage order = orders[orderId];
        _requireOpen(order);
        if (block.timestamp < order.expiresAt) revert OrderNotExpired(order.expiresAt);
        _refund(orderId, order, OrderStatus.Expired);
    }

    function cancelDigest(bytes32 orderId, uint256 nonce, uint64 deadline) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CANCEL_TYPEHASH, orderId, nonce, deadline)));
    }

    function depositAuthorizationDigest(DepositAuthorization calldata authorization) external view returns (bytes32) {
        return _depositAuthorizationDigest(authorization);
    }

    function expectedRouterQuoteId(bytes32 orderId, uint256 grossAssets) public view returns (bytes32) {
        DepositOrder storage order = orders[orderId];
        uint256 filledAssets = order.fundedAssets - order.remainingAssets;
        return _hashTypedDataV4(keccak256(abi.encode(ROUTER_FILL_TYPEHASH, orderId, filledAssets, grossAssets)));
    }

    function rescueSurplus(address token, address recipient, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        if (token == address(0) || recipient == address(0)) revert InvalidAddress();
        if (token == address(pUSD)) {
            uint256 balance = pUSD.balanceOf(address(this));
            uint256 available = balance > totalEscrowedPusd ? balance - totalEscrowedPusd : 0;
            if (amount > available) revert EscrowRescueExceeded(amount, available);
        }
        IERC20(token).safeTransfer(recipient, amount);
        emit SurplusRescued(token, recipient, amount);
    }

    function pauseAdmission() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpauseAdmission() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function _validateAdmission(
        DepositAuthorization calldata authorization,
        address expectedFundingAsset,
        bytes calldata signature
    ) private view returns (address signer) {
        if (authorization.orderId == bytes32(0) || authorization.productId == bytes32(0)) revert InvalidProduct();
        if (orders[authorization.orderId].status != OrderStatus.None) revert DuplicateOrder(authorization.orderId);
        if (authorization.beneficiary == address(0)) revert InvalidAddress();
        if (authorization.amount == 0) revert InvalidAmount();
        if (authorization.maxSpreadBps > MAX_SPREAD_BPS) revert InvalidSpread();
        if (authorization.ttlSeconds < MIN_TTL_SECONDS || authorization.ttlSeconds > MAX_TTL_SECONDS) {
            revert InvalidExpiry();
        }
        if (authorization.fundingAsset != expectedFundingAsset) {
            revert FundingAssetMismatch(expectedFundingAsset, authorization.fundingAsset);
        }
        if (block.timestamp > authorization.fundingDeadline) {
            revert ExpiredDepositAuthorization(authorization.fundingDeadline);
        }
        signer = ECDSA.recover(_depositAuthorizationDigest(authorization), signature);
        if (!hasRole(ADMISSION_SIGNER_ROLE, signer)) revert InvalidAdmissionSignature();
        ProductConfig storage config = products[authorization.productId];
        if (!config.admissionEnabled || config.vault == address(0)) {
            revert ProductAdmissionDisabled(authorization.productId);
        }
        if (config.maxOrderAssets != 0 && authorization.amount > config.maxOrderAssets) {
            revert OrderLimitExceeded(authorization.amount, config.maxOrderAssets);
        }
        uint256 requestedTotal = totalEscrowedPusd + authorization.amount;
        if (requestedTotal > ABSOLUTE_ESCROW_CEILING) {
            revert EscrowCeilingExceeded(requestedTotal, ABSOLUTE_ESCROW_CEILING);
        }
    }

    function _createOrder(DepositAuthorization calldata authorization, uint256 amount, address signer) private {
        ProductConfig storage config = products[authorization.productId];
        uint64 sequence = config.nextSequence + 1;
        config.nextSequence = sequence;
        uint64 fundedAt = uint64(block.timestamp);
        uint64 expiresAt = fundedAt + authorization.ttlSeconds;
        orders[authorization.orderId] = DepositOrder({
            productId: authorization.productId,
            vault: config.vault,
            beneficiary: authorization.beneficiary,
            fundedAssets: amount,
            remainingAssets: amount,
            sharesDelivered: 0,
            maxSpreadBps: authorization.maxSpreadBps,
            sequence: sequence,
            fundedAt: fundedAt,
            expiresAt: expiresAt,
            status: OrderStatus.Open
        });
        totalEscrowedPusd += amount;
        emit DepositAuthorizationUsed(
            authorization.orderId,
            signer,
            authorization.fundingAsset,
            authorization.fundingDeadline
        );
        emit DepositOrderFunded(
            authorization.orderId,
            authorization.productId,
            authorization.beneficiary,
            config.vault,
            amount,
            authorization.maxSpreadBps,
            sequence,
            fundedAt,
            expiresAt
        );
    }

    function _depositAuthorizationDigest(DepositAuthorization calldata authorization) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    DEPOSIT_AUTHORIZATION_TYPEHASH,
                    authorization.orderId,
                    authorization.productId,
                    authorization.beneficiary,
                    authorization.amount,
                    authorization.maxSpreadBps,
                    authorization.ttlSeconds,
                    authorization.fundingAsset,
                    authorization.fundingDeadline
                )
            )
        );
    }

    function _requireOpen(DepositOrder storage order) private view {
        if (order.status != OrderStatus.Open) revert InvalidOrderStatus(OrderStatus.Open, order.status);
    }

    function _refund(bytes32 orderId, DepositOrder storage order, OrderStatus terminalStatus) private {
        uint256 refund = order.remainingAssets;
        order.remainingAssets = 0;
        order.status = terminalStatus;
        totalEscrowedPusd -= refund;
        pUSD.safeTransfer(order.beneficiary, refund);
        if (terminalStatus == OrderStatus.Cancelled) {
            emit DepositOrderCancelled(orderId, order.beneficiary, refund);
        } else {
            emit DepositOrderExpired(orderId, order.beneficiary, refund);
        }
    }
}
