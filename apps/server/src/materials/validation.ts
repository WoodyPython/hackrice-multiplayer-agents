import { ApiError, MAX_TEXT_FILE_BYTES, isSupportedTextExtension } from '@app/contracts';

/**
 * Upload validation (design section 3.4).
 *
 * "Validate UTF-8, permitted file type, byte size, and path safety. Reject
 * binary data, NUL content, archives, symlinks, and special files."
 *
 * Materials are therefore TEXT ONLY. No images, no PDFs, no archives. That
 * follows from how they are consumed: agents read them through a scoped text
 * tool (section 8.6), previews render them as inert text (section 13.3), and
 * "use as editable document" turns one into a Yjs draft (section 3.2). None of
 * those has a meaningful binary path.
 */

/** Written as escapes, never as literals, so the source stays plain ASCII. */
const NUL = '\u0000';
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface ValidatedUpload {
  filename: string;
  text: string;
  bytes: Uint8Array;
  byteSize: number;
  contentType: string;
}

/**
 * A filename is metadata, never a path.
 *
 * Object keys are built from workspace and material IDs (section 11.4), so this
 * only has to be safe to store and display. A filename carrying separators or
 * traversal is a sign of a confused or hostile client either way.
 */
export function validateFilename(raw: string): string {
  const filename = raw.trim();

  if (filename.length === 0 || filename.length > 400) {
    throw new ApiError('VALIDATION_FAILED', 'Filename must be 1 to 400 characters.');
  }
  if (/[\\/]/.test(filename)) {
    throw new ApiError('INVALID_PATH', 'Filename must not contain a path separator.');
  }
  if (filename === '.' || filename === '..' || filename.startsWith('.')) {
    throw new ApiError('INVALID_PATH', 'Filename must not be a dotfile or traversal.');
  }
  if (CONTROL_CHARS.test(filename)) {
    throw new ApiError('INVALID_PATH', 'Filename must not contain control characters.');
  }
  if (!isSupportedTextExtension(filename)) {
    throw new ApiError(
      'VALIDATION_FAILED',
      'Unsupported file type. Materials are UTF-8 text: Markdown, plain text, or a supported code format.',
      { filename },
    );
  }

  return filename;
}

/**
 * Confirms the bytes are genuinely UTF-8 text within the transport limit.
 *
 * The decode check is the part that matters. TextDecoder with `fatal` set
 * rejects malformed sequences outright, which is what stops a renamed binary
 * (a PNG uploaded as `logo.md`) from being stored as a "text" material and
 * later handed to a model or a diff.
 */
export function validateTextBytes(bytes: Uint8Array): { text: string; byteSize: number } {
  if (bytes.byteLength === 0) {
    throw new ApiError('VALIDATION_FAILED', 'File is empty.');
  }
  if (bytes.byteLength > MAX_TEXT_FILE_BYTES) {
    throw new ApiError('VALIDATION_FAILED', 'File exceeds the 1 MiB limit.', {
      byteSize: bytes.byteLength,
      limit: MAX_TEXT_FILE_BYTES,
    });
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ApiError(
      'VALIDATION_FAILED',
      'File is not valid UTF-8 text. Binary files are not supported.',
    );
  }

  // Section 3.4 names NUL content explicitly. It is the classic marker of a
  // binary file that happens to decode, and it breaks C string handling in
  // anything downstream that touches the text.
  if (text.includes(NUL)) {
    throw new ApiError('VALIDATION_FAILED', 'File contains NUL bytes.');
  }

  return { text, byteSize: bytes.byteLength };
}

/**
 * The content type we RECORD. Not the one we serve.
 *
 * Section 13.3: "Code and uploaded HTML render as text." Serving an uploaded
 * .html back as text/html from the API origin would be stored cross-site
 * scripting, so the read route always responds as text/plain regardless of what
 * is stored here. This value is display metadata only.
 */
export function recordedContentType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.html')) return 'text/html';
  if (lower.endsWith('.css')) return 'text/css';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'application/yaml';
  return 'text/plain';
}

export function validateUpload(rawFilename: string, bytes: Uint8Array): ValidatedUpload {
  const filename = validateFilename(rawFilename);
  const { text, byteSize } = validateTextBytes(bytes);
  return {
    filename,
    text,
    bytes,
    byteSize,
    contentType: recordedContentType(filename),
  };
}
