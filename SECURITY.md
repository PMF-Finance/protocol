# Security Policy

Do not disclose an unpatched vulnerability in a public issue or pull request. Open a [private GitHub security advisory](https://github.com/PMF-Finance/protocol/security/advisories/new) and include the affected contract or interface version, a minimal reproduction, impact, and any suggested mitigation.

The contracts are immutable deployments rather than upgradeable proxies. A confirmed Solidity defect may therefore require pausing, role changes, wind-down, or a replacement deployment.

## Security boundaries

- AP signers authorize deposit and redemption quote terms.
- NAV reporters attest external asset values.
- Oracle signers attest target baskets and market metadata.
- Order committers select when bounded intent batches are created.
- Solvers exchange counter-assets against stored intents.
- Governance and managers control roles, mandates, fees, pause, and lifecycle actions.

See [docs/security/guidelines.md](docs/security/guidelines.md) for invariants and review requirements.
