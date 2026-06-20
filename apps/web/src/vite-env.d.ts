/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_SUPABASE_FUNCTIONS_URL: string;
  readonly VITE_SPHERE_WALLET_URL: string;
  readonly VITE_GAME_TREASURY_ADDRESS: string;
  readonly VITE_UCT_COIN_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}