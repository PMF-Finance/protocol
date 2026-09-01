# Releasing the PMF Protocol Snapshot

This repository is a generated release mirror of PMF's authoritative internal contracts package. Release snapshots retain public history and their internal-source provenance in `export-manifest.json`. Only maintainer-generated release pull requests are merged into `main` during phase one.

## Generate a release candidate

1. Commit the internal contract cleanup and confirm the contract/interface source tree is clean.
2. In a separate, clean checkout of `PMF-Finance/protocol`, create `release/v<packageVersion>` directly from `origin/main`.
3. From the monorepo, inspect and then apply the generated snapshot:

   ```bash
   npm run sync:public-protocol -- --repo /absolute/path/to/protocol --check
   npm run sync:public-protocol -- --repo /absolute/path/to/protocol --apply
   ```

   For the first release only, use `--initial` in both commands against an empty checkout on unborn `main`.

4. Confirm `export-manifest.json` has `sourceTreeClean: true` and `preview: false`.
5. From the protocol checkout, run:

   ```bash
   npm ci
   npm run verify:export-manifest
   npm run compile
   npm test
   npm run lint
   npm run coverage:check
   npm run check:vault-interface
   npm run security:slither
   ```

6. Review the complete Git diff. Do not add operations files, addresses, credentials, environment files, Safe transactions, or deployment evidence.

## Publish

Commit the generated files on the release branch, push it, and open a release pull request. Do not copy internal Git history and do not edit generated files only in the public repository; durable changes belong in the source package and exporter. The sync tool never commits, pushes, tags, merges, or changes GitHub settings.

After the required `Contracts / test` and `Slither / analyze` checks pass, squash-merge the release pull request. Tag the exact resulting `main` commit using the version in `package.json` and attach a release note that includes:

- the source revision and Solidity digest from `export-manifest.json`;
- supported current interfaces and retained legacy interfaces;
- whether any Solidity, ABI, trust-boundary, or behavior changed;
- known limitations or excluded operational components.

The package remains `private: true`; a GitHub release does not authorize npm publication.
