# AP-Authenticated Quote Distribution

License: CC0-1.0. Status: PMF discussion draft. Provisional profile: `pmf/admission-ap-quote/1`.

## Problem

Vault integrations need to discover whether a particular primary-market deposit or redemption is authorized, its exact terms, its expiry, and whether it was already consumed. A generic vault record alone does not provide a portable representation of a privately distributed, signer-authorized quote.

## Affected surface

A new optional quote record/profile would be preferable to changing the meaning of an existing PMVS record. The minimal surface is a quote envelope, signer authority reference, typed payload, status, and consumption event. Transport and quote discovery remain implementation choices.

## Existing PMF implementation

`PMFVault` verifies EIP-712 deposit and redemption quotes from an account with `AP_ROLE`. The signed payload binds the relevant participants, amounts, references, replay identifier, and deadline. On-chain state prevents reuse. Each AP can direct its configured fee recipient.

## Proposed portable semantics

- Identify the vault, operation type, authorized signer or signer set, beneficiary, asset/share amounts or pricing terms, nonce/replay identifier, issue time, deadline, and referenced valuation context.
- Distinguish `offered`, `consumed`, `expired`, `cancelled`, and `unknown` without treating absence from a distributor as on-chain cancellation.
- Bind the record to a signature scheme and domain definition.
- Expose the on-chain transaction or event when consumption occurs.
- Do not standardize which APs a vault must trust, how quotes are priced, or how they are transported.

## Sources and relationships

- **Adopted concept:** EIP-712 typed structured-data signatures.
- **Existing implementation source:** `PMFVault` quote-verification and quote-consumption paths.
- **Related PMVS work:** vault identity, lifecycle, valuation provenance, and interface discovery.
- **New contribution:** a portable optional record for authenticated primary-market terms and status.

## Compatibility and migration

Implementations without signed AP quotes omit the profile. Existing PMF signatures and ABI do not change; an adapter can derive the record from a distributed quote plus on-chain authority and consumption state. Any semantic change to the signed payload requires a new profile version rather than reinterpretation.

## Security and investor effects

The record improves auditability of who authorized terms and whether they remain usable. It does not prove that a quote is fair, that the signer remains solvent, or that another quote will be offered. Clients must verify chain, contract, domain, signer authority, deadline, replay status, and valuation reference before presenting executable terms.

## Examples

- Positive: a correctly bound, unexpired quote from a currently authorized AP is accepted once.
- Boundary: a quote exactly at its deadline follows the profile's explicit inclusive/exclusive rule.
- Negative: an expired or previously consumed quote is rejected even if its signature is otherwise valid.

Machine-readable examples are in [`fixtures/pmvs-extensions`](../../../fixtures/pmvs-extensions/).

## Open questions

- Should the standard normalize exact asset/share quantities, a price ratio, or support both as versioned variants?
- How should an adapter represent an off-chain quote that cannot be discovered after issuance?
- Which cancellation states must be provable on-chain versus asserted by the distributor?
