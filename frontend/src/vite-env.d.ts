/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Базовый адрес API при размещении клиента отдельно от сервера. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
