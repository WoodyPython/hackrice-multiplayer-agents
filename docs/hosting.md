# Render hosting

The root `render.yaml` provisions one Node service in Oregon with 512 MB RAM
and a 1 GB persistent disk. Use the Hobby workspace; compute and disk are billed
separately. The expected base price is $7.25/month, excluding usage and other
providers. Review the price shown by Render before creating the service.

## Initial deployment

1. Review and push the hosting changes to `main`.
2. Disable Supabase GitHub integration's **Deploy to production** setting.
   This repository uses `db/migrations` and its own checksum-aware runner.
3. In Render choose **New > Blueprint**, select this repository and `main`,
   and use the root `render.yaml`. Leave the working directory blank (repo root).
4. Enter `DATABASE_URL` from Supabase's **Connect > Session pooler** (port 5432),
   including the database password. Enter `SUPABASE_URL`, `SUPABASE_SECRET_KEY`,
   `SUPABASE_PUBLISHABLE_KEY`, and `GEMINI_API_KEY` directly into Render.
   Keep the existing `materials` bucket private. Never commit these credentials.
5. Confirm the 512 MB service and 1 GB disk charges, then create the Blueprint.

The build explicitly includes development dependencies because TypeScript and
the migration CLI need them. Its Node heap is limited to 4 GB on Render's 8 GB
build worker to accommodate Monaco bundling. This override applies only to the
build, not the 512 MB application runtime. Pending migrations run before each deployment;
Git data is initialized only at runtime when `/data` is mounted. The frontend,
API, and live-document WebSocket use the same public origin. `PUBLIC_APP_URL`
defaults to `RENDER_EXTERNAL_URL`; set an explicit override for a custom domain.
Only Supabase's URL and publishable key may be sent to browsers. The server
prefers `SUPABASE_SECRET_KEY`, with `SUPABASE_SERVICE_ROLE_KEY` as a legacy fallback.
Secrets added after initial creation must be entered on the service's Environment
page; Blueprint `sync: false` prompts only during initial creation.

## Verification and operations

Run `npm run typecheck`, `npm test`, and `npm run build` locally before pushing.
Tests reset their separate local test database: never use production credentials
as `TEST_DATABASE_URL`. Check `/health`, browser deep links, API JSON errors,
WebSockets, private material storage, Realtime hints, and one small Gemini task.
Obtain approval before creating production smoke-test data or redeploying to
test persistence. Record a workspace Git SHA and health boot ID; after restart,
the SHA must remain unchanged while the boot ID changes.

Keep one process/instance and retain the `/data` disk across deployments.
Disk-backed services have brief downtime during deployments. Monitor memory
and disk use; request approval before increasing either paid resource. On failed
deployment, inspect logs and fix forward. An application rollback must retain
the disk and database; do not reset the schema or reverse applied migrations.

Sources: [Render Blueprints](https://render.com/docs/blueprint-spec),
[pricing](https://render.com/pricing), [disks](https://render.com/docs/disks),
[Supabase connections](https://supabase.com/docs/guides/database/connecting-to-postgres).
