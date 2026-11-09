/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional public contact address for pilot requests (not a secret). */
  readonly VITE_CONTACT_EMAIL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
