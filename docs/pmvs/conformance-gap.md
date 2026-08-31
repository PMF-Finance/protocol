# PMVS Conformance Gap

PMF does **not** currently claim PMVS conformance. This document is a worklist for producing a defensible claim against a future immutable PMVS tag or commit.

## Existing implementation evidence

- Public Solidity source and deterministic interface manifests.
- Contract tests for vault accounting, quote authorization, redemption queues, intents, routers, and property-style cases.
- Explicit signer and role boundaries.
- A generated export manifest tying the public snapshot to a monorepo commit and aggregate Solidity digest.

These artifacts show implementation behavior; they do not by themselves satisfy PMVS records, schemas, fixtures, discovery, or conformance rules.

## Required adapter work

1. Select and record an immutable PMVS tag or full commit hash.
2. Map each required PMVS identity, metadata, economics, lifecycle, valuation, reporting, and discovery field to an authoritative PMF source.
3. Implement a small adapter that emits PMVS records without changing the meaning of existing PMF state.
4. Define how chain, contract, vault, asset, mandate, and report identifiers remain stable across replacement deployments.
5. Declare missing or unavailable data rather than synthesizing values that look authoritative.
6. Run the PMVS validator and publish its exact version, command, fixtures, and output.
7. Add positive, boundary, and negative tests for encoding, arithmetic, freshness, and state transitions.
8. Publish a conformance statement naming the PMVS revision, PMF revision, supported optional profiles, known exclusions, and evidence location.

## Semantic gaps to resolve

| Area | PMF today | Gap before a PMVS claim |
| --- | --- | --- |
| Canonical records | Solidity state, events, and PMF interface JSON. | Map to required PMVS record semantics and versioning rules. |
| Discovery | Deployment knowledge is supplied by PMF services or manifests. | Publish the PMVS discovery mechanism and stable identifiers. |
| Valuation | NAV reporters attest values used by PMF. | Expose source, timestamp, unit, method, and limitations in PMVS form. |
| Historical continuity | Legacy ABIs are retained. | Define PMVS identity and successor relationships across deployments. |
| Trust disclosure | Roles and invariants are documented. | Encode all PMVS-required authority, dependency, and failure-mode fields. |
| Extensions | PMF quotes, intents, and liabilities exist on-chain. | Keep them optional and propose new versioned records or profiles rather than changing existing PMVS meanings. |

## Non-goals

- Reinterpreting an existing PMVS field to mean a PMF-specific concept.
- Claiming PMVS adoption, EIP status, audit coverage, or conformance without evidence.
- Making PMF's role design or backend transport mandatory for other implementations.
- Porting the entire PMF contract ABI into the standard.
