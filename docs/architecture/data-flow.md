# Contract Data Flow

This document describes the current vault, oracle, redemption, and intent flows.

## Oracle Publication

```mermaid
sequenceDiagram
    participant Publisher as Oracle publisher
    participant Oracle as PMFBasketOracle
    participant Router as PMFBasketOracleRouter
    participant Vault as PMFVault

    Publisher->>Publisher: Build BasketHeader and constituents
    Publisher->>Publisher: Sign BasketHeader with EIP-712
    Publisher->>Oracle: submitBasket(header, constituents, signature)
    Oracle->>Oracle: Validate feed, round, freshness, weights, market data
    Oracle->>Oracle: Store latest header and constituents
    Router->>Oracle: active source for feedId
    Vault->>Router: latestBasket(feedId), getConstituent(feedId), isFresh(feedId)
```

The snapshot oracle stores the latest target basket. The router selects the
active compatible basket source for a feed ID. Neither the snapshot oracle nor
the router stores historical constituents or cleanup inventory.

## AP Deposit

```mermaid
sequenceDiagram
    participant AP as AP quote signer
    participant User
    participant Vault as PMFVault
    participant PUSD as pUSD

    User->>AP: Request deposit quote
    AP->>User: APDepositQuote signature
    User->>Vault: depositWithAPQuote(auth, signature)
    Vault->>Vault: Check deadline, payer, signer role, quote replay
    Vault->>Vault: Accrue management fee
    Vault->>PUSD: transferFrom(payer, vault, netAssets)
    Vault->>PUSD: transferFrom(payer, spreadRecipient, spreadAssets)
    Vault->>Vault: Mint shares to receiver
    Vault->>Vault: Process payable redemption queue entries
```

Direct ERC-4626 `deposit` and `mint` are intentionally disabled.

## AP Redemption Request

```mermaid
sequenceDiagram
    participant AP as AP quote signer
    participant User
    participant Vault as PMFVault
    participant PUSD as pUSD
    participant Receiver

    User->>AP: Request redemption quote
    AP->>User: APRedeemQuote signature
    User->>Vault: requestRedeemWithAPQuote(auth, signature)
    Vault->>Vault: Check signer role, quote replay, owner/operator/allowance
    Vault->>Vault: Verify auth.assets <= convertToAssets(auth.shares)
    Vault->>Vault: Burn shares and enqueue pUSD liability
    Vault->>PUSD: Pay available FIFO liability
    PUSD->>Receiver: pUSD payment if liquidity is available
```

The vault records the exact pUSD liability at request time. Later NAV changes do
not change an already queued request.

## Order Intent Commit

```mermaid
sequenceDiagram
    participant Committer as Order committer
    participant Vault as PMFVault
    participant Router as PMFBasketOracleRouter
    participant Oracle as PMFBasketOracle
    participant CTF as Conditional Tokens

    Committer->>Vault: commitOrderIntentBatchFor(hash, round)
    Vault->>Router: Resolve active source and revision
    Router->>Oracle: latestBasket(), isFresh(), getConstituentCount()
    loop current constituents only
        Vault->>Router: getConstituent(feedId, index)
        Vault->>CTF: balanceOf(vault, tokenId)
        Vault->>Vault: Compare current value to target value
        Vault->>Vault: Store buy/sell intent if mandate bounds pass
    end
```

Target rebalance only sees current basket constituents. Outside-basket inventory
is handled by residual liquidation, not by re-adding stale tokens to the normal
basket.

## Residual Liquidation

```mermaid
sequenceDiagram
    participant Committer as Order committer
    participant Vault as PMFVault
    participant Router as PMFBasketOracleRouter
    participant Solver
    participant PUSD as pUSD
    participant CTF as Conditional Tokens

    Committer->>Vault: commitResidualLiquidationBatch(tokenIds)
    Vault->>Router: Verify active source is fresh
    Vault->>Vault: Validate explicit candidate token IDs
    Vault->>Router: Check token is absent from active basket
    Vault->>Vault: Emit residual sell intents above dust threshold
    Solver->>PUSD: approve vault
    Solver->>Vault: fulfillResidualSellIntent(batchId, intentHash, size, price)
    Vault->>Vault: Check SOLVER_ROLE, outside-basket, expiry, replay, price floor
    PUSD->>Vault: transferFrom(solver, vault, proceeds)
    Vault->>CTF: safeTransferFrom(vault, solver, tokenId, size)
```

The intent committer owns residual candidate discovery from events, inventory,
and reconciliation state; the vault skips candidates that are unknown, current
basket constituents, zero-balance, dust, or not state-ready. Residual sales
require `priceE18 >= 0.001e18`. Uneconomic balances below the configured
`minOrderNotional` threshold at that floor are marked ignored so closed or
expired worthless positions do not create recurring work.
Managers can reset ignored residual inventory for another attempt with
`resetIgnoredResidualToken(tokenId)`; the vault rejects resets for unknown,
tracked, or currently open residual inventory.

## Solver Fill

```mermaid
sequenceDiagram
    participant Solver
    participant Vault as PMFVault
    participant PUSD as pUSD
    participant CTF as Conditional Tokens

    alt Buy intent
        Solver->>CTF: approve vault
        Solver->>Vault: fulfillBuyIntent(batchId, intentHash, fillSize, price)
        Vault->>Vault: Check role, batch, oracle, mandate, expiry, price, cash
        CTF->>Vault: safeTransferFrom(solver, vault, tokenId, fillSize)
        PUSD->>Solver: pUSD payment
    else Sell intent
        Solver->>PUSD: approve vault
        Solver->>Vault: fulfillSellIntent(batchId, intentHash, fillSize, price)
        Vault->>Vault: Check role, batch, oracle, mandate, expiry, price
        PUSD->>Vault: transferFrom(solver, vault, assets)
        CTF->>Solver: safeTransferFrom(vault, solver, tokenId, fillSize)
        Vault->>Vault: Process payable redemption queue entries
    end
```

The vault transfers out value only after it receives the counter-asset.

## Wind-Down And Final Close

```mermaid
sequenceDiagram
    participant Manager
    participant Vault as PMFVault
    participant Solver
    participant Holder

    Manager->>Vault: beginWindDown()
    Vault->>Vault: Block deposits and buy fills
    Manager->>Vault: commitOrderIntentBatchFor(hash, round)
    Vault->>Vault: Emit sell-only intents for current constituents
    Manager->>Vault: commitResidualLiquidationBatch(tokenIds)
    Vault->>Vault: Emit sell-only intents for outside-basket residual inventory
    Solver->>Vault: fulfillSellIntent(...)
    Solver->>Vault: fulfillResidualSellIntent(...)
    Manager->>Vault: closeFund()
    Vault->>Vault: Mark non-pUSD assets down for accounting
    Holder->>Vault: redeem()/withdraw() direct pUSD exit
```

Wind-down target batches only cover current basket constituents. Residual
batches cover known outside-basket CTF inventory through the same permissioned
solver boundary.
