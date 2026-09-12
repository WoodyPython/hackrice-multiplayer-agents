import { z } from 'zod';
import { repoPathSchema } from './ids.js';
import { isSupportedTextExtension } from './material.js';

/** The portable text-file namespace shared by forms, APIs, and Git. */
export const workspaceFilePathSchema = z.string().transform((raw) => raw.replace(/\\/g, '/'))
  .pipe(repoPathSchema).refine((path) => {
    if (!repoPathSchema.safeParse(path).success) return true;
    if (/[\u0000-\u001f\u007f<>:"|?*]/.test(path)) return false;
    const parts = path.split('/');
    return parts.length >= 2 && ['documents', 'code'].includes(parts[0]!) &&
      isSupportedTextExtension(path) && parts.every((part) => part && part !== '.' &&
        !/[. ]$/.test(part) && part === part.trim() &&
        !/^(\.git|\.gitattributes|\.gitmodules|hooks)$/i.test(part) &&
        !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part) &&
        !/~\d/.test(part) && part === part.normalize('NFC'));
  }, { message: 'Use a supported text file under documents/ or code/ with a portable path.' });
