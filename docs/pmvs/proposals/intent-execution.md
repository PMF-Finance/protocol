# Committed Intent Execution

License: CC0-1.0. Status: PMF discussion draft. Provisional profile: `pmf/execution-intents/1`.

## Problem

Portfolio reports can describe holdings or targets without showing the executable constraints under which a vault will rebalance. Integrators need a portable way to observe a committed intent, remaining fillable amount, bounds, expiry, provenance, and actual solver fills.

## Affected surface

This should be an optional execution profile with new intent, batch, fill, and terminal-status records. It should reference existing vault, asset, mandate, and valuation identities without changing their semantics.

## Existing PMF implementation

PMF materializes bounded buy, sell, and residual intents from a fresh target basket and an on-chain mandate. Permissioned solvers partially fill stored intents. Batch identity, source revision, expiry, remaining amount, reserve, and price constraints are checked on-chain; the counter-asset is received before value leaves the vault.

## Proposed portable semantics

- A batch identifies vault, commitment time, expiry, mandate revision, target or source revision, and terminal status.
- Each intent identifies direction, asset pair, total and remaining quantities, price or proceeds bound, and cancellation/replacement relationship.
- Each fill identifies intent, solver, quantities, effective price, transaction, and post-fill remaining amount.
- Status distinguishes open, partially filled, filled, expired, and replaced/cancelled.
- Solver permissioning, discovery transport, matching, and auction design remain implementation choices.

## Sources and relationships

- **Existing implementation source:** `PMFVault` intent commitment and solver-fill paths.
- **Related standards concepts:** signed intent protocols, order records, and transaction receipts.
- **Related PMVS work:** mandate, holdings, valuation, lifecycle, and activity reporting.
- **New contribution:** consistent observability for vault-authorized bounded execution.

## Compatibility and migration

Vaults that rebalance directly or only report trades omit the profile. PMF can expose the records through events and view calls without changing its existing ABI. A different price-bound meaning, cancellation rule, or partial-fill arithmetic requires a new versioned profile.

## Security and investor effects

The profile lets investors distinguish target policy from executable orders and completed trades. It exposes liveness, solver concentration, price protection, and remaining risk. It does not guarantee that a solver will fill, that referenced market data is truthful, or that the target strategy is prudent. Consumers must treat intent state as chain- and block-specific.

## Examples

- Positive: an authorized solver partially fills an open intent within its stored amount and price bound.
- Boundary: a fill exactly equals the remaining quantity and transitions the intent to filled.
- Negative: a fill exceeding the remaining amount or violating the bound is rejected.

Machine-readable examples are in [`fixtures/pmvs-extensions`](../../../fixtures/pmvs-extensions/).

## Open questions

- Which price-bound representation is portable across decimal conventions and exact-in/exact-out execution?
- Should solver identity be an address only or reference a richer participant record?
- How should replaced batches retain an auditable link without implying their intents remain executable?
