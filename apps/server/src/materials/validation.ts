import {
  ApiError,
  MAX_MATERIAL_FILE_BYTES,
  MAX_TEXT_FILE_BYTES,
  isSupportedTextExtension,
} from '@app/contracts';

/**
 * Upload validation (design section 3.4).
 *
 * Text materials retain the strict UTF-8 checks required by the editor and
 * agent tools. Other file types are accepted as immutable reference files;
 * they can be previewed or downloaded, but never opened as a Yjs draft.
 */

/** Written as escapes, never as literals, so the source stays plain ASCII. */
const NUL = '\u0000';
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface ValidatedUpload {
  filename: string;
  text?: string;
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
  return filename;
}

export function validateMaterialBytes(bytes: Uint8Array): number {
  if (bytes.byteLength === 0) {
    throw new ApiError('VALIDATION_FAILED', 'File is empty.');
  }
  if (bytes.byteLength > MAX_MATERIAL_FILE_BYTES) {
    throw new ApiError('VALIDATION_FAILED', 'File exceeds the 10 MiB limit.', {
      byteSize: bytes.byteLength,
      limit: MAX_MATERIAL_FILE_BYTES,
    });
  }
  return bytes.byteLength;
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

  return { text: decodeUtf8Text(bytes), byteSize: bytes.byteLength };
}

function decodeUtf8Text(bytes: Uint8Array): string {
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

  return text;
}

/**
 * The content type we RECORD. Not the one we serve.
 *
 * Section 13.3: "Code and uploaded HTML render as text." Serving an uploaded
 * .html back as text/html from the API origin would be stored cross-site
 * scripting, so the read route always responds as text/plain regardless of what
 * is stored here. This value is display metadata only.
 */
export function recordedContentType(filename: string, reported?: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.html')) return 'text/html';
  if (lower.endsWith('.css')) return 'text/css';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'application/yaml';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (lower.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (lower.endsWith('.zip')) return 'application/zip';
  if (reported && /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(reported)) {
    return reported.toLowerCase();
  }
  return 'application/octet-stream';
}

export function validateUpload(rawFilename: string, bytes: Uint8Array, reportedContentType?: string): ValidatedUpload {
  const filename = validateFilename(rawFilename);
  const byteSize = validateMaterialBytes(bytes);
  const text = isSupportedTextExtension(filename) ? decodeUtf8Text(bytes) : undefined;
  return {
    filename,
    ...(text !== undefined ? { text } : {}),
    bytes,
    byteSize,
    contentType: recordedContentType(filename, reportedContentType),
  };
}
