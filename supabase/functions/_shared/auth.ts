import { create, verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

const JWT_SECRET = Deno.env.get('JWT_SECRET') ?? Deno.env.get('SUPABASE_JWT_SECRET');

export interface PlayerJwtClaims {
  player_id: string;
  did: string;
  wallet_address: string;
  role: 'player';
}

export async function signPlayerToken(claims: PlayerJwtClaims, ttlSeconds = 86400): Promise<string> {
  if (!JWT_SECRET) throw new Error('JWT_SECRET not configured');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  return await create(
    { alg: 'HS256', typ: 'JWT' },
    { ...claims, exp: Math.floor(Date.now() / 1000) + ttlSeconds, iat: Math.floor(Date.now() / 1000) },
    key,
  );
}

export async function verifyPlayerToken(token: string): Promise<PlayerJwtClaims> {
  if (!JWT_SECRET) throw new Error('JWT_SECRET not configured');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  const payload = await verify(token, key);
  if (!payload || typeof payload !== 'object') throw new Error('Invalid token');
  const p = payload as Record<string, unknown>;
  if (!p.player_id || !p.did || !p.wallet_address) throw new Error('Invalid token claims');
  return {
    player_id: String(p.player_id),
    did: String(p.did),
    wallet_address: String(p.wallet_address),
    role: 'player',
  };
}

export function getBearerToken(req: Request): string | null {
  const header = req.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7);
}