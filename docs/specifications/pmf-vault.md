# PMFVault Specification

## Overview

`PMFVault` is an ERC-4626 pUSD share vault with
AP-only deposits, AP-priced redemptions, NAV reporting, on-chain rebalance intent
construction, residual inventory liquidation, and solver-filled atomic order
intents.

Redemption accounting records exactly what each
redeeming user is owed on-chain. APs protect against NAV drift through quote
access and quote spread by signing an exact net pUSD amount, while the vault
keeps custody, burns shares immediately, tracks liabilities, and pushes pUSD to
the recorded receiver as capital becomes available.

To stay under the EIP-170 deployed bytecode limit without moving trust offchain,
large helper logic is split into immutable linked Solidity libraries:

- `PMFVaultAccountingLib`
- `PMFVaultRedemptionLib`
- `PMFVaultIntentLib`
- `PMFVaultQuoteLib`
- `PMFVaultResidualLib`

The libraries are fixed deployment dependencies, not upgradeable modules or
replaceable facets.

## Roles

- `DEFAULT_ADMIN_ROLE` is governance for granting and revoking roles and closing
  the fund.
- `AP_ROLE` signs deposit and redemption quotes.
- `NAV_REPORTER_ROLE` reports trading assets against a fresh basket oracle
  router source, round, and hash.
- `MANDATE_MANAGER_ROLE` updates the on-chain order mandate.
- `ORDER_COMMITTER_ROLE` commits fresh oracle baskets into bounded vault order
  intent batches and residual liquidation batches.
- `PAUSER_ROLE` pauses new deposits and redemption requests.
- `SOLVER_ROLE` fills vault order intents atomically.

## Core Flows

- `depositWithAPQuote(auth, signature)` verifies an EIP-712 `APDepositQuote`,
  prevents replay, accrues any pending supply-based management fee, transfers
  quoted AP spread to the recovered AP signer's configured recipient, mints
  shares from net assets, and then processes payable redemption entries.
- `setMyFeeRecipient(recipient)` lets an address currently holding `AP_ROLE`
  configure only its own nonzero, non-vault recipient. Protocol governance can
  grant or revoke `AP_ROLE`, but cannot redirect an AP's recipient.
- `requestRedeemWithAPQuote(auth, signature)` verifies an EIP-712
  `APRedeemQuote`, prevents digest, quote ID, and nonce replay, accrues any
  pending supply-based management fee, requires
  `auth.assets <= convertToAssets(auth.shares)`, burns/removes the owner's
  shares immediately, records a sequential redemption request, and processes
  payable queue entries.
- `processRedemptions(maxRequests)` is permissionless and pays FIFO queued
  requests from available pUSD, allowing partial payment of the oldest request.
- `fulfillSellIntent(...)` receives pUSD from an approved solver, transfers CTF
  to the solver, and then processes payable redemption queue entries.
- `fulfillBuyIntent(...)` receives CTF from an approved solver and pays pUSD
  only from unallocated capital.
- `commitOrderIntentBatchFor(...)` keeps the target-basket rebalance
  calculation on-chain through `PMFVaultIntentLib`. After wind-down starts, new
  target batches emit sell-only liquidation intents for current basket
  constituents.
- `commitResidualLiquidationBatch(...)` emits separate sell-only intents for
  known CTF inventory that is held by the vault but absent from the active
  basket router source.
- `fulfillResidualSellIntent(...)` lets an approved solver buy eligible
  outside-basket residual inventory at `priceE18 >= 0.001e18`; the vault never
  redeems Conditional Tokens directly.
- `beginWindDown()` is a one-time manager action that blocks AP deposits and buy
  fills while preserving sell fills and AP redemption requests.
- `closeFund()` is a one-time manager action after wind-down that marks all
  non-pUSD assets to zero for accounting, stops AP quote flows and trading, and
  enables direct ERC-4626 `withdraw`/`redeem` exits against pUSD net of queued
  AP redemption liabilities.
- `accrueManagementFee()` mints manager shares from elapsed time and total
  supply only; it does not depend on Polymarket NAV or reported trading assets.
- `setManagementFee(feeBps, recipient)` lets the manager or admin accrue pending
  fees and then update annual management fee settings, capped at 500 bps.

## Fees

`APDepositQuote` signs:

```solidity
quoteId, nonce, payer, receiver, grossAssets, spreadAssets, minShares,
quoteReference, deadline
```

At deposit time:

- `spreadAssets` is the only upfront deduction and is paid to
  `apFeeRecipient[recoveredSigner]`.
- The AP spread cannot exceed the immutable 300 bps ceiling.
- Manager/AUM fees are not charged on deposit.
- The vault mints the actual shares from `grossAssets - spreadAssets` and
  requires that minted amount to be at least `minShares`.

Management fees are accrued as share dilution:

```text
feeFraction = managementFeeBps * elapsedSeconds / 10_000 / 365 days
managerShares = totalSupply * feeFraction / (1 - feeFraction)
```

The fee recipient receives vault shares, so the value of manager compensation
floats with the eventual value of the vault. Performance fees, high-water marks,
and profit measurement are out of scope for V2.

## Redemption Accounting

`APRedeemQuote` signs:

```solidity
quoteId, nonce, controller, owner, receiver, shares, assets,
quoteReference, deadline
```

At request time:

- `grossAssets = convertToAssets(shares)`.
- `assets` is the exact net pUSD liability owed to the user.
- `apFeeAssets = grossAssets - assets` is the exact AP liability and cannot
  exceed 300 bps of `grossAssets`.
- The recovered AP signer and its current recipient are snapshotted for the
  request. Later recipient rotations do not affect queued fees.
- The redemption request stores request id, controller, owner, receiver, shares,
  gross assets, owed assets, paid assets, remaining assets, timestamp, and queue
  link. Linked redemption storage additionally records AP signer, recipient,
  original AP fee, paid AP fee, and remaining AP fee.
- `totalPendingAssets` includes the complete user plus AP obligation.
- Limited cash is divided proportionally between remaining user and AP claims;
  final-payment rounding clears both claims exactly.

Redemption views include `redemptionRequest(id)`,
`nextRedemptionRequestId()`, `pendingRedemptionAssets()`,
`availableRedemptionAssets()`, and `unallocatedCapital()`. `APQuoteRedeemRequest`
publishes the snapshotted AP signer, recipient, and original fee;
`APFeePaid` publishes each AP payment and its remaining claim. Those events
provide the public AP-claim history while preserving EIP-170 bytecode headroom.

## NAV, Routers, And Rebalance

`totalAssets()` reports net shareholder assets:

```text
liquid pUSD + reported trading assets - unpaid redemption liabilities
```

`unallocatedCapital()` excludes unpaid redemption liabilities and the
`minVaultCashBuffer`. Pending redemptions reduce the portfolio value used for
target sizing, so the on-chain rebalance path naturally emits sell intents to
raise payout cash before buy intents can spend pUSD.

The vault stores a `PMFBasketOracleRouter` and basket feed ID rather than a
direct oracle implementation address. Target-basket rebalance batches are bound
to the active router source, source revision, oracle round, and basket hash.
Changing the router source invalidates stale target batches and NAV references.
Basket router sources must be allowlisted before initial activation or delayed
replacement, and routed basket sources are capped at 50 constituents.

The vault also stores a `PMFPricingRouter` and pricing feed ID. Launch mode
keeps primary executable pricing disabled and validates snapshot-bound AP quote
references. The current `PMFBasketOracle` snapshot payload and publisher output
remain unchanged.

Target-basket intents only evaluate current basket constituents. Residual
liquidation is separate: the vault tracks known CTF token IDs from
vault-initiated solver buy fills and manager registration, then emits residual
sell intents for held tokens that are outside the active basket. Arbitrary
inbound ERC-1155 transfers are rejected so third parties cannot bloat the
residual scan set. Residual inventory whose value at the 0.1 cent price floor
is below `minOrderNotional`, or that exceeds the retry limit, is marked ignored
so the vault does not keep emitting uneconomic intents forever.
`MANDATE_MANAGER_ROLE` can call `resetIgnoredResidualToken(tokenId)` to recover
ignored inventory for another liquidation attempt; live/open residual intents
cannot be reset through that path.

## Security Boundaries

- Offchain systems may quote, preview, and observe, but they do not decide what
  users are owed after a redemption request lands on-chain.
- AP quote freshness and spread policy are the first defense against NAV drift.
- The vault enforces that AP redemption quotes are no richer than current
  accounting NAV.
- Buy intents cannot consume pUSD reserved for redemption liabilities.
- Solver fills remain atomic: solvers do not receive vault funds or assets
  before delivering the counter-asset.
- Pausing blocks new deposits and redemption requests; permissionless queue
  processing remains available when pUSD is already in the vault.
