# PMF Protocol

This repository is PMF's generated public protocol release mirror. It contains reusable vault and oracle contracts, interfaces, specifications, and focused tests. PMF's monorepo remains authoritative. The explicit export allowlist excludes production operations, deployment credentials, live-address manifests, and monorepo services.

## Components

- `PMFVault`: ERC-4626 accounting with signed AP quotes, queued redemptions, basket-bound order intents, solver fills, residual inventory handling, fees, and wind-down controls.
- `PMFBasketOracle`, `PMFBasketOracleRouter`, and `PMFPricingRouter`: signed basket publication and delayed source routing.
- `FateDepositRouter`: an optional asynchronous deposit integration; it is not required by the vault core.

## Development

```bash
npm ci
npm run compile
npm test
npm run lint
npm run coverage:check
npm run check:vault-interface
npm run verify:export-manifest
```

## Interfaces

- [Current manifests](interfaces/current/) match the source in this snapshot.
- [Legacy manifests](interfaces/legacy/) are immutable deployment interfaces and do not match the current source.

## Documentation

- [Architecture](docs/architecture/system-overview.md)
- [Vault specification](docs/specifications/pmf-vault.md)
- [Security guidance](docs/security/guidelines.md)

## Provenance

`export-manifest.json` identifies the source commit, whether the source tree was clean, the Solidity compiler version, an aggregate Solidity digest, and every exported file hash. Only exports with `sourceTreeClean: true` and `preview: false` are release candidates.

## Collaboration

Use [Issues](https://github.com/PMF-Finance/protocol/issues) for concrete bugs and extension proposals and [Discussions](https://github.com/PMF-Finance/protocol/discussions) for protocol design and implementation questions. During phase one, only maintainer-generated release pull requests merge into `main`; accepted external proposals are implemented upstream, credited, and published in the next snapshot.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [RELEASING.md](RELEASING.md) before proposing changes, reporting a vulnerability, or publishing a snapshot.
