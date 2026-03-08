interface SecretStoreSecret {
  get(): Promise<string>;
}

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  AUTH_TOKEN: SecretStoreSecret;
  SYNC_USERNAME: SecretStoreSecret;
  SYNC_PASSWORD: SecretStoreSecret;
}
