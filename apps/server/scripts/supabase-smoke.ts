#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { SupabaseBlobStore, materialObjectKey } from '../src/materials/blob-store.js';
import { SupabaseBroadcaster } from '../src/events/broadcaster.js';
import { supabaseServerKey } from '../src/supabase-auth.js';

/**
 * Proves the two Supabase integrations actually work against a live project.
 *
 * Both were written without one and are marked unverified everywhere they
 * appear. This turns that into a single command, so the first time anyone finds
 * out whether they work is not during a deploy.
 *
 *   npm run supabase:smoke --workspace @app/server
 *
 * Writes and deletes one small object under a random UUID pair, and sends one
 * broadcast. Safe to run against a real project; it leaves nothing behind.
 */

loadDotenv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
loadDotenv({ quiet: true });

const url = process.env.SUPABASE_URL;
const serviceRoleKey = supabaseServerKey(process.env);
const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'materials';

function fail(message: string): never {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

if (!url || !serviceRoleKey) {
  fail(
    'SUPABASE_URL and SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) must be set.',
  );
}

async function main(): Promise<void> {
  console.log(`Project: ${url}`);
  console.log(`Bucket:  ${bucket}\n`);

  // --- Storage ---------------------------------------------------------------
  const store = new SupabaseBlobStore({ url: url!, serviceRoleKey: serviceRoleKey!, bucket });
  const key = materialObjectKey(randomUUID(), randomUUID());
  const body = `supabase smoke test ${new Date().toISOString()}\n`;

  try {
    await store.put(key, new TextEncoder().encode(body), 'text/plain');
    console.log('ok    storage: upload');
  } catch (error) {
    fail(
      `storage upload: ${(error as Error).message}\n` +
        `      Check the bucket exists and is named "${bucket}", and that the key is the SERVICE ROLE key.`,
    );
  }

  const read = await store.get(key);
  if (!read) fail('storage read: object was written but read back as missing.');
  const roundTripped = new TextDecoder().decode(read);
  if (roundTripped !== body) {
    fail(`storage read: content differs.\n      wrote: ${body}\n      read:  ${roundTripped}`);
  }
  console.log('ok    storage: read back identical bytes');

  await store.delete(key);
  if (await store.get(key)) fail('storage delete: object still readable after delete.');
  console.log('ok    storage: delete');

  // --- Realtime --------------------------------------------------------------
  let broadcastError: unknown;
  const broadcaster = new SupabaseBroadcaster(
    { url: url!, serviceRoleKey: serviceRoleKey! },
    (error) => { broadcastError = error; },
  );

  await broadcaster.hint({
    workspaceId: randomUUID(),
    taskId: randomUUID(),
    eventType: 'task.posted',
    eventId: '0',
  });

  if (broadcastError) {
    fail(
      `realtime broadcast: ${(broadcastError as Error).message}\n` +
        '      The broadcast endpoint is /realtime/v1/api/broadcast. A 404 usually means\n' +
        '      Realtime is not enabled for the project; a 401 means the key is wrong.',
    );
  }
  console.log('ok    realtime: broadcast accepted');

  console.log('\nBoth integrations verified. Update docs/CHANGELOG.md to say so.');
}

main().catch((error: unknown) => {
  fail((error as Error).message);
});
