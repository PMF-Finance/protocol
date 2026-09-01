// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IPMFBasketOracle} from "./interfaces/IPMFBasketOracle.sol";

/**
 * @title PMFBasketOracle
 * @author PMF
 * @notice Publishes the latest PMF index basket constituents and target weights.
 * @dev Immutable, signed-push oracle. A PMF signer signs the basket header; any relayer can submit it.
 */
contract PMFBasketOracle is IPMFBasketOracle, AccessControl, Pausable, EIP712 {
    bytes32 public constant REPORT_SIGNER_ROLE = keccak256("REPORT_SIGNER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant HEADER_TYPEHASH = keccak256(
        "BasketHeader(bytes32 feedId,uint80 roundId,uint64 asOf,uint64 validUntil,bytes32 runIdHash,"
        "bytes32 basketHash,uint16 constituentCount,uint256 levelE18,uint8 qualityStatus)"
    );
    bytes32 public constant CONSTITUENT_TYPEHASH = keccak256(
        "BasketConstituent(uint256 tokenId,bytes32 conditionId,bytes32 marketIdHash,bytes32 questionHash,"
        "bytes32 outcomeHash,uint8 outcomeSide,uint256 weightE18,uint256 referencePriceE18,"
        "uint256 executionCapacityE6,bytes32 marketDataHash)"
    );
    bytes32 public constant MARKET_DATA_TYPEHASH = keccak256(
        "ConstituentMarketData(uint256 bestBidE18,uint256 bestAskE18,uint16 spreadBps,uint256 depthBidE6,"
        "uint256 depthAskE6,uint64 marketDataAsOf)"
    );
    uint256 public constant TARGET_WEIGHT_SUM = 1e18;
    uint16 public constant MAX_MARKET_SPREAD_BPS = 10_000;
    uint256 public constant MIN_MARKET_DEPTH_E6 = 1;

    bytes32 public immutable feedId;
    uint16 public immutable maxConstituents;
    uint64 public immutable maxFutureAsOf;
    uint64 public immutable maxMarketDataAge;
    uint256 public immutable maxWeightSumError;

    BasketHeader private latestHeader;
    BasketConstituent[] private latestConstituents;

    event BasketPublished(
        bytes32 indexed feedId,
        uint80 indexed roundId,
        uint64 asOf,
        uint64 validUntil,
        bytes32 indexed basketHash,
        uint16 constituentCount,
        uint256 levelE18,
        uint8 qualityStatus
    );
    event SignerRecovered(address indexed signer, uint80 indexed roundId);

    error EmptyConstituentSet();
    error TooManyConstituents(uint256 count, uint256 maxCount);
    error FeedIdMismatch(bytes32 expected, bytes32 actual);
    error NonMonotonicRound(uint80 latestRoundId, uint80 newRoundId);
    error InvalidHeader();
    error StaleBasket(uint64 validUntil, uint256 currentTimestamp);
    error FutureBasket(uint64 asOf, uint256 currentTimestamp);
    error BasketHashMismatch(bytes32 expected, bytes32 actual);
    error ConstituentCountMismatch(uint256 actual, uint256 expected);
    error InvalidConstituent(uint256 index);
    error InvalidMarketData(uint256 index);
    error DuplicateToken(uint256 tokenId);
    error BadWeightSum(uint256 weightSum, uint256 maxError);
    error UnauthorizedSigner(address signer);

    constructor(
        bytes32 _feedId,
        address _admin,
        address _reportSigner,
        uint16 _maxConstituents,
        uint64 _maxFutureAsOf,
        uint256 _maxWeightSumError
    ) EIP712("PMF Basket Oracle", "1") {
        if (_feedId == bytes32(0) || _admin == address(0) || _reportSigner == address(0)) {
            revert InvalidHeader();
        }
        if (_maxConstituents == 0) {
            revert TooManyConstituents(0, 0);
        }
        feedId = _feedId;
        maxConstituents = _maxConstituents;
        maxFutureAsOf = _maxFutureAsOf;
        maxMarketDataAge = _maxFutureAsOf;
        maxWeightSumError = _maxWeightSumError;
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(PAUSER_ROLE, _admin);
        _grantRole(REPORT_SIGNER_ROLE, _reportSigner);
    }

    function submitBasket(
        BasketHeader calldata header,
        BasketConstituent[] calldata constituents,
        bytes calldata signature
    ) external whenNotPaused {
        _validateHeader(header, constituents.length);
        bytes32 computedBasketHash = hashBasket(constituents);
        if (computedBasketHash != header.basketHash) {
            revert BasketHashMismatch(computedBasketHash, header.basketHash);
        }
        _validateConstituents(constituents);

        address signer = ECDSA.recover(_hashTypedDataV4(_hashHeader(header)), signature);
        if (!hasRole(REPORT_SIGNER_ROLE, signer)) {
            revert UnauthorizedSigner(signer);
        }

        delete latestConstituents;
        for (uint256 index = 0; index < constituents.length; index++) {
            latestConstituents.push(constituents[index]);
        }
        latestHeader = header;

        emit SignerRecovered(signer, header.roundId);
        emit BasketPublished(
            header.feedId,
            header.roundId,
            header.asOf,
            header.validUntil,
            header.basketHash,
            header.constituentCount,
            header.levelE18,
            header.qualityStatus
        );
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function latestBasket() external view returns (BasketHeader memory) {
        return latestHeader;
    }

    function getConstituent(uint256 index) external view returns (BasketConstituent memory) {
        return latestConstituents[index];
    }

    function getConstituentCount() external view returns (uint256) {
        return latestConstituents.length;
    }

    function isFresh() public view returns (bool) {
        return latestHeader.roundId != 0 && latestHeader.validUntil >= block.timestamp;
    }

    function hashBasket(BasketConstituent[] calldata constituents) public pure returns (bytes32) {
        bytes memory packed = "";
        for (uint256 index = 0; index < constituents.length; index++) {
            bytes32 itemHash = _hashConstituent(constituents[index]);
            packed = bytes.concat(packed, itemHash);
        }
        return keccak256(packed);
    }

    function _validateHeader(BasketHeader calldata header, uint256 actualCount) private view {
        if (header.feedId != feedId) {
            revert FeedIdMismatch(feedId, header.feedId);
        }
        if (header.roundId <= latestHeader.roundId) {
            revert NonMonotonicRound(latestHeader.roundId, header.roundId);
        }
        if (
            header.asOf == 0 ||
            header.validUntil <= header.asOf ||
            header.levelE18 == 0 ||
            header.qualityStatus == 0 ||
            header.runIdHash == bytes32(0) ||
            header.basketHash == bytes32(0)
        ) {
            revert InvalidHeader();
        }
        if (header.validUntil < block.timestamp) {
            revert StaleBasket(header.validUntil, block.timestamp);
        }
        if (header.asOf > block.timestamp + maxFutureAsOf) {
            revert FutureBasket(header.asOf, block.timestamp);
        }
        if (actualCount == 0) {
            revert EmptyConstituentSet();
        }
        if (actualCount > maxConstituents) {
            revert TooManyConstituents(actualCount, maxConstituents);
        }
        if (header.constituentCount != actualCount) {
            revert ConstituentCountMismatch(actualCount, header.constituentCount);
        }
    }

    function _validateConstituents(BasketConstituent[] calldata constituents) private view {
        uint256 weightSum = 0;
        for (uint256 index = 0; index < constituents.length; index++) {
            BasketConstituent calldata item = constituents[index];
            if (
                item.tokenId == 0 ||
                item.conditionId == bytes32(0) ||
                item.marketIdHash == bytes32(0) ||
                item.questionHash == bytes32(0) ||
                item.outcomeHash == bytes32(0) ||
                item.outcomeSide > 2 ||
                item.weightE18 == 0 ||
                item.referencePriceE18 == 0 ||
                item.executionCapacityE6 == 0
            ) {
                revert InvalidConstituent(index);
            }
            _validateMarketData(item, index);
            for (uint256 compareIndex = 0; compareIndex < index; compareIndex++) {
                if (constituents[compareIndex].tokenId == item.tokenId) {
                    revert DuplicateToken(item.tokenId);
                }
            }
            weightSum += item.weightE18;
        }
        uint256 errorAmount = weightSum > TARGET_WEIGHT_SUM
            ? weightSum - TARGET_WEIGHT_SUM
            : TARGET_WEIGHT_SUM - weightSum;
        if (errorAmount > maxWeightSumError) {
            revert BadWeightSum(weightSum, maxWeightSumError);
        }
    }

    function _validateMarketData(BasketConstituent calldata item, uint256 index) private view {
        if (
            item.bestBidE18 == 0 ||
            item.bestAskE18 == 0 ||
            item.bestAskE18 < item.bestBidE18 ||
            item.bestAskE18 > 1e18 ||
            item.spreadBps > MAX_MARKET_SPREAD_BPS ||
            item.depthBidE6 < MIN_MARKET_DEPTH_E6 ||
            item.depthAskE6 < MIN_MARKET_DEPTH_E6 ||
            item.marketDataAsOf == 0 ||
            item.marketDataAsOf > block.timestamp + maxFutureAsOf ||
            block.timestamp > item.marketDataAsOf + maxMarketDataAge
        ) {
            revert InvalidMarketData(index);
        }
    }

    function _hashHeader(BasketHeader calldata header) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                HEADER_TYPEHASH,
                header.feedId,
                header.roundId,
                header.asOf,
                header.validUntil,
                header.runIdHash,
                header.basketHash,
                header.constituentCount,
                header.levelE18,
                header.qualityStatus
            )
        );
    }

    function _hashConstituent(BasketConstituent calldata item) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CONSTITUENT_TYPEHASH,
                item.tokenId,
                item.conditionId,
                item.marketIdHash,
                item.questionHash,
                item.outcomeHash,
                item.outcomeSide,
                item.weightE18,
                item.referencePriceE18,
                item.executionCapacityE6,
                _hashMarketData(item)
            )
        );
    }

    function _hashMarketData(BasketConstituent calldata item) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                MARKET_DATA_TYPEHASH,
                item.bestBidE18,
                item.bestAskE18,
                item.spreadBps,
                item.depthBidE6,
                item.depthAskE6,
                item.marketDataAsOf
            )
        );
    }
}
