# PMF and PMVS

PMVS is a portable disclosure and interoperability specification. PMF is a deployed-contract implementation with additional issuance, execution, and settlement mechanisms. This directory describes how the two relate without claiming that PMF currently conforms to any PMVS tag or commit.

## Reading order

1. [Architecture comparison](architecture-comparison.md) separates common concerns from different system boundaries.
2. [Conformance gap](conformance-gap.md) identifies the adapter and evidence work needed for an eventual PMVS profile claim.
3. [Trust model](trust-model.md) states what PMF enforces on-chain and what remains trusted or live.
4. [Extension proposals](proposals/) package PMF mechanisms as optional, separable candidates for PMVS discussion.

## Collaboration position

PMF should consume PMVS as the common vault description layer and contribute implementation evidence plus optional extensions. It should not ask PMVS to adopt PMF's entire contract architecture, role system, pricing policy, or operational backend.

The proposal identifiers in this repository use PMF's own `pmf/` namespace. They are provisional third-party identifiers, not assigned PMVS identifiers. A future conformance statement must name an immutable PMVS release tag or commit and publish passing evidence.

## Candidate contributions

- AP-authenticated quote distribution for primary issuance and redemption.
- Committed, bounded intents with attributable solver fills.
- Exact FIFO redemption liabilities with partial settlement and liquidity reservation.
- A concrete trust-boundary disclosure derived from a working Solidity implementation.

The proposals and fixtures are CC0-1.0; the implementation remains MIT licensed. See [the licensing map](../../LICENSES/README.md).
