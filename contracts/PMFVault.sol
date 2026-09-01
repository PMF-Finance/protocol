// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IPMFBasketOracle} from "./interfaces/IPMFBasketOracle.sol";
import {IPMFBasketOracleRouter} from "./interfaces/IPMFBasketOracleRouter.sol";
import {IPMFPricingRouter} from "./interfaces/IPMFPricingRouter.sol";
import {PMFVaultAccountingLib} from "./libraries/PMFVaultAccountingLib.sol";
import {PMFVaultIntentLib} from "./libraries/PMFVaultIntentLib.sol";
import {PMFVaultQuoteLib} from "./libraries/PMFVaultQuoteLib.sol";
import {PMFVaultRedemptionLib} from "./libraries/PMFVaultRedemptionLib.sol";
import {PMFVaultResidualLib} from "./libraries/PMFVaultResidualLib.sol";
import {PMFVaultTypes} from "./libraries/PMFVaultTypes.sol";

/**
 * @title PMFVault
 * @author PMF
 * @notice ERC-4626 pUSD share vault with AP-only minting, AP-priced redemptions, and solver-fillable intents.
 * @dev Keeps the user liability ledger on-chain while large redemption/intent helpers live in immutable libraries.
 */
contract PMFVault is ERC4626, EIP712, Pausable, ReentrancyGuard, AccessControl, ERC1155Holder {
    using SafeERC20 for IERC20;
    using Math for uint256;
    using PMFVaultIntentLib for PMFVaultTypes.IntentState;
    using PMFVaultRedemptionLib for PMFVaultTypes.RedemptionState;
    using PMFVaultResidualLib for PMFVaultTypes.ResidualState;

    struct LifecycleState {
        bool windDownStarted;
        bool fundClosed;
        uint64 windDownStartedAt;
        uint64 fundClosedAt;
        uint256 markedDownExternalAssets;
    }

    bytes32 public constant AP_ROLE = keccak256("AP_ROLE");
    bytes32 public constant NAV_REPORTER_ROLE = keccak256("NAV_REPORTER_ROLE");
    bytes32 public constant MANDATE_MANAGER_ROLE = keccak256("MANDATE_MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant SOLVER_ROLE = keccak256("SOLVER_ROLE");
    bytes32 public constant ORDER_COMMITTER_ROLE = keccak256("ORDER_COMMITTER_ROLE");

    uint8 private constant SIDE_BUY = 1;
    uint8 private constant SIDE_SELL = 2;
    uint256 private constant AUTO_REDEMPTION_PROCESS_LIMIT = 8;
    uint16 private constant MAX_MANAGEMENT_FEE_BPS = 500;
    uint256 private constant BPS_SCALE = 10_000;
    uint256 private constant SECONDS_PER_YEAR = 365 days;
    uint256 private constant MANAGEMENT_FEE_REMAINDER_SCALE = 1e18;

    IPMFBasketOracleRouter public immutable basketOracleRouter;
    IPMFPricingRouter public immutable pricingRouter;
    IERC1155 public immutable conditionalTokens;
    bytes32 public immutable basketFeedId;
    bytes32 public immutable pricingFeedId;

    address public managementFeeRecipient;
    uint16 public managementFeeBps;
    uint64 public lastManagementFeeAccruedAt;
    uint256 private managementFeeShareRemainderScaled;

    PMFVaultTypes.OrderMandate private currentOrderMandate;
    PMFVaultTypes.TradingAssetsReport public latestTradingAssetsReport;
    LifecycleState private lifecycleState;
    PMFVaultTypes.IntentState private intentState;
    PMFVaultTypes.ResidualState private residualState;
    PMFVaultTypes.RedemptionState private redemptionState;

    mapping(address controller => mapping(address operator => bool approved)) public isOperator;
    mapping(bytes32 quoteDigest => bool used) public usedAPQuoteDigests;
    mapping(address signer => mapping(bytes32 quoteId => bool used)) public usedAPQuoteIds;
    mapping(address signer => mapping(bytes32 nonce => bool used)) public usedAPQuoteNonces;
    mapping(address apSigner => address recipient) public apFeeRecipient;

    event OperatorSet(address indexed controller, address indexed operator, bool approved);
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
    event APFeeRecipientUpdated(
        address indexed apSigner,
        address indexed previousRecipient,
        address indexed newRecipient
    );
    event TradingAssetsReported(
        uint256 externalAssets,
        bytes32 indexed basketHash,
        uint80 indexed oracleRoundId,
        uint64 asOf,
        bytes32 indexed reportHash
    );
    event OrderMandateUpdated(
        uint64 indexed mandateRevision,
        bytes32 indexed mandateHash,
        address indexed tradingWallet,
        uint64 updatedAt
    );
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
    event SolverOrderIntentFulfilled(
        bytes32 indexed batchId,
        bytes32 indexed intentHash,
        address indexed solver,
        uint8 side,
        uint256 tokenId,
        uint256 fillSize,
        uint256 priceE18,
        uint256 assets
    );
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
    event ResidualSellIntentFulfilled(
        bytes32 indexed batchId,
        bytes32 indexed intentHash,
        address indexed solver,
        uint256 tokenId,
        uint256 fillSize,
        uint256 priceE18,
        uint256 assets
    );
    event WindDownStarted(address indexed startedBy, uint64 startedAt);
    event NonPUSDAssetsMarkedDown(uint256 externalAssets, bytes32 indexed reportHash, uint64 closedAt);
    event FundClosed(address indexed closedBy, uint64 closedAt);
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
    event ManagementFeeAccrued(
        address indexed recipient,
        uint256 shares,
        uint256 elapsedSeconds,
        uint16 feeBps,
        uint64 accruedAt
    );
    event ManagementFeeUpdated(uint16 feeBps, address indexed recipient, address indexed updatedBy);
    event APQuoteRedeemRequest(
        bytes32 indexed quoteId,
        bytes32 indexed nonce,
        address indexed signer,
        address controller,
        address owner,
        address receiver,
        uint256 shares,
        uint256 assets,
        uint256 requestId,
        address apFeeRecipient,
        uint256 apFeeAssets
    );

    error InvalidAddress();
    error InvalidAmount();
    error InvalidMandate();
    error InvalidReport();
    error FundAlreadyClosed();
    error FundWindDownAlreadyStarted();
    error FundWindDownNotStarted();
    error FundWindDownActive();
    error InvalidSideMask(uint8 allowedSides);
    error UnauthorizedOperator(address controller, address operator);
    error AsyncPreviewUnavailable();
    error InsufficientLiquidAssets(uint256 requested, uint256 available);
    error TradingDisabled();
    error StaleOracle();
    error OracleReferenceMismatch(bytes32 expectedBasketHash, uint80 expectedRoundId);
    error VaultNotBootstrapped();
    error InvalidIntentBatch();
    error NoOrderIntents();
    error InvalidOrderIntent(bytes32 intentHash);
    error IntentExpired(bytes32 intentHash);
    error IntentOverfill(bytes32 intentHash, uint256 requested, uint256 remaining);
    error PriceBoundViolation(uint256 requestedPrice, uint256 boundPrice);
    error InvalidQuoteReference();
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
    error ExpiredAPQuote(uint64 deadline);
    error APQuoteAlreadyUsed(bytes32 quoteDigest);
    error APQuoteIdAlreadyUsed(address signer, bytes32 quoteId);
    error APQuoteNonceAlreadyUsed(address signer, bytes32 nonce);
    error UnauthorizedAPQuoteSigner(address signer);
    error QuotePayerMismatch(address expectedPayer, address actualPayer);
    error ExcessiveManagementFee(uint16 requestedFeeBps, uint16 maxFeeBps);
    error ExcessiveAPQuoteShares(uint256 requestedShares, uint256 maxShares);
    error ExcessiveAPQuoteAssets(uint256 requestedAssets, uint256 currentAssets);
    error UnauthorizedERC1155Transfer();

    constructor(
        string memory name_,
        string memory symbol_,
        IERC20 asset_,
        IERC1155 conditionalTokens_,
        IPMFBasketOracleRouter basketOracleRouter_,
        bytes32 basketFeedId_,
        IPMFPricingRouter pricingRouter_,
        bytes32 pricingFeedId_,
        PMFVaultTypes.VaultInit memory init_
    ) ERC20(name_, symbol_) ERC4626(asset_) EIP712(name_, "1") {
        if (
            address(asset_) == address(0) || address(conditionalTokens_) == address(0)
                || address(basketOracleRouter_) == address(0) || address(pricingRouter_) == address(0)
                || basketFeedId_ == bytes32(0) || pricingFeedId_ == bytes32(0) || init_.admin == address(0)
                || init_.manager == address(0) || init_.navReporter == address(0)
                || init_.managementFeeRecipient == address(0)
        ) {
            revert InvalidAddress();
        }
        if (init_.managementFeeBps > MAX_MANAGEMENT_FEE_BPS) {
            revert ExcessiveManagementFee(init_.managementFeeBps, MAX_MANAGEMENT_FEE_BPS);
        }

        basketOracleRouter = basketOracleRouter_;
        basketFeedId = basketFeedId_;
        pricingRouter = pricingRouter_;
        pricingFeedId = pricingFeedId_;
        conditionalTokens = conditionalTokens_;
        managementFeeRecipient = init_.managementFeeRecipient;
        managementFeeBps = init_.managementFeeBps;
        lastManagementFeeAccruedAt = uint64(block.timestamp);
        _grantRole(DEFAULT_ADMIN_ROLE, init_.admin);
        for (uint256 index = 0; index < init_.initialAPs.length; index++) {
            if (init_.initialAPs[index] == address(0)) {
                revert InvalidAddress();
            }
            _grantRole(AP_ROLE, init_.initialAPs[index]);
        }
        _grantRole(NAV_REPORTER_ROLE, init_.navReporter);
        _grantRole(MANDATE_MANAGER_ROLE, init_.manager);
        _grantRole(ORDER_COMMITTER_ROLE, init_.manager);
        _grantRole(PAUSER_ROLE, init_.manager);
        _applyOrderMandate(init_.initialMandate);
    }

    modifier requireBootstrapped() {
        if (totalSupply() == 0) {
            revert VaultNotBootstrapped();
        }
        _;
    }

    function deposit(uint256, address) public pure override returns (uint256) {
        revert InvalidAmount();
    }

    function mint(uint256, address) public pure override returns (uint256) {
        revert InvalidAmount();
    }

    function setMyFeeRecipient(address recipient) external onlyRole(AP_ROLE) {
        if (recipient == address(0) || recipient == address(this)) {
            revert InvalidAddress();
        }
        address signer = _msgSender();
        address previousRecipient = apFeeRecipient[signer];
        apFeeRecipient[signer] = recipient;
        emit APFeeRecipientUpdated(signer, previousRecipient, recipient);
    }

    function depositWithAPQuote(PMFVaultTypes.APDepositQuote calldata auth, bytes calldata signature)
        external
        nonReentrant
        whenPrimaryMarketOpen
        whenNotPaused
        returns (uint256 shares)
    {
        _validateAPQuote(auth);
        bytes32 quoteDigest = _hashAPQuote(auth);
        if (usedAPQuoteDigests[quoteDigest]) {
            revert APQuoteAlreadyUsed(quoteDigest);
        }
        address signer = ECDSA.recover(quoteDigest, signature);
        if (!hasRole(AP_ROLE, signer)) {
            revert UnauthorizedAPQuoteSigner(signer);
        }
        address recipient = _requireAPFeeRecipient(signer);
        _requireAPSpreadWithinLimit(auth.grossAssets, auth.spreadAssets);
        _requireAPQuoteUnused(signer, auth.quoteId, auth.nonce);

        _accrueManagementFee();
        uint256 netAssets = auth.grossAssets - auth.spreadAssets;
        shares = previewDeposit(netAssets);
        if (auth.minShares > shares) {
            revert ExcessiveAPQuoteShares(auth.minShares, shares);
        }

        _markAPQuoteUsed(signer, auth.quoteId, auth.nonce, quoteDigest);
        _deposit(auth.payer, auth.receiver, netAssets, shares);
        if (auth.spreadAssets > 0) {
            // auth.payer is required to equal msg.sender by PMFVaultQuoteLib.validateDeposit.
            // slither-disable-next-line arbitrary-send-erc20
            IERC20(asset()).safeTransferFrom(auth.payer, recipient, auth.spreadAssets);
        }
        emit APQuoteDeposit(
            auth.quoteId,
            auth.nonce,
            signer,
            auth.payer,
            auth.receiver,
            auth.grossAssets,
            auth.spreadAssets,
            shares,
            recipient
        );
        _processRedemptionsAuto();
        return shares;
    }

    function requestRedeemWithAPQuote(PMFVaultTypes.APRedeemQuote calldata auth, bytes calldata signature)
        external
        nonReentrant
        whenFundOpen
        whenNotPaused
        returns (uint256 requestId)
    {
        _validateAPRedeemQuote(auth);
        bytes32 quoteDigest = _hashAPRedeemQuote(auth);
        if (usedAPQuoteDigests[quoteDigest]) {
            revert APQuoteAlreadyUsed(quoteDigest);
        }
        address signer = ECDSA.recover(quoteDigest, signature);
        if (!hasRole(AP_ROLE, signer)) {
            revert UnauthorizedAPQuoteSigner(signer);
        }
        address recipient = _requireAPFeeRecipient(signer);
        _requireAPQuoteUnused(signer, auth.quoteId, auth.nonce);

        _accrueManagementFee();
        uint256 grossAssets = convertToAssets(auth.shares);
        if (auth.assets > grossAssets) {
            revert ExcessiveAPQuoteAssets(auth.assets, grossAssets);
        }
        _requireAPSpreadWithinLimit(grossAssets, grossAssets - auth.assets);

        _markAPQuoteUsed(signer, auth.quoteId, auth.nonce, quoteDigest);
        _spendRedeemAuthorization(auth.owner, auth.shares);
        _burn(auth.owner, auth.shares);
        requestId = redemptionState.enqueue(
            auth.controller,
            auth.owner,
            auth.receiver,
            _msgSender(),
            auth.shares,
            grossAssets,
            auth.assets,
            signer,
            recipient
        );
        emit APQuoteRedeemRequest(
            auth.quoteId,
            auth.nonce,
            signer,
            auth.controller,
            auth.owner,
            auth.receiver,
            auth.shares,
            auth.assets,
            requestId,
            recipient,
            grossAssets - auth.assets
        );
        _processRedemptionsAuto();
    }

    function accrueManagementFee() external nonReentrant returns (uint256 shares) {
        return _accrueManagementFee();
    }

    function pendingManagementFeeShares() public view returns (uint256) {
        return _pendingManagementFeeSharesScaled(uint64(block.timestamp)) / MANAGEMENT_FEE_REMAINDER_SCALE;
    }

    function setManagementFee(uint16 feeBps, address recipient)
        external
        nonReentrant
        returns (uint256 accruedShares)
    {
        address sender = _msgSender();
        if (!hasRole(MANDATE_MANAGER_ROLE, sender) && !hasRole(DEFAULT_ADMIN_ROLE, sender)) {
            revert AccessControlUnauthorizedAccount(sender, MANDATE_MANAGER_ROLE);
        }
        accruedShares = _accrueManagementFee();
        _setManagementFee(feeBps, recipient);
    }

    function processRedemptions(uint256 maxRequests)
        external
        nonReentrant
        returns (uint256 paidAssets, uint256 processedRequests)
    {
        return _processRedemptions(maxRequests);
    }

    function reportTradingAssets(
        uint256 externalAssets,
        bytes32 basketHash,
        uint80 oracleRoundId,
        uint64 asOf,
        bytes32 reportHash
    ) external onlyRole(NAV_REPORTER_ROLE) {
        if (basketHash == bytes32(0) || oracleRoundId == 0 || asOf == 0 || reportHash == bytes32(0)) {
            revert InvalidReport();
        }
        if (asOf > block.timestamp) {
            revert InvalidReport();
        }

        (IPMFBasketOracle oracle, address source, uint64 sourceRevision) = _activeBasketOracle();
        IPMFBasketOracle.BasketHeader memory header = oracle.latestBasket();
        if (!oracle.isFresh()) {
            revert StaleOracle();
        }
        if (header.basketHash != basketHash || header.roundId != oracleRoundId) {
            revert OracleReferenceMismatch(header.basketHash, header.roundId);
        }

        latestTradingAssetsReport = PMFVaultTypes.TradingAssetsReport({
            externalAssets: externalAssets,
            basketFeedId: basketFeedId,
            basketHash: basketHash,
            oracleRoundId: oracleRoundId,
            basketSource: source,
            basketSourceRevision: sourceRevision,
            asOf: asOf,
            reportedAt: uint64(block.timestamp),
            reportHash: reportHash
        });

        emit TradingAssetsReported(externalAssets, basketHash, oracleRoundId, asOf, reportHash);
    }

    function updateOrderMandate(PMFVaultTypes.OrderMandateUpdate calldata update)
        external
        onlyRole(MANDATE_MANAGER_ROLE)
        returns (bytes32 mandateHash)
    {
        return _applyOrderMandate(update);
    }

    function commitOrderIntentBatchFor(bytes32 expectedBasketHash, uint80 expectedRoundId)
        external
        nonReentrant
        whenFundOpen
        whenNotPaused
        onlyRole(ORDER_COMMITTER_ROLE)
        requireBootstrapped
        returns (bytes32 batchId)
    {
        if (expectedBasketHash == bytes32(0) || expectedRoundId == 0) {
            revert InvalidIntentBatch();
        }
        _processRedemptionsAuto();
        return _commitOrderIntentBatch(expectedBasketHash, expectedRoundId, true);
    }

    function fulfillBuyIntent(bytes32 batchId, bytes32 intentHash, uint256 fillSize, uint256 priceE18)
        external
        nonReentrant
        whenPrimaryMarketOpen
        whenNotPaused
        onlyRole(SOLVER_ROLE)
        requireBootstrapped
        returns (uint256 assets)
    {
        (IPMFBasketOracle oracle, address source, uint64 sourceRevision) = _activeBasketOracle();
        PMFVaultTypes.SolverOrderIntent memory intent = intentState.consumeIntent(
            currentOrderMandate,
            oracle,
            source,
            sourceRevision,
            batchId,
            intentHash,
            SIDE_BUY,
            fillSize,
            priceE18
        );

        assets = PMFVaultIntentLib.assetsForFill(fillSize, priceE18);
        uint256 available = unallocatedCapital();
        if (assets > available) {
            revert InsufficientLiquidAssets(assets, available);
        }

        conditionalTokens.safeTransferFrom(_msgSender(), address(this), intent.tokenId, fillSize, "");
        residualState.trackKnownToken(intent.tokenId, _msgSender());
        IERC20(asset()).safeTransfer(_msgSender(), assets);
        emit SolverOrderIntentFulfilled(
            batchId,
            intentHash,
            _msgSender(),
            SIDE_BUY,
            intent.tokenId,
            fillSize,
            priceE18,
            assets
        );
    }

    function fulfillSellIntent(bytes32 batchId, bytes32 intentHash, uint256 fillSize, uint256 priceE18)
        external
        nonReentrant
        whenFundOpen
        whenNotPaused
        onlyRole(SOLVER_ROLE)
        requireBootstrapped
        returns (uint256 assets)
    {
        (IPMFBasketOracle oracle, address source, uint64 sourceRevision) = _activeBasketOracle();
        PMFVaultTypes.SolverOrderIntent memory intent = intentState.consumeIntent(
            currentOrderMandate,
            oracle,
            source,
            sourceRevision,
            batchId,
            intentHash,
            SIDE_SELL,
            fillSize,
            priceE18
        );

        assets = PMFVaultIntentLib.assetsForFill(fillSize, priceE18);
        IERC20(asset()).safeTransferFrom(_msgSender(), address(this), assets);
        conditionalTokens.safeTransferFrom(address(this), _msgSender(), intent.tokenId, fillSize, "");
        emit SolverOrderIntentFulfilled(
            batchId,
            intentHash,
            _msgSender(),
            SIDE_SELL,
            intent.tokenId,
            fillSize,
            priceE18,
            assets
        );
        _processRedemptionsAuto();
    }

    function registerResidualToken(uint256 tokenId) external onlyRole(MANDATE_MANAGER_ROLE) {
        residualState.trackKnownToken(tokenId, _msgSender());
    }

    function resetIgnoredResidualToken(uint256 tokenId) external onlyRole(MANDATE_MANAGER_ROLE) {
        residualState.resetIgnoredToken(tokenId, _msgSender());
    }

    function commitResidualLiquidationBatch(uint256[] calldata tokenIds)
        external
        nonReentrant
        whenFundOpen
        whenNotPaused
        onlyRole(ORDER_COMMITTER_ROLE)
        requireBootstrapped
        returns (bytes32 batchId)
    {
        _processRedemptionsAuto();
        batchId = residualState.commitResidualLiquidationBatch(
            currentOrderMandate,
            PMFVaultResidualLib.CommitContext({
                vault: address(this),
                conditionalTokens: conditionalTokens,
                basketRouter: basketOracleRouter,
                basketFeedId: basketFeedId,
                mandateHash: orderMandateHash()
            }),
            tokenIds
        );
    }

    function fulfillResidualSellIntent(bytes32 batchId, bytes32 intentHash, uint256 fillSize, uint256 priceE18)
        external
        nonReentrant
        whenFundOpen
        whenNotPaused
        onlyRole(SOLVER_ROLE)
        requireBootstrapped
        returns (uint256 assets)
    {
        PMFVaultTypes.ResidualSellIntent memory intent = residualState.consumeResidualSellIntent(
            conditionalTokens,
            basketOracleRouter,
            basketFeedId,
            address(this),
            batchId,
            intentHash,
            fillSize,
            priceE18
        );
        assets = PMFVaultIntentLib.assetsForFill(fillSize, priceE18);
        IERC20(asset()).safeTransferFrom(_msgSender(), address(this), assets);
        conditionalTokens.safeTransferFrom(address(this), _msgSender(), intent.tokenId, fillSize, "");
        residualState.afterResidualFill(conditionalTokens, address(this), intent.tokenId, intent.remainingSize);

        emit ResidualSellIntentFulfilled(
            batchId,
            intentHash,
            _msgSender(),
            intent.tokenId,
            fillSize,
            priceE18,
            assets
        );
        _processRedemptionsAuto();
    }

    function beginWindDown() external onlyRole(MANDATE_MANAGER_ROLE) {
        if (lifecycleState.fundClosed) {
            revert FundAlreadyClosed();
        }
        if (lifecycleState.windDownStarted) {
            revert FundWindDownAlreadyStarted();
        }
        uint64 startedAt = uint64(block.timestamp);
        lifecycleState.windDownStarted = true;
        lifecycleState.windDownStartedAt = startedAt;
        emit WindDownStarted(_msgSender(), startedAt);
    }

    function closeFund() external onlyRole(MANDATE_MANAGER_ROLE) {
        if (lifecycleState.fundClosed) {
            revert FundAlreadyClosed();
        }
        if (!lifecycleState.windDownStarted) {
            revert FundWindDownNotStarted();
        }
        uint64 closedAt = uint64(block.timestamp);
        _accrueManagementFee();
        lifecycleState.fundClosed = true;
        lifecycleState.fundClosedAt = closedAt;
        lastManagementFeeAccruedAt = closedAt;
        managementFeeShareRemainderScaled = 0;
        lifecycleState.markedDownExternalAssets = latestTradingAssetsReport.externalAssets;
        emit NonPUSDAssetsMarkedDown(
            lifecycleState.markedDownExternalAssets,
            latestTradingAssetsReport.reportHash,
            closedAt
        );
        emit FundClosed(_msgSender(), closedAt);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function setOperator(address operator, bool approved) external returns (bool) {
        if (operator == address(0)) {
            revert InvalidAddress();
        }
        address controller = _msgSender();
        isOperator[controller][operator] = approved;
        emit OperatorSet(controller, operator, approved);
        return true;
    }

    function windDownStarted() public view returns (bool) {
        return lifecycleState.windDownStarted;
    }

    function fundClosed() public view returns (bool) {
        return lifecycleState.fundClosed;
    }

    function markedDownExternalAssets() public view returns (uint256) {
        return lifecycleState.markedDownExternalAssets;
    }

    function totalAssets() public view override returns (uint256) {
        if (lifecycleState.fundClosed) {
            return _directExitAssets();
        }
        return PMFVaultAccountingLib.netAssets(
            liquidAssets(),
            latestTradingAssetsReport.externalAssets,
            redemptionState.totalPendingAssets
        );
    }

    function _convertToShares(uint256 assets, Math.Rounding rounding)
        internal
        view
        override
        returns (uint256)
    {
        if (totalSupply() == 0) {
            return assets;
        }
        return assets.mulDiv(_feeAdjustedTotalSupply() + 10 ** _decimalsOffset(), totalAssets() + 1, rounding);
    }

    function _convertToAssets(uint256 shares, Math.Rounding rounding)
        internal
        view
        override
        returns (uint256)
    {
        if (totalSupply() == 0) {
            return shares;
        }
        return shares.mulDiv(totalAssets() + 1, _feeAdjustedTotalSupply() + 10 ** _decimalsOffset(), rounding);
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        if (!lifecycleState.fundClosed || paused()) {
            return 0;
        }
        uint256 ownerAssets = convertToAssets(balanceOf(owner));
        uint256 availableAssets = _directExitAssets();
        return ownerAssets < availableAssets ? ownerAssets : availableAssets;
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        if (!lifecycleState.fundClosed || paused()) {
            return 0;
        }
        uint256 ownerShares = balanceOf(owner);
        uint256 ownerAssets = convertToAssets(ownerShares);
        if (ownerAssets == 0) {
            return 0;
        }
        uint256 availableAssets = _directExitAssets();
        if (ownerAssets <= availableAssets) {
            return ownerShares;
        }
        return previewWithdraw(availableAssets);
    }

    function previewWithdraw(uint256 assets) public view override returns (uint256) {
        if (!lifecycleState.fundClosed) {
            revert AsyncPreviewUnavailable();
        }
        return _convertToShares(assets, Math.Rounding.Ceil);
    }

    function previewRedeem(uint256 shares) public view override returns (uint256) {
        if (!lifecycleState.fundClosed) {
            revert AsyncPreviewUnavailable();
        }
        return _convertToAssets(shares, Math.Rounding.Floor);
    }

    function withdraw(uint256 assets, address receiver, address owner)
        public
        override
        nonReentrant
        returns (uint256 shares)
    {
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner)
        public
        override
        nonReentrant
        returns (uint256 assets)
    {
        return super.redeem(shares, receiver, owner);
    }

    function liquidAssets() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    function unallocatedCapital() public view returns (uint256) {
        if (lifecycleState.windDownStarted || lifecycleState.fundClosed) {
            return 0;
        }
        return PMFVaultAccountingLib.unallocatedCapital(
            liquidAssets(),
            redemptionState.totalPendingAssets,
            currentOrderMandate.minVaultCashBuffer
        );
    }

    function availableRedemptionAssets() public view returns (uint256) {
        if (lifecycleState.fundClosed) {
            return liquidAssets();
        }
        return PMFVaultAccountingLib.redemptionAvailableAssets(liquidAssets(), currentOrderMandate.minVaultCashBuffer);
    }

    function pendingRedemptionAssets() external view returns (uint256) {
        return redemptionState.totalPendingAssets;
    }

    function nextRedemptionRequestId() external view returns (uint256) {
        return redemptionState.nextRequestId == 0 ? 1 : redemptionState.nextRequestId;
    }

    function redemptionRequest(uint256 requestId) external view returns (PMFVaultTypes.RedemptionRequest memory) {
        return redemptionState.getRequest(requestId);
    }

    function pendingRedeemRequest(uint256 requestId, address controller) external view returns (uint256 shares) {
        PMFVaultTypes.RedemptionRequest memory request = redemptionState.getRequest(requestId);
        if (request.controller != controller || request.remainingAssets == 0) {
            return 0;
        }
        return request.shares;
    }

    function orderMandate() external view returns (PMFVaultTypes.OrderMandate memory) {
        return currentOrderMandate;
    }

    function activeOrderIntentBatch() external view returns (PMFVaultTypes.OrderIntentBatch memory) {
        return intentState.latestOrderIntentBatch;
    }

    function latestOrderIntentCount() external view returns (uint256) {
        return intentState.latestOrderIntentCount();
    }

    function latestOrderIntentHash(uint256 index) external view returns (bytes32) {
        return intentState.latestOrderIntentHash(index);
    }

    function solverOrderIntents(bytes32 intentHash) external view returns (PMFVaultTypes.SolverOrderIntent memory) {
        return intentState.solverOrderIntent(intentHash);
    }

    function orderMandateHash() public view returns (bytes32) {
        return PMFVaultIntentLib.hashMandate(currentOrderMandate);
    }

    function onERC1155Received(address operator, address, uint256 id, uint256 value, bytes memory)
        public
        override
        returns (bytes4)
    {
        if (_msgSender() != address(conditionalTokens) || operator != address(this)) {
            revert UnauthorizedERC1155Transfer();
        }
        if (value > 0) {
            residualState.trackKnownToken(id, operator);
        }
        return 0xf23a6e61;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] memory,
        uint256[] memory,
        bytes memory
    ) public pure override returns (bytes4) {
        revert UnauthorizedERC1155Transfer();
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControl, ERC1155Holder)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    function _activeBasketOracle()
        private
        view
        returns (IPMFBasketOracle oracle, address source, uint64 sourceRevision)
    {
        source = basketOracleRouter.activeSource(basketFeedId);
        sourceRevision = basketOracleRouter.sourceRevision(basketFeedId);
        oracle = IPMFBasketOracle(source);
    }

    function _commitOrderIntentBatch(bytes32 expectedBasketHash, uint80 expectedRoundId, bool requireExpected)
        private
        returns (bytes32 batchId)
    {
        (IPMFBasketOracle oracle, address source, uint64 sourceRevision) = _activeBasketOracle();
        return intentState.commitOrderIntentBatch(
            currentOrderMandate,
            PMFVaultIntentLib.CommitContext({
                vault: address(this),
                basketOracle: oracle,
                conditionalTokens: conditionalTokens,
                liquidAssets: liquidAssets(),
                pendingRedemptionAssets: redemptionState.totalPendingAssets,
                mandateHash: orderMandateHash(),
                basketFeedId: basketFeedId,
                basketSource: source,
                basketSourceRevision: sourceRevision,
                expectedBasketHash: expectedBasketHash,
                expectedRoundId: expectedRoundId,
                requireExpected: requireExpected,
                liquidationOnly: lifecycleState.windDownStarted
            })
        );
    }

    function _hashAPQuote(PMFVaultTypes.APDepositQuote calldata auth) private view returns (bytes32) {
        return _hashTypedDataV4(PMFVaultQuoteLib.hashDeposit(auth));
    }

    function _hashAPRedeemQuote(PMFVaultTypes.APRedeemQuote calldata auth)
        private
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(PMFVaultQuoteLib.hashRedeem(auth));
    }

    function _validateAPQuote(PMFVaultTypes.APDepositQuote calldata auth) private view {
        PMFVaultQuoteLib.validateDeposit(auth, _msgSender(), _quoteContext());
    }

    function _validateAPRedeemQuote(PMFVaultTypes.APRedeemQuote calldata auth) private view {
        PMFVaultQuoteLib.validateRedeem(auth, _quoteContext());
    }

    function _quoteContext() private view returns (PMFVaultQuoteLib.QuoteContext memory context) {
        (IPMFBasketOracle oracle, address source, uint64 sourceRevision) = _activeBasketOracle();
        context = PMFVaultQuoteLib.QuoteContext({
            basketOracle: address(oracle),
            pricingRouter: address(pricingRouter),
            basketFeedId: basketFeedId,
            pricingFeedId: pricingFeedId,
            basketSource: source,
            basketSourceRevision: sourceRevision,
            latestReportHash: latestTradingAssetsReport.reportHash,
            latestReportAsOf: latestTradingAssetsReport.asOf
        });
    }

    function _requireAPQuoteUnused(address signer, bytes32 quoteId, bytes32 nonce) private view {
        if (usedAPQuoteIds[signer][quoteId]) {
            revert APQuoteIdAlreadyUsed(signer, quoteId);
        }
        if (usedAPQuoteNonces[signer][nonce]) {
            revert APQuoteNonceAlreadyUsed(signer, nonce);
        }
    }

    function _markAPQuoteUsed(
        address signer,
        bytes32 quoteId,
        bytes32 nonce,
        bytes32 quoteDigest
    ) private {
        usedAPQuoteIds[signer][quoteId] = true;
        usedAPQuoteNonces[signer][nonce] = true;
        usedAPQuoteDigests[quoteDigest] = true;
    }

    function _setManagementFee(uint16 feeBps, address recipient) private {
        if (recipient == address(0)) {
            revert InvalidAddress();
        }
        if (feeBps > MAX_MANAGEMENT_FEE_BPS) {
            revert ExcessiveManagementFee(feeBps, MAX_MANAGEMENT_FEE_BPS);
        }
        managementFeeBps = feeBps;
        managementFeeRecipient = recipient;
        emit ManagementFeeUpdated(feeBps, recipient, _msgSender());
    }

    function _accrueManagementFee() private returns (uint256 shares) {
        if (lifecycleState.fundClosed) {
            return 0;
        }
        uint64 currentTimestamp = uint64(block.timestamp);
        uint64 previousTimestamp = lastManagementFeeAccruedAt;
        if (currentTimestamp <= previousTimestamp) {
            return 0;
        }

        if (totalSupply() == 0 || managementFeeBps == 0) {
            lastManagementFeeAccruedAt = currentTimestamp;
            return 0;
        }

        uint256 scaledShares = _pendingManagementFeeSharesScaled(currentTimestamp);
        shares = scaledShares / MANAGEMENT_FEE_REMAINDER_SCALE;
        managementFeeShareRemainderScaled = scaledShares - (shares * MANAGEMENT_FEE_REMAINDER_SCALE);
        lastManagementFeeAccruedAt = currentTimestamp;
        if (shares == 0) {
            return 0;
        }

        _mint(managementFeeRecipient, shares);
        emit ManagementFeeAccrued(
            managementFeeRecipient,
            shares,
            currentTimestamp - previousTimestamp,
            managementFeeBps,
            currentTimestamp
        );
    }

    function _pendingManagementFeeSharesScaled(uint64 timestamp) private view returns (uint256) {
        if (lifecycleState.fundClosed) {
            return 0;
        }
        if (timestamp <= lastManagementFeeAccruedAt || totalSupply() == 0 || managementFeeBps == 0) {
            return managementFeeShareRemainderScaled;
        }
        uint256 elapsed = timestamp - lastManagementFeeAccruedAt;
        uint256 numerator = uint256(managementFeeBps) * elapsed;
        uint256 denominator = BPS_SCALE * SECONDS_PER_YEAR;
        if (numerator >= denominator) {
            revert InvalidAmount();
        }
        return managementFeeShareRemainderScaled
            + totalSupply().mulDiv(
                numerator * MANAGEMENT_FEE_REMAINDER_SCALE,
                denominator - numerator,
                Math.Rounding.Floor
            );
    }

    function _requireAPFeeRecipient(address signer) private view returns (address recipient) {
        recipient = apFeeRecipient[signer];
        if (recipient == address(0)) {
            revert InvalidAddress();
        }
    }

    function _requireAPSpreadWithinLimit(uint256 grossAssets, uint256 spreadAssets) private pure {
        if (spreadAssets * 100 > grossAssets * 3) {
            revert InvalidAmount();
        }
    }

    function _feeAdjustedTotalSupply() private view returns (uint256) {
        return totalSupply() + pendingManagementFeeShares();
    }

    function _applyOrderMandate(PMFVaultTypes.OrderMandateUpdate memory update)
        private
        returns (bytes32 mandateHash)
    {
        mandateHash = PMFVaultIntentLib.applyMandate(currentOrderMandate, update);
        emit OrderMandateUpdated(
            currentOrderMandate.mandateRevision,
            mandateHash,
            update.tradingWallet,
            currentOrderMandate.updatedAt
        );
    }

    function _spendRedeemAuthorization(address owner, uint256 shares) private {
        address sender = _msgSender();
        if (sender != owner && !isOperator[owner][sender]) {
            _spendAllowance(owner, sender, shares);
        }
    }

    function _processRedemptionsAuto() private returns (uint256 paidAssets, uint256 processedRequests) {
        if (redemptionState.queueHead == 0 || availableRedemptionAssets() == 0) {
            return (0, 0);
        }
        return _processRedemptions(AUTO_REDEMPTION_PROCESS_LIMIT);
    }

    function _processRedemptions(uint256 maxRequests)
        private
        returns (uint256 paidAssets, uint256 processedRequests)
    {
        (paidAssets, processedRequests) =
            redemptionState.process(IERC20(asset()), availableRedemptionAssets(), maxRequests);
    }

    function _directExitAssets() private view returns (uint256) {
        return PMFVaultAccountingLib.netAssets(liquidAssets(), 0, redemptionState.totalPendingAssets);
    }

    modifier whenFundOpen() {
        if (lifecycleState.fundClosed) {
            revert FundAlreadyClosed();
        }
        _;
    }

    modifier whenPrimaryMarketOpen() {
        if (lifecycleState.fundClosed) {
            revert FundAlreadyClosed();
        }
        if (lifecycleState.windDownStarted) {
            revert FundWindDownActive();
        }
        _;
    }
}
