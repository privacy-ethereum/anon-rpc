// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The on-chain worker specifier (anon-rpc SPEC.md §4): identifies a worker
/// bundle by content hash and suggests where to fetch it. Harnesses MUST
/// reject any bytes whose keccak256 does not equal workerHash(); the resolver
/// URLs are advisory only.
///
/// Trust model: this specifier is FULLY owner-updatable so one stable address
/// can track worker versions. That makes the owner key the supply chain for
/// every host pinned to this address — whoever holds it can point them at new
/// code. Call renounceOwnership() to freeze the current worker forever,
/// making the specifier effectively immutable.
contract WorkerSpecifier {
    address public owner;
    bytes32 private _workerHash;
    string[] private _workerResolvers;

    event WorkerUpdated(bytes32 workerHash, string[] workerResolvers);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(bytes32 workerHash_, string[] memory workerResolvers_) {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        _setWorker(workerHash_, workerResolvers_);
    }

    /// keccak256 of the canonical worker bundle bytes (SPEC.md §4).
    function workerHash() external view returns (bytes32) {
        return _workerHash;
    }

    /// Suggested locations from which the bundle MAY be retrieved (advisory).
    function workerResolvers() external view returns (string[] memory) {
        return _workerResolvers;
    }

    /// Point the specifier at a new bundle and/or new locations.
    function setWorker(bytes32 workerHash_, string[] memory workerResolvers_) external onlyOwner {
        _setWorker(workerHash_, workerResolvers_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// Freeze the specifier: no further updates are possible afterwards.
    function renounceOwnership() external onlyOwner {
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
    }

    function _setWorker(bytes32 workerHash_, string[] memory workerResolvers_) private {
        _workerHash = workerHash_;
        _workerResolvers = workerResolvers_;
        emit WorkerUpdated(workerHash_, workerResolvers_);
    }
}
