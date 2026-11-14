// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Announcer} from "../src/Announcer.sol";
import {DemoVault} from "../src/DemoVault.sol";

/// forge script script/Deploy.s.sol --rpc-url base --account fw-admin --broadcast --verify
contract Deploy is Script {
    function run() external {
        address usdc = vm.envAddress("USDC_ADDRESS"); // Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
        vm.startBroadcast();
        address admin = msg.sender;
        DemoVault impl = new DemoVault();
        ERC1967Proxy proxy =
            new ERC1967Proxy(address(impl), abi.encodeCall(DemoVault.initialize, (admin, IERC20(usdc))));
        Announcer announcer = new Announcer(admin);
        vm.stopBroadcast();
        console.log("vault proxy", address(proxy));
        console.log("vault impl ", address(impl));
        console.log("announcer  ", address(announcer));
        console.log("deploy block", block.number);
    }
}
