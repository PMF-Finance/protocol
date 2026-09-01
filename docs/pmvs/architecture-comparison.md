# PMVS and PMF Architecture Comparison

## High-level distinction

PMVS standardizes how a vault can be described, compared, and integrated. PMF implements a particular vault lifecycle and proves selected constraints through Solidity state transitions. Their strongest relationship is **PMVS core plus PMF extensions**, not competing vault implementations.

| Concern | PMVS contribution | PMF contribution |
| --- | --- | --- |
| Portable identity and discovery | Canonical records, identifiers, and discovery conventions across implementations. | Concrete contract addresses and interface manifests for one implementation. |
| Machine-readable vault description | Common semantics and normalized fields for integrators. | Contract state, events, ABIs, and operationally produced data. |
| Lifecycle observability | Standard records and state representation. | Enforced issuance, redemption, trading, fee, pause, wind-down, and close transitions. |
| Issuance and redemption | A shared vocabulary and integration surface. | EIP-712 AP quotes, replay protection, exact liabilities, FIFO ordering, and partial payment. |
| Portfolio execution | Portable reporting can expose policy and activity. | Basket-bound intent batches, on-chain bounds, role-gated solvers, and atomic counter-asset receipt. |
| Trust | Consistent disclosure makes implementations comparable. | Signatures, roles, freshness references, transfer ordering, and limits make part of the trust model enforceable. |
| Adoption boundary | Backend- and implementation-neutral standard. | Opinionated Solidity implementation plus off-chain services and operators. |

## What PMVS does better

PMVS is better positioned for cross-vault interoperability. A common record and schema layer lets wallets, analysts, allocators, and service providers integrate multiple vault systems without learning each implementation's internal ABI and operational conventions. Its specification-first design also allows non-PMF architectures to participate.

PMVS therefore improves PMF's external legibility: stable vocabulary, normalized discovery, versioned semantics, and a governance path for shared extensions.

## What PMF does better

PMF supplies executable semantics. Its implementation answers questions a general standard intentionally leaves open: who can sign a quote, what makes it replay-safe, when a redemption becomes an exact liability, which liquidity is reserved, how an order is bounded, what a solver must deliver, and which transition reverts when an invariant fails.

That makes PMF useful to PMVS as an implementation case study, source of adversarial examples, and test bed for optional profiles. It does not make PMF's choices universal requirements.

## Backend trust

Neither a specification nor a contract removes every live dependency. PMF still relies on APs, reporters, oracle signers, committers, solvers, governance, and external asset custody or valuation. The contracts constrain and expose those dependencies; they do not guarantee honest prices, quote availability, execution, or timely reporting. See [the trust model](trust-model.md).
