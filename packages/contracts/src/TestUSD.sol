// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @title TestUSD — faucet stablecoin for TESTNETS ONLY
/// @notice Anyone can mint. Stands in for cUSD/USDC on chains where the real
///         stablecoins do not exist (e.g. Ethereum Sepolia). Never deploy the
///         escrow against this token on mainnet.
contract TestUSD {
    string public constant name = "Test USD";
    string public constant symbol = "tUSD";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// @notice Open faucet: testnet convenience, deliberately unrestricted.
    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) return false;
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        return _transfer(from, to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal returns (bool) {
        if (balanceOf[from] < amount) return false;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
