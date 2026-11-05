/** Build-time environment variables the console reads (Vite exposes `VITE_*` only). */
interface ImportMetaEnv {
  /** `true` serves the in-browser fake API instead of calling the real backend (ADR-0071). */
  readonly VITE_USE_FAKE_API?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
