// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title DemoVault
/// @notice Minimal USDC vault behind a UUPS proxy. The owner key is the admin power Fair Warning polices.
contract DemoVault is UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    IERC20 public asset;
    mapping(address => uint256) public balanceOf;
    uint256 public totalDeposits;

    event Deposit(address indexed user, uint256 amount);
    event Withdraw(address indexed user, uint256 amount);

    error DemoVaultZeroAmount();
    error DemoVaultInsufficientBalance(uint256 balance, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param owner_ The admin key (can upgrade the vault).
    /// @param asset_ The deposit token (USDC).
    function initialize(address owner_, IERC20 asset_) external initializer {
        __Ownable_init(owner_);
        asset = asset_;
    }

    /// @notice Deposits `amount` of the asset; requires a prior approval.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert DemoVaultZeroAmount();
        balanceOf[msg.sender] += amount;
        totalDeposits += amount;
        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposit(msg.sender, amount);
    }

    /// @notice Withdraws `amount` of the caller's deposit.
    function withdraw(uint256 amount) external nonReentrant {
        uint256 balance = balanceOf[msg.sender];
        if (amount > balance) revert DemoVaultInsufficientBalance(balance, amount);
        balanceOf[msg.sender] = balance - amount;
        totalDeposits -= amount;
        asset.safeTransfer(msg.sender, amount);
        emit Withdraw(msg.sender, amount);
    }

    /// @notice Implementation version, so the demo can show an upgrade happened.
    function version() external pure virtual returns (string memory) {
        return "1";
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}

/// @title DemoVaultV2
/// @notice The "new code". In the demo the breach is simply an unannounced switch to this.
contract DemoVaultV2 is DemoVault {
    /// @inheritdoc DemoVault
    function version() external pure override returns (string memory) {
        return "2";
    }
}
