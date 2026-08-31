# FIFO Redemption Liabilities

License: CC0-1.0. Status: PMF discussion draft. Provisional profile: `pmf/settlement-fifo-liability/1`.

## Problem

Burning or locking shares does not always coincide with immediate asset payment. Integrators need to observe when a redemption becomes an exact liability, its queue priority, partial payments, remaining amount, and the liquidity reserved for the queue.

## Affected surface

A new optional asynchronous-settlement profile should define liability and payment records plus aggregate queue state. It must not make all PMVS vaults asynchronous or prescribe AP pricing.

## Existing PMF implementation

An AP-priced PMF redemption burns shares and creates an exact pUSD-denominated liability. Requests are paid in FIFO order and can be paid partially. Cash assigned to outstanding redemptions is excluded from freely available buy-side trading capital.

## Proposed portable semantics

- A liability identifies vault, owner/beneficiary, creation sequence, original amount, paid amount, remaining amount, settlement asset, and status.
- A payment identifies liability, amount, transaction, and resulting remainder.
- Aggregate state exposes queue head, total outstanding liability, and the amount or rule used to reserve settlement liquidity.
- The profile defines ordering and arithmetic precisely but leaves pricing, service-level targets, and liquidity sourcing to the implementation.

## Sources and relationships

- **Existing implementation source:** `PMFVault` redemption request, queue, partial-payment, and reserve accounting.
- **Related PMVS work:** lifecycle, liabilities, asset balances, valuation, and investor activity.
- **New contribution:** explicit observable semantics between share extinguishment and final payment.

## Compatibility and migration

Synchronous vaults omit the profile. An adapter can derive PMF liabilities and payments from contract state and events. Queue ordering, rounding, settlement asset, or reserve semantics must not change inside a profile version. Historical replacement deployments require an explicit successor relationship rather than merging queues under one identity.

## Security and investor effects

The profile makes delayed payment and seniority visible. It helps clients avoid displaying a burned redemption as fully settled and helps analysts avoid double-counting reserved cash as deployable. It does not guarantee a payment deadline or liquidity. Queue manipulation, rounding, insolvency, and governance powers over settlement must be disclosed separately.

## Examples

- Positive: available cash pays the head request and advances the queue.
- Boundary: cash pays part of the head request, which retains priority with a reduced remainder.
- Negative: execution cannot allocate liquidity reserved for outstanding redemptions to a new buy intent.

Machine-readable examples are in [`fixtures/pmvs-extensions`](../../../fixtures/pmvs-extensions/).

## Open questions

- Should reserved liquidity be a reported amount, a deterministic rule, or both?
- How should a standard represent cross-chain or off-chain settlement assets?
- Which timestamps are factual observations versus operator service targets?
