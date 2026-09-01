// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IPMFBasketOracle} from "./interfaces/IPMFBasketOracle.sol";
import {IPMFBasketOracleRouter} from "./interfaces/IPMFBasketOracleRouter.sol";

/**
 * @title PMFBasketOracleRouter
 * @author PMF
 * @notice Typed router for target-basket oracle sources.
 * @dev This is not an upgradeable proxy. It never delegatecalls source contracts.
 */
contract PMFBasketOracleRouter is IPMFBasketOracleRouter, AccessControl, Pausable {
    bytes32 public constant ROUTER_ADMIN_ROLE = keccak256("ROUTER_ADMIN_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    uint64 public constant REPLACEMENT_DELAY = 24 hours;
    uint256 public constant MAX_ROUTED_CONSTITUENTS = 50;

    struct PendingSource {
        address source;
        uint64 activateAfter;
    }

    mapping(bytes32 feedId => BasketSource source) private sources;
    mapping(bytes32 feedId => PendingSource pendingSource) public pendingSources;
    mapping(bytes32 feedId => mapping(address source => bool allowed)) public sourceAllowed;

    event SourceAllowed(bytes32 indexed feedId, address indexed source, bool allowed);
    event SourceSet(bytes32 indexed feedId, address indexed source, uint64 indexed revision);
    event SourceReplacementProposed(
        bytes32 indexed feedId,
        address indexed source,
        uint64 indexed activateAfter
    );
    event SourceReplacementActivated(
        bytes32 indexed feedId,
        address indexed previousSource,
        address indexed newSource,
        uint64 revision
    );
    event SourceReplacementCancelled(bytes32 indexed feedId, address indexed source);

    error InvalidSource();
    error SourceNotAllowed(bytes32 feedId, address source);
    error SourceAlreadySet(bytes32 feedId);
    error NoActiveSource(bytes32 feedId);
    error NoPendingSource(bytes32 feedId);
    error ReplacementDelayActive(bytes32 feedId, uint64 activateAfter);
    error SourceFeedMismatch(bytes32 expectedFeedId, bytes32 actualFeedId);
    error SourceConstituentCountMismatch(bytes32 feedId, uint256 headerCount, uint256 actualCount);
    error TooManyRoutedConstituents(bytes32 feedId, uint256 count, uint256 maxCount);
    error StaleSource(bytes32 feedId, address source);

    constructor(address admin) {
        if (admin == address(0)) {
            revert InvalidSource();
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ROUTER_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    function setSourceAllowed(bytes32 feedId, address source, bool allowed) external onlyRole(ROUTER_ADMIN_ROLE) {
        if (allowed) {
            _validateSource(feedId, source, false, false);
        } else if (feedId == bytes32(0) || source == address(0)) {
            revert InvalidSource();
        }
        sourceAllowed[feedId][source] = allowed;
        emit SourceAllowed(feedId, source, allowed);
    }

    function setInitialSource(bytes32 feedId, address source) external onlyRole(ROUTER_ADMIN_ROLE) {
        if (sources[feedId].source != address(0)) {
            revert SourceAlreadySet(feedId);
        }
        _validateSource(feedId, source, false, true);
        sources[feedId] = BasketSource({source: source, revision: 1});
        emit SourceSet(feedId, source, 1);
    }

    function proposeSource(bytes32 feedId, address source) external onlyRole(ROUTER_ADMIN_ROLE) {
        _validateSource(feedId, source, false, true);
        uint64 activateAfter = uint64(block.timestamp + REPLACEMENT_DELAY);
        pendingSources[feedId] = PendingSource({source: source, activateAfter: activateAfter});
        emit SourceReplacementProposed(feedId, source, activateAfter);
    }

    function activateSource(bytes32 feedId) external onlyRole(ROUTER_ADMIN_ROLE) {
        PendingSource memory pending = pendingSources[feedId];
        if (pending.source == address(0)) {
            revert NoPendingSource(feedId);
        }
        if (block.timestamp < pending.activateAfter) {
            revert ReplacementDelayActive(feedId, pending.activateAfter);
        }
        _validateSource(feedId, pending.source, true, true);
        address previousSource = sources[feedId].source;
        uint64 revision = sources[feedId].revision + 1;
        if (revision == 0) {
            revision = 1;
        }
        sources[feedId] = BasketSource({source: pending.source, revision: revision});
        delete pendingSources[feedId];
        emit SourceReplacementActivated(feedId, previousSource, pending.source, revision);
    }

    function cancelSourceReplacement(bytes32 feedId) external onlyRole(ROUTER_ADMIN_ROLE) {
        PendingSource memory pending = pendingSources[feedId];
        if (pending.source == address(0)) {
            revert NoPendingSource(feedId);
        }
        delete pendingSources[feedId];
        emit SourceReplacementCancelled(feedId, pending.source);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function activeSource(bytes32 feedId) public view returns (address) {
        address source = sources[feedId].source;
        if (source == address(0)) {
            revert NoActiveSource(feedId);
        }
        return source;
    }

    function sourceRevision(bytes32 feedId) external view returns (uint64) {
        BasketSource memory source = sources[feedId];
        if (source.source == address(0)) {
            revert NoActiveSource(feedId);
        }
        return source.revision;
    }

    function latestBasket(bytes32 feedId)
        external
        view
        whenNotPaused
        returns (IPMFBasketOracle.BasketHeader memory)
    {
        return IPMFBasketOracle(activeSource(feedId)).latestBasket();
    }

    function getConstituent(bytes32 feedId, uint256 index)
        external
        view
        whenNotPaused
        returns (IPMFBasketOracle.BasketConstituent memory)
    {
        return IPMFBasketOracle(activeSource(feedId)).getConstituent(index);
    }

    function getConstituentCount(bytes32 feedId) external view whenNotPaused returns (uint256) {
        return IPMFBasketOracle(activeSource(feedId)).getConstituentCount();
    }

    function isFresh(bytes32 feedId) external view whenNotPaused returns (bool) {
        return IPMFBasketOracle(activeSource(feedId)).isFresh();
    }

    function _validateSource(bytes32 feedId, address source, bool requireFresh, bool requireAllowed) private view {
        if (feedId == bytes32(0) || source == address(0) || source.code.length == 0) {
            revert InvalidSource();
        }
        if (requireAllowed && !sourceAllowed[feedId][source]) {
            revert SourceNotAllowed(feedId, source);
        }
        IPMFBasketOracle.BasketHeader memory header = IPMFBasketOracle(source).latestBasket();
        if (header.feedId != feedId) {
            revert SourceFeedMismatch(feedId, header.feedId);
        }
        uint256 actualCount = IPMFBasketOracle(source).getConstituentCount();
        if (header.constituentCount != actualCount) {
            revert SourceConstituentCountMismatch(feedId, header.constituentCount, actualCount);
        }
        if (actualCount == 0 || actualCount > MAX_ROUTED_CONSTITUENTS) {
            revert TooManyRoutedConstituents(feedId, actualCount, MAX_ROUTED_CONSTITUENTS);
        }
        if (requireFresh && !IPMFBasketOracle(source).isFresh()) {
            revert StaleSource(feedId, source);
        }
    }
}
