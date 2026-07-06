// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WorkerSpecifier} from "../src/WorkerSpecifier.sol";

// Minimal cheatcode surface instead of a forge-std git submodule: forge only
// needs test-prefixed functions that revert on failure, and cheatcodes live
// at the well-known hevm address.
interface Vm {
    function prank(address) external;
    function expectRevert(bytes4) external;
}

contract WorkerSpecifierTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 constant HASH_A = keccak256("bundle-a");
    bytes32 constant HASH_B = keccak256("bundle-b");
    address constant STRANGER = address(0xBEEF);

    WorkerSpecifier spec;

    function setUp() public {
        spec = new WorkerSpecifier(HASH_A, _resolvers("https://a.test/w.js"));
    }

    function test_ConstructorSetsHashResolversAndOwner() public view {
        require(spec.workerHash() == HASH_A, "hash");
        string[] memory r = spec.workerResolvers();
        require(r.length == 1, "resolver count");
        require(_eq(r[0], "https://a.test/w.js"), "resolver url");
        require(spec.owner() == address(this), "owner");
    }

    function test_SetWorkerUpdatesHashAndResolvers() public {
        string[] memory next = new string[](2);
        next[0] = "https://b.test/w.js";
        next[1] = "https://mirror.test/w.js";
        spec.setWorker(HASH_B, next);
        require(spec.workerHash() == HASH_B, "hash updated");
        string[] memory r = spec.workerResolvers();
        require(r.length == 2 && _eq(r[1], "https://mirror.test/w.js"), "resolvers updated");
    }

    function test_SetWorkerRevertsForNonOwner() public {
        vm.prank(STRANGER);
        vm.expectRevert(WorkerSpecifier.NotOwner.selector);
        spec.setWorker(HASH_B, _resolvers("https://evil.test/w.js"));
    }

    function test_TransferOwnershipHandsOverControl() public {
        spec.transferOwnership(STRANGER);
        require(spec.owner() == STRANGER, "new owner");

        vm.expectRevert(WorkerSpecifier.NotOwner.selector);
        spec.setWorker(HASH_B, _resolvers("https://b.test/w.js"));

        vm.prank(STRANGER);
        spec.setWorker(HASH_B, _resolvers("https://b.test/w.js"));
        require(spec.workerHash() == HASH_B, "stranger can update");
    }

    function test_RenounceFreezesTheSpecifier() public {
        spec.renounceOwnership();
        require(spec.owner() == address(0), "no owner");
        vm.expectRevert(WorkerSpecifier.NotOwner.selector);
        spec.setWorker(HASH_B, _resolvers("https://b.test/w.js"));
        require(spec.workerHash() == HASH_A, "frozen at original");
    }

    function _resolvers(string memory url) private pure returns (string[] memory r) {
        r = new string[](1);
        r[0] = url;
    }

    function _eq(string memory a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
