import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError, MAX_TEXT_FILE_BYTES, isSupportedTextExtension, repoPathSchema } from '@app/contracts';

export function invalidPath(): never {
  throw new ApiError('INVALID_PATH', 'Path is unsafe, unsupported, or outside the permitted files.');
}

/** One portable namespace on both Windows development and Linux production. */
export function filePath(raw: string): string {
  const path = raw.replace(/\\/g, '/');
  if (!repoPathSchema.safeParse(path).success || /[\u0000-\u001f\u007f<>:"|?*]/.test(path)) invalidPath();
  const parts = path.split('/');
  if (parts.length < 2 || !['documents', 'code'].includes(parts[0]!)) invalidPath();
  for (const part of parts) {
    if (!part || part === '.' || /[. ]$/.test(part) || part !== part.trim() ||
        /^(\.git|\.gitattributes|\.gitmodules|hooks)$/i.test(part) ||
        /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part) || /~\d/.test(part) ||
        part !== part.normalize('NFC')) invalidPath();
  }
  if (!isSupportedTextExtension(path)) invalidPath();
  return path;
}

export function pathSet(paths: string[]): Set<string> {
  return new Set(paths.map(filePath));
}

/** Refuse aliases at every path depth (e.g. code/A/x.ts and code/a/y.ts). */
export function portablePaths(paths: Iterable<string>): void {
  const names = new Map<string, string>();
  const leaves = new Set(paths);
  for (const path of leaves) {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      const previous = names.get(prefix.toLowerCase());
      if ((previous && previous !== prefix) || (i < parts.length && leaves.has(prefix))) invalidPath();
      names.set(prefix.toLowerCase(), prefix);
    }
  }
}

export function textBytes(text: string): Buffer {
  // UTF-8 encoding otherwise silently replaces lone UTF-16 surrogates.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) {
    throw new ApiError('VALIDATION_FAILED', 'Text contains an unpaired Unicode surrogate.');
  }
  const bytes = Buffer.from(text, 'utf8');
  decodeText(bytes);
  return bytes;
}

export function decodeText(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_TEXT_FILE_BYTES) {
    throw new ApiError('VALIDATION_FAILED', 'File exceeds the 1 MiB limit.', { limit: MAX_TEXT_FILE_BYTES });
  }
  let text: string;
  try {
    // A BOM is content: retaining it keeps reads, hashes, and checkpoints exact.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ApiError('VALIDATION_FAILED', 'File is not valid UTF-8 text.');
  }
  if (text.includes('\0')) throw new ApiError('VALIDATION_FAILED', 'File contains NUL bytes.');
  return text;
}

export function blobHash(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

export async function stat(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Check before mkdir, one component at a time: recursive mkdir can follow links. */
export async function directories(root: string, parts: string[], create = false): Promise<boolean> {
  const rootInfo = await stat(root);
  if (!rootInfo || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) invalidPath();
  let current = root;
  for (const part of parts) {
    await exactName(current, part);
    current = join(current, part);
    let info = await stat(current);
    if (!info && create) { await mkdir(current); info = await lstat(current); }
    if (!info) return false;
    if (info.isSymbolicLink() || !info.isDirectory()) invalidPath();
  }
  return true;
}

async function exactName(parent: string, name: string): Promise<void> {
  const names = await readdir(parent);
  if (names.some((entry) => entry.toLowerCase() === name.toLowerCase() && entry !== name)) invalidPath();
}

export async function inspectFile(root: string, path: string): Promise<boolean> {
  const parts = path.split('/');
  const name = parts.pop()!;
  if (!await directories(root, parts)) return false;
  const parent = join(root, ...parts);
  await exactName(parent, name);
  const info = await stat(join(parent, name));
  if (!info) return false;
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) invalidPath();
  return true;
}

/** Bounded read after lstat: refuse oversized/special files before reading bytes. */
export async function diskBytes(root: string, path: string): Promise<Buffer | undefined> {
  if (!await inspectFile(root, path)) return undefined;
  const handle = await open(join(root, path), 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) invalidPath();
    if (info.size > MAX_TEXT_FILE_BYTES) throw new ApiError('VALIDATION_FAILED', 'File exceeds the 1 MiB limit.');
    const buffer = Buffer.alloc(MAX_TEXT_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    const bytes = buffer.subarray(0, size);
    decodeText(bytes);
    return bytes;
  } finally { await handle.close(); }
}
