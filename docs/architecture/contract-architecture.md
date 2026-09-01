# Contract Architecture

## Solidity surface

```text
contracts/
├── PMFVault.sol
├── PMFBasketOracle.sol
├── PMFBasketOracleRouter.sol
├── PMFPricingRouter.sol
├── PMFOracleRegistry.sol
├── FateDepositRouter.sol
├── interfaces/
│   ├── IPMFBasketOracle.sol
│   ├── IPMFBasketOracleRouter.sol
│   └── IPMFPricingRouter.sol
└── libraries/
    ├── PMFVaultAccountingLib.sol
    ├── PMFVaultIntentLib.sol
    ├── PMFVaultQuoteLib.sol
    ├── PMFVaultRedemptionLib.sol
    ├── PMFVaultResidualLib.sol
    └── PMFVaultTypes.sol
```

The contracts use immutable deployments, linked libraries, and typed routers rather than upgradeable proxies or delegate-call modules.

## PMFVault boundaries

`PMFVault` is an ERC-4626 share vault over pUSD. Direct deposits and mints are disabled during normal operation; entry and asynchronous redemption use EIP-712 AP quotes. Trading is represented by stored, solver-fillable intents for Conditional Token positions.

Fixed constructor dependencies include pUSD, Conditional Tokens, the basket router, the pricing router, linked libraries, initial role assignments, fee settings, and the initial order mandate. Replacing vault logic or a linked library requires a new deployment.

The vault rejects unsolicited ERC-1155 transfers. Positions enter through vault-initiated fills, and residual cleanup considers only known or explicitly registered token IDs.

## Library responsibilities

| Library | Responsibility |
| --- | --- |
| `PMFVaultAccountingLib` | Net assets, unallocated capital, fees, and redemption availability. |
| `PMFVaultRedemptionLib` | FIFO requests, partial payments, and queue maintenance. |
| `PMFVaultIntentLib` | Mandate validation, target sizing, intent storage, and fill guards. |
| `PMFVaultQuoteLib` | AP quote references, signer recovery, and pricing checks. |
| `PMFVaultResidualLib` | Outside-basket inventory registration, intent creation, and liquidation state. |
| `PMFVaultTypes` | Shared structs and constants used by the vault and extensions. |

## Oracle and pricing routing

`PMFBasketOracle` validates a signed basket's feed, round, freshness, constituents, weights, prices, capacity, market data, and duplicates. `PMFBasketOracleRouter` maps a feed to an allowlisted compatible source through propose, delay, activate, and cancel operations.

`PMFPricingRouter` is separate from basket routing. It validates snapshot-bound quote references and can route allowlisted primary pricing sources. `PMFOracleRegistry` remains a service and migration address book; the vault reads the typed routers directly.

## Optional deposit extension

`FateDepositRouter` escrows pUSD for asynchronous product deposits and later executes an AP-authorized vault deposit. Its product admission, cancellation, expiry, and fill lifecycle is independent from `PMFVault`; PMFVault does not depend on it.

## Deployment implications

- Changing vault or library source requires a new vault deployment.
- Changing an oracle implementation requires a new source deployment.
- Changing an active basket or pricing source uses the router's allowlist and delay.
- Moving Solidity source paths changes compiler metadata and must be treated as a deployment-affecting change.
