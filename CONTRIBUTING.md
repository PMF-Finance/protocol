# Contributing

Contract changes should be small, reviewable, and tied to an explicit security or protocol requirement.

## Public collaboration model

[`PMF-Finance/protocol`](https://github.com/PMF-Finance/protocol) is a generated release mirror. PMF's monorepo remains the authoritative source during phase one.

- Open an [issue](https://github.com/PMF-Finance/protocol/issues) for a concrete bug or extension proposal.
- Use [Discussions](https://github.com/PMF-Finance/protocol/discussions) for protocol design and implementation questions.
- Only maintainer-generated release pull requests are merged into `main` during phase one.
- Accepted external proposals are implemented in the authoritative source, credited to their contributors, and included in a subsequent generated release.

Public pull requests may be reviewed as proposals, but they are not merged directly because doing so would make the mirror diverge from its source. Never report a vulnerability through an issue, discussion, or pull request; follow [SECURITY.md](SECURITY.md).

## Before opening a change

1. Install the pinned dependencies with `npm ci`.
2. Run `npm run compile`, `npm test`, `npm run lint`, and `npm run coverage:check`.
3. Run `npm run check:vault-interface` when Solidity or a published interface changes.
4. Explain any ABI, storage, role, trust-boundary, or deployment impact in the change description.

Files under `contracts/` are the verified Solidity source surface. Moving them changes compiler source metadata, so source moves require the same review as a bytecode change.

Current manifests are generated from current source. Files under the legacy interface directory describe immutable historical deployments and must not be regenerated.

Production deployment, migration, and signing procedures are intentionally maintained outside the public collaboration surface.

## Licensing

The public protocol snapshot is licensed under MIT. See [LICENSE](LICENSE).
