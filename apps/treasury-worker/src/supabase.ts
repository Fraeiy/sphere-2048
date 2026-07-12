import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';

export type Db = SupabaseClient;

export function createDb(): Db {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
