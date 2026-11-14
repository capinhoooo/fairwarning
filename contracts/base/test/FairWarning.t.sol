// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Announcer} from "../src/Announcer.sol";
import {DemoVault, DemoVaultV2} from "../src/DemoVault.sol";

contract MockUSDC is ERC20("USD Coin", "USDC") {
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

contract FairWarningBaseTest is Test {
    bytes32 constant UPGRADED = 0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b;
    bytes32 constant ANNOUNCE = 0xca1cdcd38b74c0372e7cd907ed543eb3e47f868a4f1f89ad553627c2b104601e;
    address admin = makeAddr("admin");
    address alice = makeAddr("alice");
    MockUSDC usdc;
    DemoVault vault;
    Announcer announcer;

    function setUp() public {
        usdc = new MockUSDC();
        DemoVault impl = new DemoVault();
        vault = DemoVault(
            address(
                new ERC1967Proxy(address(impl), abi.encodeCall(DemoVault.initialize, (admin, IERC20(address(usdc)))))
            )
        );
        announcer = new Announcer(admin);
    }

    /// NEAR computes keccak256(emitter ++ topics ++ data) from the MPC-attested log; this must equal actionHash.
    function _fingerprint(Vm.Log memory l) internal pure returns (bytes32) {
        bytes memory b = abi.encodePacked(l.emitter);
        for (uint256 i; i < l.topics.length; i++) {
            b = abi.encodePacked(b, l.topics[i]);
        }
        return keccak256(abi.encodePacked(b, l.data));
    }

    function test_topicConstants() public pure {
        assertEq(keccak256("Upgraded(address)"), UPGRADED);
        assertEq(keccak256("Announce(bytes32,address,bytes)"), ANNOUNCE);
    }

    function test_announcedActionHashMatchesRealUpgradeLog() public {
        DemoVaultV2 v2 = new DemoVaultV2();
        bytes memory expected = announcer.upgradeLog(address(vault), address(v2));
        vm.prank(admin);
        bytes32 actionHash = announcer.announce(address(vault), expected);

        vm.recordLogs();
        vm.prank(admin);
        vault.upgradeToAndCall(address(v2), "");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(vault), "UUPS emits from the proxy");
        assertEq(logs[0].topics[0], UPGRADED);
        assertEq(logs[0].data.length, 0, "Upgraded data is 0x");
        assertEq(_fingerprint(logs[0]), actionHash);
        assertEq(vault.version(), "2");
    }

    function test_announceLogShape() public {
        bytes memory expected = announcer.upgradeLog(address(vault), address(0xBEEF));
        vm.recordLogs();
        vm.prank(admin);
        bytes32 h = announcer.announce(address(vault), expected);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs[0].emitter, address(announcer));
        assertEq(logs[0].topics.length, 3);
        assertEq(logs[0].topics[0], ANNOUNCE);
        assertEq(logs[0].topics[1], h);
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(address(vault)))));
    }

    function test_ownershipTransferFingerprint() public {
        address next = makeAddr("next");
        bytes memory expected = announcer.ownershipLog(address(vault), admin, next);
        vm.recordLogs();
        vm.prank(admin);
        vault.transferOwnership(next);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_fingerprint(logs[0]), keccak256(expected));
    }

    function test_onlyOwnerAnnouncesAndUpgrades() public {
        bytes memory log_ = announcer.upgradeLog(address(vault), address(1));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        announcer.announce(address(vault), log_);
        DemoVaultV2 v2 = new DemoVaultV2();
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        vault.upgradeToAndCall(address(v2), "");
    }

    function test_announceRejectsLogForOtherTarget() public {
        bytes memory log_ = announcer.upgradeLog(address(0xdead), address(1));
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Announcer.AnnouncerLogTargetMismatch.selector, address(vault)));
        announcer.announce(address(vault), log_);
    }

    function test_vaultCustomErrors() public {
        vm.expectRevert(DemoVault.DemoVaultZeroAmount.selector);
        vault.deposit(0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DemoVault.DemoVaultInsufficientBalance.selector, 0, 1));
        vault.withdraw(1);
    }

    function test_depositWithdraw() public {
        usdc.mint(alice, 100e6);
        vm.startPrank(alice);
        usdc.approve(address(vault), 100e6);
        vault.deposit(60e6);
        vault.withdraw(10e6);
        vm.stopPrank();
        assertEq(vault.balanceOf(alice), 50e6);
        assertEq(usdc.balanceOf(address(vault)), 50e6);
    }

    function testFuzz_fingerprintIsGeneric(bytes32 salt) public {
        // UUPS checks proxiableUUID via an immutable __self, so use real CREATE2 deployments, not vm.etch
        address impl = address(new DemoVaultV2{salt: salt}());
        bytes memory expected = announcer.upgradeLog(address(vault), impl);
        vm.prank(admin);
        bytes32 h = announcer.announce(address(vault), expected);
        vm.recordLogs();
        vm.prank(admin);
        vault.upgradeToAndCall(impl, "");
        assertEq(_fingerprint(vm.getRecordedLogs()[0]), h);
    }
}
