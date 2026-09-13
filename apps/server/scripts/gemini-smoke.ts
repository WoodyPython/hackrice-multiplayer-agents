#!/usr/bin/env node
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { GoogleGenAI } from '@google/genai';

/**
 * Says exactly why Gemini is refusing, in one command.
 *
 *   npm run gemini:smoke --workspace @app/server
 *
 * This exists because a failed Start reports `provider_error` and nothing else.
 * `ModelAdapterError` is safe to report anywhere and therefore carries no
 * provider text (section 13.3), which is right for the browser and useless when
 * you are the one who has to fix it. The server log now carries the cause too,
 * but that needs a run, a task, and somewhere to read the log. This needs a
 * terminal.
 *
 * It checks the two things a Start actually does, in order: count the input
 * tokens for the orchestrator model, then generate from it. The first call is
 * where an authentication or model-availability problem shows up, which is the
 * overwhelming majority of what goes wrong here.
 *
 * Never prints the key.
 */

loadDotenv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
loadDotenv({ quiet: true });

const NL = String.fromCharCode(10);
const key = process.env.GEMINI_API_KEY?.trim();
const orchestrator = (process.env.ORCHESTRATOR_MODEL ?? 'gemini-3.8-flash').replace(/^models\//, '');
const worker = (process.env.WORKER_MODEL ?? 'gemini-3.6-flash').replace(/^models\//, '');

/** The provider's own words, with anything credential-shaped removed. */
function detail(error: unknown): { status: number | undefined; text: string } {
  const status =
    typeof error === 'object' && error !== null && 'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
      ? (error as { status: number }).status
      : undefined;
  const raw =
    error instanceof Error ? error.message
      : typeof error === 'string' ? error
        : (() => { try { return JSON.stringify(error); } catch { return String(error); } })();
  return {
    status,
    text: raw.replace(/key=[^&\s"']+/gi, 'key=[redacted]').replace(/AIza[0-9A-Za-z_-]{10,}/g, '[redacted]'),
  };
}

function advise(status: number | undefined, text: string): string {
  const lower = text.toLowerCase();
  if (status === 400 && lower.includes('api key not valid')) {
    return 'The key is rejected. Regenerate it at aistudio.google.com/apikey and replace GEMINI_API_KEY.';
  }
  if (status === 403) {
    return 'The key is valid but not permitted for this model or API. Check that the Generative Language API is enabled for the project that issued it.';
  }
  if (status === 404 || lower.includes('not found') || lower.includes('is not supported')) {
    return `The model name is not available to this key. Set ORCHESTRATOR_MODEL/WORKER_MODEL to a model your key can reach, then re-run.`;
  }
  if (status === 429) {
    return 'Rate limited or out of quota. A free-tier key cannot always reach the Pro models; try a Flash model, or wait.';
  }
  if (status !== undefined && status >= 500) {
    return 'Google returned a server error. Transient; re-run before changing anything.';
  }
  return 'Unrecognised failure. The status and text above are exactly what the provider returned.';
}

async function probe(label: string, model: string, client: GoogleGenAI): Promise<boolean> {
  try {
    const counted = await client.models.countTokens({
      model,
      contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
    });
    console.log(`ok    ${label}: ${model} reachable (counted ${counted.totalTokens} input tokens)`);
  } catch (error) {
    const { status, text } = detail(error);
    console.error(`FAIL  ${label}: ${model} — countTokens rejected${status ? ` with ${status}` : ''}`);
    console.error(`      ${text}`);
    console.error(`      ${advise(status, text)}`);
    return false;
  }

  try {
    const response = await client.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ready' }] }],
      config: { maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 128 } },
    });
    const reply = response.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim();
    console.log(`ok    ${label}: ${model} generated a response${reply ? ` (${JSON.stringify(reply.slice(0, 40))})` : ''}`);
    return true;
  } catch (error) {
    const { status, text } = detail(error);
    console.error(`FAIL  ${label}: ${model} — generateContent rejected${status ? ` with ${status}` : ''}`);
    console.error(`      ${text}`);
    console.error(`      ${advise(status, text)}`);
    return false;
  }
}

/**
 * What this key can actually reach, and the limits it reports.
 *
 * Printed because `MODEL_PROFILES` in the adapter is a hardcoded allowlist: a
 * model Google has retired cannot simply be renamed in `.env`, it has to be
 * added there with real numbers. These are those numbers.
 */
async function listAvailable(client: GoogleGenAI): Promise<void> {
  try {
    const page = await client.models.list();
    const rows: Array<{ model: string; input: number | undefined; output: number | undefined }> = [];
    for await (const model of page) {
      const name = (model.name ?? '').replace(/^models[/]/, '');
      if (!name.startsWith('gemini')) continue;
      const methods = model.supportedActions ?? [];
      if (methods.length && !methods.includes('generateContent')) continue;
      rows.push({ model: name, input: model.inputTokenLimit, output: model.outputTokenLimit });
    }
    if (rows.length === 0) {
      console.log(NL + 'No generateContent-capable Gemini models were listed for this key.');
      return;
    }
    console.log(NL + 'Models this key can reach (out= is the number MODEL_PROFILES needs):' + NL);
    for (const row of rows.sort((a, b) => a.model < b.model ? -1 : 1)) {
      console.log(`  ${row.model.padEnd(34)} in=${String(row.input ?? '?').padStart(9)}  out=${String(row.output ?? '?').padStart(7)}`);
    }
    console.log(NL + 'Pick one pro-tier and one flash-tier model, set ORCHESTRATOR_MODEL and');
    console.log('WORKER_MODEL to them, and add both to MODEL_PROFILES in');
    console.log('apps/server/src/models/gemini.ts with maxOutput set to the out= value.');
  } catch (error) {
    const { status, text } = detail(error);
    console.error(NL + `Could not list models${status ? ` (${status})` : ''}: ${text}`);
  }
}

async function main(): Promise<void> {
  if (!key) {
    console.error('FAIL  GEMINI_API_KEY is empty or absent in .env at the repository root.');
    console.error('      Every Start will end its run as `model_configuration` until it is set.');
    console.error('      Note this is a DIFFERENT symptom from `provider_error`: if your runs');
    console.error('      report provider_error, a key was present when the server booted.');
    process.exit(1);
  }
  console.log(`Key:          present (${key.length} characters)`);
  console.log(`Orchestrator: ${orchestrator}`);
  console.log(`Worker:       ${worker}\n`);

  const client = new GoogleGenAI({ apiKey: key, vertexai: false, httpOptions: { retryOptions: { attempts: 1 } } });

  // The orchestrator model is what a Start reaches first, so it is what fails first.
  const orchestratorOk = await probe('orchestrator', orchestrator, client);
  const workerOk = orchestrator === worker ? orchestratorOk : await probe('worker', worker, client);

  if (orchestratorOk && workerOk) {
    console.log('\nBoth models are reachable. A Start that still fails is not an auth or');
    console.log('model-availability problem — read the server log for "gemini request failed".');
    return;
  }
  // A failure above is almost always a retired model, and the only way to
  // choose a replacement is to see what this key can actually use.
  await listAvailable(client);
  process.exit(1);
}

main().catch((error: unknown) => {
  const { status, text } = detail(error);
  console.error(`FAIL  ${status ? `${status}: ` : ''}${text}`);
  process.exit(1);
});
