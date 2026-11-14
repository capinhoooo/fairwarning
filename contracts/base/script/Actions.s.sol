// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Announcer} from "../src/Announcer.sol";
import {DemoVault, DemoVaultV2} from "../src/DemoVault.sol";

/// Step 1 (honest path): deploy V2 and announce it. Wait N blocks, then run Upgrade.
/// VAULT=0x.. ANNOUNCER=0x.. forge script script/Actions.s.sol:AnnounceUpgrade --rpc-url base --account fw-admin --broadcast
contract AnnounceUpgrade is Script {
    function run() external {
        DemoVault vault = DemoVault(vm.envAddress("VAULT"));
        Announcer announcer = Announcer(vm.envAddress("ANNOUNCER"));
        vm.startBroadcast();
        DemoVaultV2 v2 = new DemoVaultV2();
        bytes32 h = announcer.announce(address(vault), announcer.upgradeLog(address(vault), address(v2)));
        vm.stopBroadcast();
        console.log("new impl", address(v2));
        console.logBytes32(h);
    }
}

/// Step 2: the upgrade itself. Without step 1 (or before N blocks) this is the staged "leaked key" breach.
/// VAULT=0x.. NEW_IMPL=0x.. forge script script/Actions.s.sol:Upgrade --rpc-url base --account fw-admin --broadcast
contract Upgrade is Script {
    function run() external {
        DemoVault vault = DemoVault(vm.envAddress("VAULT"));
        address impl = vm.envOr("NEW_IMPL", address(0));
        vm.startBroadcast();
        if (impl == address(0)) impl = address(new DemoVaultV2());
        vault.upgradeToAndCall(impl, "");
        vm.stopBroadcast();
        console.log("upgraded to", impl, "version", vault.version());
    }
}
