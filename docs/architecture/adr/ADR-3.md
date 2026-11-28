# ADR-3: `/demo-idp` is an in-process, demo-only OIDC issuer

- Status: `Partially superseded by ADR-9`
- Date: `2026-11-25`
- Sources: discovery ledger D4, int-7; plan known issue I-3; brief §3.4

> **Partially superseded by [ADR-9](ADR-9.md).** Doctors no longer sign in at `/demo-idp`: they sign in at the synthetic Northgate Health institution, `/institution-idp`, built by the same factory with the same safeguards. A doctor's roles come from that institution's allowlisted ID token claim, and the organisation from Medissy's issuer config. The clinician registry is now a just-in-time record of those sign-ins. `/demo-idp` signs in only the patient owner. Everything else below still holds for both issuers.

## Context

Brief §3.4 asks for "a real development/test issuer (e.g. a configured Keycloak or hosted test OIDC tenant)". ADR-1 allows one process on one Sprite, and the demo needs synthetic clinicians who can sign in from any browser. **This is a departure (I-3):** the issuer runs inside Medissy.

## Decision

- `/demo-idp` runs `oidc-provider` 9.15.1, mounted in Medissy's process (`src/demo-idp/`). It is a **demo-only** issuer and is labelled SYNTHETIC on its pages.
- It has four synthetic personas: the owner (`synthetic-owner-morgan-testwell`), a cardiologist, a dentist and an unknown clinician. The issuer vouches for the unknown clinician, but Medissy does not register them. *(Superseded by ADR-9: the three Northgate personas sign in at `/institution-idp`; the unknown clinician is Northgate staff with no clinical role.)* Each passphrase comes from `DEMO_IDP_SECRET_*`. It must be at least 20 characters and generated at random, and it is hashed with scrypt at boot. A persona left unset cannot sign in.
- Lockout is keyed by persona **and client** (IP, with IPv6 by /64). After 5 wrong passphrases, only the guessing client is locked out of that persona, for the rest of a 15-minute window; the real owner signing in from elsewhere still gets in. The device confirm page warns that the result goes to the agent that showed the code. The signing key is encrypted at rest (`DEMO_IDP_KEY_ENCRYPTION_KEY`). Provider state lives in the `idp_store` table (migration 0005).
- Medissy reaches its issuer only through the `IssuerConnection` interface (`src/identity/issuer.ts`) and the `trusted_issuers` table. `src/identity/verifier.ts` verifies RFC 9068 `at+jwt` tokens with `jose` against that table. Organisation and roles come from Medissy's registry, never from token claims. *(Superseded by ADR-9: roles come from the trusted institution's allowlisted ID token claim, the organisation from its `trusted_issuers` row, and the registry is written just in time at each verified sign-in.)*
- **Production replacement:** point `IssuerConnection` and `trusted_issuers` at an external IdP, and remove `src/demo-idp/`. Nothing else in Medissy changes (per the `src/identity/issuer.ts` header). This swap is NOT RUN.

| Claim | Evidence |
| --- | --- |
| Rejects ID tokens, tampered or foreign signatures, untrusted or disabled issuers, the wrong audience, expiry and a missing scope | [tested] `spec/identity/verifier.spec.ts` ("rejects an ID token used as an access token", "rejects the wrong audience", "rejects a real token that lacks the required scope", and more) |
| Rejects `alg` confusion | [tested] `spec/identity/verifier.spec.ts` "rejects HS256 signed with the public key as the secret (alg confusion)" |
| Roles never come from access token claims (updated by ADR-9) | [tested] `spec/identity/verifier.spec.ts` "takes organisation and roles from the institution sign-in (ID token roles, configured organisation), never from access token claims" |
| Passphrase lockout, per persona and client | [tested] `spec/demo-idp/lockout.spec.ts` "locks after the fifth failure for the rest of the 15-minute window"; `spec/demo-idp/provider.spec.ts` "locks only the guessing client out of a persona after 5 wrong passphrases, never the doctor signing in from elsewhere" |
| Short passphrases refused | [tested] `spec/demo-idp/secrets.spec.ts` "rejects a short plaintext passphrase and a malformed hash" |
| Phishing warning on the device confirm page | [tested] `spec/demo-idp/provider.spec.ts` "warns plainly that the result goes to the agent that showed the code" |
| Residual: guessing by rotating IPs | Each IPv4 address or IPv6 /64 gets 5 guesses per 15 minutes, with no limit across clients. Only passphrase length mitigates this ([SECURITY.md](../../SECURITY.md#known-limits)). |
| The device flow works behind the Sprite's public URL | NOT RUN (SPK05; waits on DEP01) |

## Consequences

- A compromise of the Medissy process also compromises the issuer. That is acceptable for synthetic data only, and stated in [SECURITY.md](../../SECURITY.md).
- OIDC proves only who signed in to the demo issuer. It proves neither a clinical licence nor a care relationship. That comes from the patient's grant (ADR-7).

## Alternatives rejected

| Alternative | Reason |
| --- | --- |
| Keycloak or a hosted test tenant | Adds a second service or an external dependency within a four-day budget (int-7). |
| A separate issuer Sprite | User decision int-7: one Sprite. |
| Static per-client tokens | The token would sit in shared config (D8). |
