# Setting up Supabase

Nothing is blocked without it: materials fall back to local disk and clients
poll instead of receiving refresh hints. What you get by doing it is object
storage that survives a redeploy, lower-latency updates, and — the actual reason
to do it before you need it — proof that two integrations written without a live
project actually work.

**Time: about fifteen minutes.** The last step verifies both in one command.

---

## 1. Create the project

1. <https://supabase.com/dashboard> → **New project**.
2. Pick a **region near where you are demoing**. Every API call crosses this
   link; a distant region is a slow demo.
3. Save the database password it generates. You cannot read it back later, and
   it is part of the connection string in step 3.
4. Wait for provisioning to finish before continuing — the keys are not valid
   until it does.

## 2. Create the storage bucket

**Storage** → **New bucket**.

- Name: **`materials`** (or set `SUPABASE_STORAGE_BUCKET` to match).
- **Public bucket: OFF.** This matters. Design §11.4 requires object access to
  go through the API, which scopes by workspace; a public bucket would make
  every uploaded file readable by anyone who guesses a URL, bypassing that
  entirely.

No policies are needed. The server uses the service-role key, which bypasses
row-level security by design.

## 3. Collect four values

**Project Settings → API**:

| Value | Where | Notes |
|---|---|---|
| Project URL | API settings | `https://<ref>.supabase.co` |
| `service_role` key | API settings, revealed on click | **Server only.** Never in the browser, never committed |
| `anon` / publishable key | API settings | The one value that reaches the browser |

**Project Settings → Database → Connection string → URI**:

Take the **session pooler** string, port **5432**. Not the transaction pooler on
6543: migrations and the advisory lock the runner takes need session-level
state, and the transaction pooler drops it between statements.

Replace `[YOUR-PASSWORD]` with the password from step 1.

## 4. Fill in `.env`

At the repository root. **Never commit this file** — it is gitignored.

```bash
DATABASE_URL=postgresql://postgres.<ref>:<password>@<host>:5432/postgres
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role key>
SUPABASE_PUBLISHABLE_KEY=<anon key>
SUPABASE_STORAGE_BUCKET=materials
```

Keep your local `DATABASE_URL` somewhere — you will want it back for day-to-day
work. Running tests against the hosted database is slow and destructive: the
suite drops and recreates its database on every run.

## 5. Migrate

```bash
npm run db:migrate
```

Expect six migrations. This creates every table with row-level security enabled
and no policies, which denies the PostgREST roles entirely — browsers reach data
only through the API.

**If it hangs**, you are on the transaction pooler. Go back to step 3 and take
the session pooler string.

## 6. Verify both integrations

```bash
npm run supabase:smoke --workspace @app/server
```

It uploads a small object, reads it back, compares the bytes, deletes it,
confirms it then reads as missing, and sends one broadcast. It leaves nothing
behind.

Expected:

```
ok    storage: upload
ok    storage: read back identical bytes
ok    storage: delete
ok    realtime: broadcast accepted
```

**Storage reports almost everything as `400`.** The status line is not the
status it means — the real one is in the response body, which the store reads
and deliberately never prints (§13.3: the body can echo a request, and the
service-role key travels in the headers). So diagnose a storage failure by the
body's `code`, not by the number in the message:

| Failure | Body `code` | Cause |
|---|---|---|
| `storage upload failed with 400` | `NoSuchBucket` | Bucket does not exist, or its name differs from `SUPABASE_STORAGE_BUCKET` |
| `storage upload failed with 400` | `AccessDenied` | Using the anon key where the service-role key is required |
| `storage read failed with 400` | `NoSuchBucket` | As above — a read cannot find the bucket either |
| `realtime broadcast: ... 404` | — | Realtime is not enabled for the project |
| `realtime broadcast: ... 401` | — | Wrong key |

To see a body, re-run the request by hand; the store will not show it to you.
`NoSuchKey` is *not* in that table on purpose: a missing object is a normal
answer, and the store returns `null` for it rather than failing. See
[`pitfalls.md`](pitfalls.md) for why that distinction cost an afternoon.

**When it passes, say so in `docs/CHANGELOG.md`.** Both integrations are
currently marked unverified in B04 and B06, and that note is the only signal
anyone has about their status.

## 7. Restart the server

```bash
npm run dev --workspace @app/server
```

The switch is automatic. `buildApp` selects `SupabaseBlobStore` when
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are both present, local disk
otherwise, and the same condition selects the broadcaster.

Confirm from the outside:

```bash
curl localhost:3000/api/workspaces/<any-workspace-id>/realtime
```

`realtime` should now be an object rather than `null`. Role A's client uses that
to decide whether to subscribe or poll.

---

## What is deliberately not here

**No browser writes.** §11.4: browsers never mutate tables or storage directly.
The publishable key is for subscribing to refresh channels and nothing else.

**No public channel authorisation.** Channels are public and workspace-scoped
(§5.1), because there are no participant identities to scope them further. The
design assumes a link holder can forge channel messages, which is why a hint
carries only "something changed, refetch" and never data or a decision.

**Materials are still text-only.** Storage backs the same validation: UTF-8,
under 1 MiB, supported extensions. Nothing changes about §3.4.

## Rolling back

Comment out `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, restore your local
`DATABASE_URL`, and restart. Materials return to local disk and clients return
to polling. Objects already in the bucket stay there; local disk will not have
them, so re-upload anything a demo depends on.
