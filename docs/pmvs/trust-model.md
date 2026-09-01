# PMF Trust Model for PMVS Integrators

PMF carries trust in its backend and operators. Its improvement is that important permissions and settlement constraints are explicit and partially enforced on-chain. Integrators should distinguish **safety constraints** from **liveness and truth assumptions**.

| Actor or dependency | Trusted for | On-chain constraint | Failure effect |
| --- | --- | --- | --- |
| AP signer | Fair and available primary-market quote terms. | Role check, EIP-712 binding, deadline, replay protection, and settlement parameters. | Bad authorized terms can be offered; unavailable quotes halt that path. |
| NAV reporter | Correct valuation of external positions. | Role gating and report-state validation. | Incorrect NAV can distort accounting and quote decisions. |
| Basket oracle signer | Correct target basket and market observations. | Signature, revision, timing, and router-source checks. | A validly signed bad basket can direct bad portfolio intent. |
| Order committer | Timely selection of a valid intent batch. | Mandate, basket, expiry, reserve, and price-bound checks. | Can delay execution; cannot bypass encoded bounds. |
| Solver | Delivery of counter-assets and fill availability. | Role gating, stored-intent limits, partial-fill accounting, and receive-before-send ordering. | Can decline to fill; a fill outside stored constraints reverts. |
| Governance and manager roles | Correct configuration, pause, fees, lifecycle, and role administration. | Separated permissions and contract transition rules. | Misconfiguration or capture can impair or redirect allowed behavior. |
| External custody, venues, and pricing sources | Availability and truth of assets and observations outside the vault. | Only the references and assertions brought on-chain can be checked. | Loss, censorship, stale data, or false data may not be independently discoverable by the contract. |

## What the contracts guarantee

- Only authorized role holders can invoke privileged paths.
- Signed messages are bound to specified fields and replay identifiers.
- Expired or reference-inconsistent quotes and intents revert.
- Solver fills cannot exceed stored amounts or encoded price constraints.
- Required counter-assets arrive before the vault transfers value out.
- Redemption liabilities are ordered and reserved liquidity is not treated as freely tradable capital.

## What the contracts do not guarantee

- That a signed off-chain price is economically fair or sourced correctly.
- That NAV captures every off-chain liability or custody event.
- That an AP, reporter, committer, or solver remains online.
- That governance will configure roles or mandates prudently.
- That an intent receives a fill or a redemption is paid by a particular time.
- That PMVS records derived by a backend are complete unless their provenance is independently verified.

## Recommended PMVS disclosure

A PMVS adapter should identify each authority, its revocation path, the data it controls, maximum accepted staleness, on-chain constraints, and the difference between a safety failure and a liveness failure. It should link every reported value to the contract state, signed record, or backend assertion that produced it.
