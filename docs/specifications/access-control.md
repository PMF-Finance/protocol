# Access Control

The Solidity package uses OpenZeppelin `AccessControl`. There is no shared
AccessController contract and no protocol-wide writer/publisher role model in
the current contracts.

## PMFVault Roles

| Role | Holder type | Can call |
| --- | --- | --- |
| `DEFAULT_ADMIN_ROLE` | Protocol admin Safe | Grant and revoke vault roles. |
| `AP_ROLE` | AP quote signer | Sign `APDepositQuote` and `APRedeemQuote` authorizations. The role is checked by EIP-712 signer recovery, not by `msg.sender`. |
| `NAV_REPORTER_ROLE` | NAV reporter service/account | `reportTradingAssets(...)`. |
| `MANDATE_MANAGER_ROLE` | Protocol manager Safe | `updateOrderMandate(...)`, `setManagementFee(...)`, `beginWindDown()`, `closeFund()`. |
| `ORDER_COMMITTER_ROLE` | Intent committer signer/service | `commitOrderIntentBatchFor(...)` and `commitResidualLiquidationBatch(...)`. |
| `SOLVER_ROLE` | Solver wallet/service | `fulfillBuyIntent(...)`, `fulfillSellIntent(...)`, and `fulfillResidualSellIntent(...)`. |
| `PAUSER_ROLE` | Emergency Safe | `pause()` and `unpause()`. |

`setOperator(operator, approved)` is not role-based. Each share owner can grant
or revoke its own redemption operator. Operators can spend the owner's
redemption authorization without ERC-20 allowance.

## PMFBasketOracle Roles

| Role | Holder type | Can call |
| --- | --- | --- |
| `DEFAULT_ADMIN_ROLE` | Protocol admin Safe | Grant and revoke oracle roles. |
| `REPORT_SIGNER_ROLE` | Oracle report signer | Sign basket headers. `submitBasket(...)` can be relayed by anyone if the signature recovers this role. |
| `PAUSER_ROLE` | Emergency Safe | `pause()` and `unpause()`. |

## PMFOracleRegistry Roles

| Role | Holder type | Can call |
| --- | --- | --- |
| `DEFAULT_ADMIN_ROLE` | Protocol admin Safe | `setInitialFeed(...)`, `proposeFeed(...)`, `activateFeed(...)`, `cancelFeedReplacement(...)`. |

## Router Roles

`PMFBasketOracleRouter` and `PMFPricingRouter` use the same role pattern:

| Role | Holder type | Can call |
| --- | --- | --- |
| `DEFAULT_ADMIN_ROLE` | Protocol admin Safe | Grant and revoke router roles. |
| `ROUTER_ADMIN_ROLE` | Protocol admin Safe | Set the initial source and propose, activate, or cancel delayed source replacement. |
| `PAUSER_ROLE` | Emergency Safe | `pause()` and `unpause()`. |

## Operational Notes

- Vault, oracle, and router contracts are not upgradeable proxies.
- Role changes are the only on-chain permission-management mechanism.
- Router source replacement is delayed by `REPLACEMENT_DELAY = 24 hours`.
- `PMFVault` stores immutable router addresses and feed IDs. The routers can
  repoint to compatible sources, but the vault cannot be repointed to a
  different router.
