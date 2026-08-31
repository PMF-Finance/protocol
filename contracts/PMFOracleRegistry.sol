// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title PMFOracleRegistry
 * @author PMF
 * @notice Address book for PMF oracle feeds with delayed replacement.
 */
contract PMFOracleRegistry is AccessControl {
    struct PendingFeed {
        address feed;
        uint64 activateAfter;
    }

    uint64 public constant REPLACEMENT_DELAY = 24 hours;

    mapping(bytes32 feedId => address feed) public feeds;
    mapping(bytes32 feedId => PendingFeed pendingFeed) public pendingFeeds;

    event FeedSet(bytes32 indexed feedId, address indexed feed);
    event FeedReplacementProposed(bytes32 indexed feedId, address indexed feed, uint64 activateAfter);
    event FeedReplacementActivated(bytes32 indexed feedId, address indexed previousFeed, address indexed newFeed);
    event FeedReplacementCancelled(bytes32 indexed feedId, address indexed feed);

    error InvalidFeed();
    error FeedAlreadySet(bytes32 feedId);
    error NoPendingFeed(bytes32 feedId);
    error ReplacementDelayActive(bytes32 feedId, uint64 activateAfter);

    constructor(address admin) {
        if (admin == address(0)) {
            revert InvalidFeed();
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function setInitialFeed(bytes32 feedId, address feed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (feedId == bytes32(0) || feed == address(0)) {
            revert InvalidFeed();
        }
        if (feeds[feedId] != address(0)) {
            revert FeedAlreadySet(feedId);
        }
        feeds[feedId] = feed;
        emit FeedSet(feedId, feed);
    }

    function proposeFeed(bytes32 feedId, address feed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (feedId == bytes32(0) || feed == address(0)) {
            revert InvalidFeed();
        }
        uint64 activateAfter = uint64(block.timestamp + REPLACEMENT_DELAY);
        pendingFeeds[feedId] = PendingFeed({feed: feed, activateAfter: activateAfter});
        emit FeedReplacementProposed(feedId, feed, activateAfter);
    }

    function activateFeed(bytes32 feedId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        PendingFeed memory pending = pendingFeeds[feedId];
        if (pending.feed == address(0)) {
            revert NoPendingFeed(feedId);
        }
        if (block.timestamp < pending.activateAfter) {
            revert ReplacementDelayActive(feedId, pending.activateAfter);
        }
        address previousFeed = feeds[feedId];
        feeds[feedId] = pending.feed;
        delete pendingFeeds[feedId];
        emit FeedReplacementActivated(feedId, previousFeed, pending.feed);
    }

    function cancelFeedReplacement(bytes32 feedId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        PendingFeed memory pending = pendingFeeds[feedId];
        if (pending.feed == address(0)) {
            revert NoPendingFeed(feedId);
        }
        delete pendingFeeds[feedId];
        emit FeedReplacementCancelled(feedId, pending.feed);
    }
}
