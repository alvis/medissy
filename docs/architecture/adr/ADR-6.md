# ADR-6: Results are text, data, an escaped HTML card and, for shares, a PNG QR, read by a generic A2A client skill

- Status: `Accepted`
- Date: `2026-11-25` (share QR revised `2026-11-26`)
- Sources: discovery ledger D7, D9, int-6, int-9, q-4, q-5, q-6; plan known issue I-2; brief §3.5, §9

## Context

Medissy is an agent that other agents reach over A2A 1.0. It is not a tool, an API or an MCP server (int-9), and no client plugin exists (int-6). A2A has no core GUI format; A2UI is an extension that neither demo client renders (q-6). OpenClaw shows model-authored HTML through `show_widget` (q-4), but only for clients that advertise inline widgets; a ```svg fence in OpenClaw chat shows as code. Hermes shows `` ```svg `` or `` ```html `` blocks only when its model repeats them from a text part (q-5). OpenClaw attaches a local image to a reply when the reply has a standalone `MEDIA:<path>` line.

Brief §3.5 and §9 ask for "local safe templates" in a client adapter, with no remote HTML. **This is a departure (I-2):** the HTML card is rendered by Medissy.

## Decision

Each completed result carries the following parts (`src/widgets/parts.ts`):

| Part | Content |
| --- | --- |
| text | A selective summary with source references, a "Portal (sign-in required)" link, and download links when files are in scope |
| data `application/vnd.medissy.disclosure+json` | `DisclosureResult` plus a FHIR R4 `collection` Bundle |
| raw `text/html` | A self-contained evidence card |
| share result | Text naming the QR image and the share URL, `application/vnd.medissy.share+json` data, a share card with the QR as inline SVG, and the QR as a raw `image/png` part named `medissy-share-qr.png` |

Denials carry only text and the denial data part.

Safeguards on the HTML:

- Every interpolation is escaped unless it is `SafeHtml`. Control and bidi characters are flattened.
- The card's CSP is `default-src 'none'; style-src 'unsafe-inline'`: no scripts, no fetches, no remote assets.
- Record text, labels and anything a caller sent are data, never markup. The malicious referral fixture is stored inert.
- The client skill takes `html` only from a **completed** task's artifact, never from a status message or an unfinished, rejected or failed task.

Safeguards on images:

- The client skill takes images only from a completed task's artifact. It accepts only `image/png` and `image/jpeg` whose bytes start with the matching signature, at most 512 KiB each and 4 per reply. SVG is never written.
- Each image goes to a fresh `0700` temporary directory as a `0600` file. The envelope carries only the path and media type, never the bytes.
- The share QR carries only the share URL, which is already in the text part.

The OpenClaw path is the generic skill `skills/a2a-client/` (`SKILL.md` plus `a2a.mjs`). It has no plugin, no MCP and no Medissy-specific logic. Install and commands: [INTEGRATION.md](../../INTEGRATION.md#openclaw-client-skill).

| Claim | Evidence |
| --- | --- |
| Escaping | [tested] `spec/widgets/parts.spec.ts` "escapes every interpolation unless it is SafeHtml", "flattens control and bidi characters and escapes Markdown" |
| Text, data and HTML parts are each contract-valid | [tested] `spec/widgets/parts.spec.ts` "returns text, disclosure data and an escaped HTML card, each contract-valid" |
| The share PNG QR decodes to the share URL | [tested] `spec/widgets/parts.spec.ts` "should return text, share data, card and a PNG QR that decodes to the share URL" |
| The client takes HTML only from completed artifacts | [tested] `spec/skills/a2a-client.spec.ts` "takes html only from a completed task artifact, never from a status message or an unfinished task" |
| The client saves only checked PNG/JPEG artifact images, owner-only | [tested] `spec/skills/a2a-client.spec.ts` "image parts", "should save an image owner-only in a private directory by default" |
| The malicious source stays inert | [tested] `spec/box/sync.spec.ts` "stores the malicious referral as inert data and widens nothing" |
| A `MEDIA:` line becomes an image attachment through an OpenClaw gateway | [observed] gateway CLI turn returned `mediaUrls`; desktop rendering NEEDS-USER-CHECK |
| OpenClaw `show_widget` renders the card unchanged, in a sandbox | NOT RUN (SPK04, A12; NEEDS-USER-CHECK) |

## Consequences

- Any A2A 1.0 client gets usable text and machine-readable FHIR. Rich rendering depends on the client.
- A chat client that shows images but not SVG or HTML still shows a scannable QR.
- The client skill now writes files: short-lived, owner-only image files in the OS temporary directory. Nothing else is written.
- The HTML's safety rests on Medissy's escaping plus the client's widget sandbox. The sandbox is not verified ([SECURITY.md](../../SECURITY.md#known-limits)).

## Alternatives rejected

| Alternative | Reason |
| --- | --- |
| An OpenClaw plugin with local templates (brief §3.5) | Excluded by int-6. Clients must work unmodified. |
| An MCP server or MCP App | It makes Medissy a tool of another agent (int-9). |
| A2UI | No demo client renders it (q-6). Deferred. |
| A fenced ```svg QR in the text part (the first version) | OpenClaw chat shows it as code, not an image. |
| A `data:` image URI in the text | Not rendered by OpenClaw chat, and it puts the bytes in model context. |
