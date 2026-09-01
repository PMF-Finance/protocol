# Testing Requirements

## Required checks

Run from the contract package:

```bash
npm run compile
npm test
npm run lint
npm run coverage:check
npm run check:vault-interface
npm run security:slither
```

The deterministic suite must not require a public RPC. Operational fork tests remain in the authoritative package and are intentionally excluded from public snapshots.

## Test tiers

| Tier | Purpose |
| --- | --- |
| `test/core` | Vault, oracle, routers, property boundaries, golden fixtures, and generated-interface compatibility. |
| `test/extensions` | Optional contracts such as `FateDepositRouter`. |
| `test/integration` | Cross-service behavior that requires sibling monorepo components. |
| `test/fork` | Internal fork scenarios that are not part of the public release mirror. |
| `test/ops` | Deployment configuration, migration, rehearsal, and archived-release regressions. |

## Required adversarial coverage

- Direct ERC-4626 entry reverts while AP-only entry is active.
- AP quote digest, quote ID, and nonce replay are rejected across deposit and redemption types.
- Redemptions cannot record more assets than the shares convert to.
- Unauthorized reporting, committing, filling, pausing, fee, and lifecycle actions revert.
- Stale or replaced oracle sources block guarded NAV and intent actions.
- Wrong batch, mandate, source revision, expiry, overfill, and price bounds reject intent fills.
- Buy fills cannot spend assets reserved for redemption liabilities.
- Sell fills receive pUSD before Conditional Tokens leave the vault.
- Residual handling rejects current constituents, unknown inventory, dust, replay, overfill, low proceeds, and unauthorized callers.
- Wind-down blocks deposits and buy fills while preserving liquidation and redemption processing.
- Final close preserves queued-redemption seniority and limits direct exits to unreserved pUSD.

## Public export validation

Generate the public package into a fresh directory, install only its lockfile, and run compile, tests, lint, and interface checks from that directory. The export must reject unexpected files, secret-like values, private operational filenames, product codenames and routes, non-synthetic on-chain addresses, personal email addresses, monorepo-only references, dated launch evidence, and broken local links.
