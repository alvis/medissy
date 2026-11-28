# Deploy Medissy to the Sprite `medissy` (DEP01)

Status: **run, 2026-11-26** (Sprite `medissy`, org `alvis-tang`, `https://medissy-bbqg6.sprites.app`). Steps 0–7 ran, including the Box connector; the idle-wake measurement ran, but suspension itself was not observed; what the run showed is in [First run](#first-run-2026-11-26), and it overrides the **[unverified]** notes below. Commands come from the Sprites docs read on 2026-11-25 (`docs.fly.io/sprites/quickstart`, `/cli/commands`, `/concepts/services`, `/working-with-sprites`). Every value is synthetic; no secret goes in the repository, a commit, a log or the recording.

## 0. Local prerequisites (the user)

```bash
curl -fsSL https://sprites.dev/install.sh | sh   # installs `sprite` into ~/.local/bin
sprite login                                     # browser sign-in with the Fly.io account
```

Approve the Box connector in the Fly dashboard (Sprites → Connectors → Box), restricted to the `medissy` Sprite, and note the gateway connection ID and the allowed folder ID (ADR-2).

## 1. Create the Sprite and find its URL

```bash
sprite create --skip-console medissy
sprite use medissy                 # writes ./.sprite; add it to .gitignore if it appears
sprite info                        # note the URL: https://medissy-<org>.sprites.app
sprite config update --url-auth public medissy
```

- **[unverified]** `--url-auth public` is needed so independent A2A clients and browsers reach `/demo-idp`, `/institution-idp`, the portals and the card without a Sprite token. Medissy enforces its own sign-in.
- **[unverified]** the preinstalled Node version. Step 3 checks it, and the service needs Node 24 or newer (`node:sqlite`, `import.meta.main`).

## 2. Ship the code

There is no `sprite cp`. Push a tarball of the tracked tree (no `node_modules`, `dist`, `.env*` or `*.sqlite`):

```bash
git archive --format=tar.gz -o /tmp/medissy.tgz HEAD      # or: jj file list | tar czf /tmp/medissy.tgz -T -
sprite file push /tmp/medissy.tgz /home/sprite/medissy.tgz
sprite exec -- sh -c 'mkdir -p /home/sprite/medissy && tar xzf /home/sprite/medissy.tgz -C /home/sprite/medissy'
```

## 3. Install and build on the Sprite

```bash
sprite exec --dir /home/sprite/medissy -- node --version     # must print v24.x or newer [unverified]
sprite exec --dir /home/sprite/medissy -- corepack enable    # pnpm 12 from packageManager [unverified]
sprite exec --dir /home/sprite/medissy -- pnpm install --frozen-lockfile
sprite exec --dir /home/sprite/medissy -- pnpm build
```

If Node is older than 24, install Node 24 on the Sprite first (for example with `mise` or the official tarball) and point `--cmd` in step 5 at that binary.

## 4. Secrets: names only

Sprites have no secrets store (`sprite` has no `secrets` or `env` command [observed in the CLI reference]). Environment reaches a service only through `sprite-env services create --env`. Keep the values in a root-only file on the Sprite disk and load them with a wrapper instead of putting them on a command line, where they would appear in shell history and `ps`.

Write `/home/sprite/medissy.env` (mode 600) from your own terminal, typing or pasting the values. They never go in the repository:

```bash
sprite exec --tty -- sh -c 'umask 077 && ${EDITOR:-vi} /home/sprite/medissy.env'
```

It holds these names (the values are yours):

| Name | Value |
| --- | --- |
| `MEDISSY_PUBLIC_URL` | the URL from `sprite info` |
| `DATABASE_PATH` | `/home/sprite/data/medissy.sqlite` |
| `TRUST_PROXY` | `1` (required: boot is refused for an https URL without it) |
| `HOST` / `PORT` | `0.0.0.0` / `8080` **[unverified]**: whether the proxy reaches 127.0.0.1 |
| `NODE_ENV` | `production` (also disables the fixture adapter) |
| `DEMO_IDP_KEY_ENCRYPTION_KEY` | base64url of 32 random bytes |
| `DEMO_IDP_COOKIE_KEYS` | one or more random keys, comma-separated |
| `DEMO_IDP_SECRET_OWNER`, `_CARDIOLOGIST`, `_DENTIST`, `_UNKNOWN_CLINICIAN` | at least 20 characters each, or `scrypt$…` hashes |
| `ANTHROPIC_API_KEY` | optional; without it the release is the approved baseline (ADR-5) |
| `BOX_GATEWAY_CONNECTION_ID`, `BOX_ALLOWED_FOLDER_ID` | from the connector details (IDs, not credentials) |
| `BOX_CURATION_PATH` | `/home/sprite/medissy/fixtures/synthetic/records.json` |
| `MEDISSY_INBOUND_STORE` | unset by default (record hand-back unavailable). Set `box` only **after** the connector policy change below; `fixture` is refused under `NODE_ENV=production` |

### Record hand-back: connector policy change (ADR-10, applied 2026-11-26)

Record hand-back uploads one file per submission with `POST /upload/files/content`. The live run policy blocks it. To enable it, change the connection's access policy with `PUT /v1/oauth/connections/<id>` (org token, never printed):

- `allowed_endpoints`: `["/2.0/folders/<folder>/items", "/2.0/files/*", "/upload/files/content"]` (adds the exact upload path; no `/upload/*` wildcard, so new-version uploads to `/upload/files/<id>/content` stay unallowed);
- `blocked_endpoints`: `["/2.0/folders/0/*"]` (drops `/upload/*`, which would otherwise match the upload);
- `sprite_labels` and `name_prefix` unchanged.

The gateway cannot pin the upload's parent folder: the folder is in the multipart body, not the path. Medissy pins it. `createConnectorStore` always sends `parent.id = BOX_ALLOWED_FOLDER_ID` and refuses any reply whose entry is in another folder. With the connection's `root_readwrite` scope, a compromised Medissy process could upload elsewhere in that Box account; it still could not list or download outside the folder. Then set `MEDISSY_INBOUND_STORE=box` and restart the service. [unverified] Whether a blocked rule overrides an allowed one, and whether endpoint rules match exactly or by prefix: check `/upload/files/content` answers 201 and `/2.0/folders/0/items` still answers 403 from the Sprite. Do not change the live policy while a recording is running.

If the journey runs from your laptop, the passphrases must be in plaintext on the Sprite, because the script types them. Keep the same values in your untracked `.env.local`.

## 5. Seed and register the service

```bash
sprite exec --dir /home/sprite/medissy -- sh -c 'set -a; . /home/sprite/medissy.env; set +a; pnpm seed --records none'
sprite exec -- sh -c 'cat > /home/sprite/run-medissy.sh <<"EOF"
#!/bin/sh
set -a; . /home/sprite/medissy.env; set +a
exec node /home/sprite/medissy/dist/server.js
EOF
chmod 700 /home/sprite/run-medissy.sh'
sprite exec -- sprite-env services create medissy --cmd /home/sprite/run-medissy.sh --dir /home/sprite/medissy --http-port 8080
sprite exec -- sprite-env services list
sprite exec -- tail -n 50 /.sprite/logs/services/medissy.log
```

- `--records none` in production: records come from Box sync on `/owner` (A01). The fixture import is for local runs only.
- **[unverified]** whether `dist/server.js` runs under plain `node`, given the extensionless relative imports. If it fails, use `--cmd` with `node_modules/.bin/tsx` and `--args src/server.ts`.
- **[unverified]** whether `sprite-env` is reachable through `sprite exec`. The docs say only that it runs inside the Sprite.
- **[unverified]** whether a `--cmd` script with a shebang is accepted. The docs say "binary only, no arguments here".

## 6. Verify (DEP01 evidence)

From the laptop:

```bash
pnpm smoke https://medissy-<org>.sprites.app                 # card, health, Host guard, proxy, timings
pnpm smoke https://medissy-<org>.sprites.app --idle 600      # A13: wake after 10 min idle (measured, no SLA)
pnpm journey https://medissy-<org>.sprites.app               # the seven steps; .env.local holds the passphrases
```

Inside the Sprite, for A01:

```bash
sprite exec --dir /home/sprite/medissy -- sh -c 'set -a; . /home/sprite/medissy.env; set +a; pnpm smoke "$MEDISSY_PUBLIC_URL" --box'
```

For persistence (A13), run `sprite exec -- sprite-env services restart medissy`, then confirm that `/owner` still lists the receipts from the journey.

## 7. Reset and rollback

- Demo reset: `sprite exec -- sprite-env services stop medissy`, then `pnpm cleanup --yes --records none` with the env file loaded as in step 5, then `sprite-env services start medissy`.
- Before each redeploy, take `sprite checkpoint create --comment "before <change>"`. Roll back with `sprite restore <version-id>`.
- Teardown (needs explicit human approval): `sprite destroy -s medissy`.

## First run (2026-11-26)

What the deploy showed, with the commands as actually run (CLI `sprite` 2026-11-03). A first attempt went to the wrong org and that Sprite was destroyed (`sprite destroy -o <org> --force medissy`).

- **Auth.** `sprite auth setup --token "$SPRITES_API_KEY"` with the org token from the untracked `.env` (never printed). The browser `sprite login` link expired twice before approval. `sprite org set-default alvis-tang`.
- **Create.** `sprite create -o alvis-tang --skip-console --label medissy --label hacksgiving medissy`. The `medissy` label is what the Box connector policy matches.
- **Node.** v24.22.1 is preinstalled (x86_64). `corepack enable --install-directory /home/sprite/.local/bin` (no root) and `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`.
- **Exec.** Pass `--no-stdin` or `--stdin` to `sprite exec`. `sprite-env` is reachable through it.
- **Code.** `jj file list > files.txt; COPYFILE_DISABLE=1 tar czf medissy.tgz -T files.txt`, then `sprite file push`. `pnpm install --frozen-lockfile` and `pnpm build` pass.
- **Box connector.** The org already had an OAuth `box` connection (`root_readwrite`). `GET /v1/oauth/connections` (org token as Bearer) gives its id and the gateway base `https://api.sprites.dev/v1/gateway/box/<id>`, which matches `GATEWAY_BASE` and `BOX_API_PREFIX` in `src/box/connector.ts`. The access policy was set with `PUT /v1/oauth/connections/<id>` in two stages:
  1. setup: `sprite_labels: ["medissy"]`, `name_prefix: "medissy"`, endpoints for folder creation and `/upload/files/content`. From inside the Sprite: create the folder `Medissy synthetic demo (SYNTHETIC)` and upload `fixtures/synthetic/source-docs/*` (13 files, all 201). The Box root was empty beforehand.
  2. run: `allowed_endpoints: ["/2.0/folders/<folder>/items", "/2.0/files/*"]`, `blocked_endpoints: ["/upload/*", "/2.0/folders/0/*"]`. Checked from the Sprite: the folder listing answers 200, while the root listing and folder creation answer 403. Endpoint rules cannot restrict HTTP methods.
- **Secrets.** The env file was piped over `sprite exec --stdin -- sh -c 'umask 077; cat > /home/sprite/medissy.env'`. It reuses the laptop's `.env.local` demo passphrases (the journey types them), fresh `DEMO_IDP_KEY_ENCRYPTION_KEY` and `DEMO_IDP_COOKIE_KEYS`, `HOST=0.0.0.0`, `PORT=8080`, and the Box connection and folder ids (ids only, no Box credential).
- **Records.** `pnpm seed` (production default `--records none`), then the owner's **Sync** on `/owner`: `adapter: box-connector`, 13 seen, 12 imported, 1 rejected (`foreign-patient:1`, the misfiled fixture), about 21 s. Afterwards: `chmod 700 /home/sprite/data; chmod 600 /home/sprite/data/*`.
- **Service.** `sprite-env services create medissy --cmd /home/sprite/run-medissy.sh --dir /home/sprite/medissy --http-port 8080` accepts the shebang wrapper, and `dist/server.js` runs under plain `node`.
- **URL.** `sprite config update -s medissy --url-auth public`, after which the laptop smoke passes. Run before it, S1, S2 and S4 fail (sprite auth).
- **Verify.** `pnpm smoke` from the laptop: S1, S2 and S4 PASS. S3 is not checkable, since the proxy answers a foreign Host with its own 404. Inside the Sprite, `pnpm smoke "$MEDISSY_PUBLIC_URL" --box` S7 PASS (13 files). `pnpm journey`: 7/7 in 12.9 s, with live model selection. A service restart kept receipts, records and the sync run.
- **Reset.** `sprite checkpoint create -s medissy --comment "…"` (v2), `sprite-env services stop medissy`, `pnpm cleanup --yes`, `chmod` as above, `sprite-env services start medissy`, then Sync on `/owner` again.
- **Idle.** `pnpm smoke --idle 600`: 241 ms on the first `/healthz` after 600 s idle. Whether the Sprite suspended in between was not observed.
- **ADR-9 + ADR-10 redeploy (2026-11-26).** Checkpoint v5 first. Connector policy changed as in [Record hand-back](#record-hand-back-connector-policy-change-adr-10-applied-2026-11-26); from the Sprite the root listing and folder creation still answer 403 and the folder listing 200. Code unpacked into a fresh `/home/sprite/medissy-new`, installed and built, then swapped for `/home/sprite/medissy` (the old tree kept as `medissy-prev`); `MEDISSY_INBOUND_STORE=box` appended to the env file; service restarted, migrations 0009 and 0010 applied at boot. `pnpm journey` 8/8 in 14.2 s, step 7 filing into the real Box folder. The connector does not support `DELETE /2.0/files/<id>`, so a handed-back file can only be deleted in the Box web app. Reset as above, then Sync (14 seen, 12 imported, 2 rejected: the misfiled fixture and the leftover hand-back file as `unclassified-content`; 30 records). Checkpoint v6 "recording-ready". `sprite restore` is still untested.
