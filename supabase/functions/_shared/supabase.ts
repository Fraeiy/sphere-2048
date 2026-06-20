import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

export function createServiceClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Missing Supabase service configuration');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function createUserClient(authHeader: string) {
  const url = Deno.env.get('SUPABASE_URL');
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !anon) throw new Error('Missing Supabase anon configuration');
  return createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}