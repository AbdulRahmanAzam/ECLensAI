/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API prefix. Defaults to `/api/v1`, which vite.config.ts proxies to :4000. */
  readonly VITE_API_BASE?: string;
  readonly VITE_CURRENCY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
