// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title Announcer
/// @notice Public notice board for admin actions. NEAR's fw contract checks Announce logs via Read MPC.
/// @dev actionHash = keccak256(emitter ++ topics ++ data) of the exact log the action will emit.
contract Announcer is Ownable {
    bytes32 public constant UPGRADED_TOPIC = keccak256("Upgraded(address)");
    bytes32 public constant OWNERSHIP_TOPIC = keccak256("OwnershipTransferred(address,address)");
    bytes32 public constant ROLE_GRANTED_TOPIC = keccak256("RoleGranted(bytes32,address,address)");

    /// @notice An admin action on `target` that will emit exactly `expectedLog`.
    event Announce(bytes32 indexed actionHash, address indexed target, bytes expectedLog);

    /// @notice `expectedLog` is too short or does not start with `target`'s address.
    error AnnouncerLogTargetMismatch(address target);

    /// @param owner_ The admin key that may announce.
    constructor(address owner_) Ownable(owner_) {}

    /// @notice Publishes notice of a future admin action.
    /// @param target The contract that will emit the log (e.g. the vault proxy).
    /// @param expectedLog Emitter address (20 bytes) ++ topics ++ data of the log the action will emit.
    /// @return actionHash keccak256 of `expectedLog`, the value the fw contract matches against.
    function announce(address target, bytes calldata expectedLog) external onlyOwner returns (bytes32 actionHash) {
        if (expectedLog.length < 52 || address(bytes20(expectedLog[:20])) != target) {
            revert AnnouncerLogTargetMismatch(target);
        }
        actionHash = keccak256(expectedLog);
        emit Announce(actionHash, target, expectedLog);
    }

    /// @notice expectedLog for a UUPS upgrade of `proxy` to `newImpl`.
    function upgradeLog(address proxy, address newImpl) public pure returns (bytes memory) {
        return abi.encodePacked(proxy, UPGRADED_TOPIC, bytes32(uint256(uint160(newImpl))));
    }

    /// @notice expectedLog for an Ownable ownership transfer on `target`.
    function ownershipLog(address target, address prevOwner, address newOwner) public pure returns (bytes memory) {
        return abi.encodePacked(
            target, OWNERSHIP_TOPIC, bytes32(uint256(uint160(prevOwner))), bytes32(uint256(uint160(newOwner)))
        );
    }

    /// @notice expectedLog for an AccessControl role grant on `target`.
    function roleGrantedLog(address target, bytes32 role, address account, address sender)
        public
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            target, ROLE_GRANTED_TOPIC, role, bytes32(uint256(uint160(account))), bytes32(uint256(uint160(sender)))
        );
    }
}
