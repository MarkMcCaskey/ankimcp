interface SecretStoreSecret {
  get(): Promise<string>;
}

/** Env secret that can be a plain string (dev/test) or SecretStoreSecret (production) */
type EnvSecret = string | SecretStoreSecret;

/** Resolve an env secret to its string value */
export async function resolveSecret(secret: EnvSecret): Promise<string> {
  if (typeof secret === "string") return secret;
  return secret.get();
}

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  AUTH_TOKEN: EnvSecret;
  SYNC_USERNAME: EnvSecret;
  SYNC_PASSWORD: EnvSecret;
}
