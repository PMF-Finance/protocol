# PMVS Extension Fixtures

These sanitized, non-normative examples accompany PMF's optional PMVS discussion drafts. They test record shape and intended outcomes; they are not signatures, live orders, production addresses, or an official PMVS conformance suite.

Each JSON document contains:

- a unique fixture `id`;
- a provisional third-party `profileId` using the `pmf/` namespace;
- a `positive`, `boundary`, or `negative` case;
- an illustrative input record; and
- an expected `accept` or `reject` result with a reason.

Validate them with `npm run check:pmvs-fixtures`. The fixtures are dedicated under [CC0-1.0](../../LICENSES/CC0-1.0.txt).
