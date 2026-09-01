// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IPMFPricingRouter} from "./interfaces/IPMFPricingRouter.sol";

/**
 * @title PMFPricingRouter
 * @author PMF
 * @notice Typed router for future executable pricing sources.
 * @dev Launch mode keeps primary feeds disabled and allows snapshot-bound quotes.
 */
contract PMFPricingRouter is IPMFPricingRouter, AccessControl, Pausable {
    bytes32 public constant ROUTER_ADMIN_ROLE = keccak256("ROUTER_ADMIN_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    uint64 public constant REPLACEMENT_DELAY = 24 hours;
    uint8 public constant PRICING_MODE_SNAPSHOT = 1;
    uint8 public constant PRICING_MODE_PRIMARY = 2;

    struct PricingSource {
        address source;
        bool enabled;
        uint64 revision;
    }

    struct PendingPricingSource {
        address source;
        bool enabled;
        uint64 activateAfter;
    }

    mapping(bytes32 feedId => PricingSource source) private pricingSources;
    mapping(bytes32 feedId => PendingPricingSource pendingSource) public pendingPricingSources;
    mapping(bytes32 feedId => mapping(address source => bool allowed)) public sourceAllowed;

    event PricingSourceAllowed(bytes32 indexed feedId, address indexed source, bool allowed);
    event PricingSourceSet(bytes32 indexed feedId, address indexed source, bool enabled, uint64 indexed revision);
    event PricingSourceReplacementProposed(
        bytes32 indexed feedId,
        address indexed source,
        bool enabled,
        uint64 indexed activateAfter
    );
    event PricingSourceReplacementActivated(
        bytes32 indexed feedId,
        address indexed previousSource,
        address indexed newSource,
        bool enabled,
        uint64 revision
    );
    event PricingSourceReplacementCancelled(bytes32 indexed feedId, address indexed source);
    event PricingSourceEnabled(bytes32 indexed feedId, address indexed source, bool enabled, uint64 indexed revision);

    error InvalidPricingSource();
    error PricingSourceNotAllowed(bytes32 feedId, address source);
    error PricingSourceAlreadySet(bytes32 feedId);
    error NoActivePricingSource(bytes32 feedId);
    error NoPendingPricingSource(bytes32 feedId);
    error PricingReplacementDelayActive(bytes32 feedId, uint64 activateAfter);
    error PricingFeedDisabled(bytes32 feedId);
    error PricingSourceMismatch(bytes32 feedId, address expectedSource, address actualSource);
    error InvalidPricingMode(uint8 pricingMode);

    constructor(address admin) {
        if (admin == address(0)) {
            revert InvalidPricingSource();
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ROUTER_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    function setSourceAllowed(bytes32 feedId, address source, bool allowed) external onlyRole(ROUTER_ADMIN_ROLE) {
        if (allowed) {
            _validateFeedAndSource(feedId, source, true, false);
        } else if (feedId == bytes32(0) || source == address(0)) {
            revert InvalidPricingSource();
        }
        sourceAllowed[feedId][source] = allowed;
        emit PricingSourceAllowed(feedId, source, allowed);
    }

    function setInitialSource(bytes32 feedId, address source, bool enabled) external onlyRole(ROUTER_ADMIN_ROLE) {
        if (pricingSources[feedId].revision != 0) {
            revert PricingSourceAlreadySet(feedId);
        }
        _validateFeedAndSource(feedId, source, enabled, true);
        pricingSources[feedId] = PricingSource({source: source, enabled: enabled, revision: 1});
        emit PricingSourceSet(feedId, source, enabled, 1);
    }

    function proposeSource(bytes32 feedId, address source, bool enabled) external onlyRole(ROUTER_ADMIN_ROLE) {
        _validateFeedAndSource(feedId, source, enabled, true);
        uint64 activateAfter = uint64(block.timestamp + REPLACEMENT_DELAY);
        pendingPricingSources[feedId] =
            PendingPricingSource({source: source, enabled: enabled, activateAfter: activateAfter});
        emit PricingSourceReplacementProposed(feedId, source, enabled, activateAfter);
    }

    function activateSource(bytes32 feedId) external onlyRole(ROUTER_ADMIN_ROLE) {
        PendingPricingSource memory pending = pendingPricingSources[feedId];
        if (pending.activateAfter == 0) {
            revert NoPendingPricingSource(feedId);
        }
        if (block.timestamp < pending.activateAfter) {
            revert PricingReplacementDelayActive(feedId, pending.activateAfter);
        }
        _validateFeedAndSource(feedId, pending.source, pending.enabled, true);
        PricingSource memory previous = pricingSources[feedId];
        uint64 revision = previous.revision + 1;
        if (revision == 0) {
            revision = 1;
        }
        pricingSources[feedId] =
            PricingSource({source: pending.source, enabled: pending.enabled, revision: revision});
        delete pendingPricingSources[feedId];
        emit PricingSourceReplacementActivated(feedId, previous.source, pending.source, pending.enabled, revision);
    }

    function cancelSourceReplacement(bytes32 feedId) external onlyRole(ROUTER_ADMIN_ROLE) {
        PendingPricingSource memory pending = pendingPricingSources[feedId];
        if (pending.activateAfter == 0) {
            revert NoPendingPricingSource(feedId);
        }
        delete pendingPricingSources[feedId];
        emit PricingSourceReplacementCancelled(feedId, pending.source);
    }

    function setPrimaryEnabled(bytes32 feedId, bool enabled) external onlyRole(ROUTER_ADMIN_ROLE) {
        PricingSource storage source = pricingSources[feedId];
        if (source.revision == 0) {
            revert NoActivePricingSource(feedId);
        }
        source.enabled = enabled;
        source.revision += 1;
        emit PricingSourceEnabled(feedId, source.source, enabled, source.revision);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function activePricingSource(bytes32 feedId) public view returns (address) {
        PricingSource memory source = pricingSources[feedId];
        if (source.revision == 0) {
            revert NoActivePricingSource(feedId);
        }
        return source.source;
    }

    function pricingSourceRevision(bytes32 feedId) external view returns (uint64) {
        PricingSource memory source = pricingSources[feedId];
        if (source.revision == 0) {
            revert NoActivePricingSource(feedId);
        }
        return source.revision;
    }

    function primaryEnabled(bytes32 feedId) external view returns (bool) {
        PricingSource memory source = pricingSources[feedId];
        return source.revision != 0 && source.enabled;
    }

    function validatePricingReference(bytes32 feedId, uint8 pricingMode, address source)
        external
        view
        whenNotPaused
    {
        if (pricingMode == PRICING_MODE_SNAPSHOT) {
            if (source != address(0)) {
                revert PricingSourceMismatch(feedId, address(0), source);
            }
            return;
        }
        if (pricingMode != PRICING_MODE_PRIMARY) {
            revert InvalidPricingMode(pricingMode);
        }
        PricingSource memory active = pricingSources[feedId];
        if (active.revision == 0) {
            revert NoActivePricingSource(feedId);
        }
        if (!active.enabled) {
            revert PricingFeedDisabled(feedId);
        }
        if (active.source != source) {
            revert PricingSourceMismatch(feedId, active.source, source);
        }
    }

    function _validateFeedAndSource(bytes32 feedId, address source, bool enabled, bool requireAllowed) private view {
        if (feedId == bytes32(0)) {
            revert InvalidPricingSource();
        }
        if (enabled && (source == address(0) || source.code.length == 0)) {
            revert InvalidPricingSource();
        }
        if (enabled && requireAllowed && !sourceAllowed[feedId][source]) {
            revert PricingSourceNotAllowed(feedId, source);
        }
    }
}
