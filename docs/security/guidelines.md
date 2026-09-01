# Security Guidelines

## Trust boundaries

- AP signers choose deposit and redemption quote terms. The vault verifies EIP-712 authorization, participants, deadlines, price references, and replay identifiers.
- NAV reporters attest external asset values against a referenced fresh basket; the vault does not independently price all Conditional Token inventory.
- Oracle signers attest target baskets and observed market data.
- Order committers decide when to materialize target and residual intent batches.
- Solvers choose whether and when to fill stored intents.
- Managers and governance control roles, mandates, fees, pause, wind-down, and close.

Role separation, signing security, monitoring, and incident response remain required even though execution constraints are enforced on-chain.

## Required invariants

- Assets reserved for queued redemptions cannot fund buy fills or direct exits.
- A redemption's recorded liability is not repriced after shares are burned.
- AP quote IDs, nonces, and digests cannot be replayed across quote flows.
- Intent fills reject stale or replaced batches, wrong mandates or sources, expiry, overfill, and price violations.
- The vault receives the counter-asset before transferring pUSD or Conditional Tokens to a solver.
- Residual intents cannot sell current basket constituents or unknown inventory.
- Arbitrary inbound ERC-1155 transfers are rejected.
- Wind-down and close preserve queued-redemption seniority.

## Operational controls

- Separate governance, manager, NAV reporter, AP signer, order committer, solver, and emergency-pauser duties.
- Use reviewed multisig or hardware/KMS-backed signing boundaries for privileged production roles.
- Monitor role changes, NAV reports, mandate updates, intent commitments and fills, residual state, redemptions, wind-down, and close.
- Treat AP, NAV, and oracle signing as production-critical systems with explicit freshness and incident procedures.
- Reconcile vault token inventory against emitted fills and registered residual positions.

## Static analysis

Slither is an audit input rather than a substitute for adversarial testing. `security:slither` fails on high-impact findings; `security:slither:pedantic` supports review runs that fail on every detector result. Inline suppressions require a narrow explanation adjacent to the affected code, and every new finding must be triaged against the current source.

Known complexity areas include bounded external calls in intent construction, redemption-processing event ordering, sentinel-state equality checks, fee carry arithmetic, and the size of the target-intent calculation. Changes in these areas require focused regression tests.
