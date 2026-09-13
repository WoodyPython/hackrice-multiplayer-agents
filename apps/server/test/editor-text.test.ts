import { describe, expect, it } from 'vitest';
import { normalizeEditorText } from '../src/collaboration/editor-text.js';

describe('shared editor text', () => {
  it('normalizes mixed line endings before Monaco and Yjs share offsets', () => {
    expect(normalizeEditorText('def one():\r\n  pass\r\ndef two():\n  pass\r'))
      .toBe('def one():\n  pass\ndef two():\n  pass\n');
  });
});
