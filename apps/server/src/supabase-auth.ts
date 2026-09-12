/** Modern API keys are opaque credentials, not bearer JWTs. */
export function supabaseHeaders(key: string): Record<string, string> {
  return key.startsWith('sb_secret_') || key.startsWith('sb_publishable_')
    ? { apikey: key }
    : { apikey: key, authorization: `Bearer ${key}` };
}

export function supabaseServerKey(config: {
  SUPABASE_SECRET_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}): string | undefined {
  return config.SUPABASE_SECRET_KEY || config.SUPABASE_SERVICE_ROLE_KEY;
}
