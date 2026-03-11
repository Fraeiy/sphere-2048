/**
 * sphere.js — Sphere SDK Integration (Unicity Blockchain)
 *
 * Handles:
 *   1. Wallet initialisation using createNodeProviders + Sphere.init()
 *   2. Submitting a game-over score as a signed broadcast on the Unicity Nostr relay
 *
 * The Sphere SDK (@unicitylabs/sphere-sdk) is a modular TypeScript SDK for the
 * Unicity blockchain. It uses a Nostr relay as its transport layer, so every
 * broadcast is a cryptographically signed Nostr event anchored to the player's
 * wallet identity.
 *
 * Required env vars (optional — falls back to auto-generated testnet wallet):
 *   SPHERE_MNEMONIC   24-word BIP39 mnemonic for an existing wallet
 *   SPHERE_NETWORK    "testnet" | "mainnet" | "dev"  (default: testnet)
 */

import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

// ─── Module State ─────────────────────────────────────────────────────────────

/** @type {import('@unicitylabs/sphere-sdk').Sphere | null} */
let sphereInstance = null;

/** Whether the SDK has been successfully initialised */
let initialised = false;

/** Wallet identity info shown on the status endpoint */
let walletInfo = { address: null, nametag: null, network: null };

// ─── Initialisation ───────────────────────────────────────────────────────────

/**
 * Connects to the Unicity Sphere chain.
 *
 * Called once at server startup. Uses testnet by default so no real funds are
 * needed. If SPHERE_MNEMONIC is set the existing wallet is loaded; otherwise a
 * fresh wallet is auto-generated and its mnemonic is printed to the console.
 *
 * @returns {Promise<void>}
 */
export async function connectSphere() {
  const network  = process.env.SPHERE_NETWORK || 'testnet';
  const mnemonic = process.env.SPHERE_MNEMONIC || undefined;

  console.log(`[Sphere] Connecting to Unicity (${network})…`);

  try {
    // Create platform-specific providers (storage, transport, oracle).
    // createNodeProviders handles Node.js WebSocket, file-based storage,
    // and the Unicity aggregator/oracle for the chosen network.
    // No l1 config → skip ALPHA blockchain L1 layer (not needed for score submission).
    const providers = createNodeProviders({ network });

    // Initialise (or load) the wallet.
    // autoGenerate: true → create a fresh wallet when none exists in storage.
    const { sphere, created, generatedMnemonic } = await Sphere.init({
      ...providers,
      mnemonic,
      autoGenerate: true,
      network,
    });

    sphereInstance = sphere;
    initialised    = true;

    // Cache identity info for the /api/sphere-status endpoint
    const identity  = sphere.identity;
    walletInfo = {
      network,
      address: identity?.address ?? null,
      nametag: identity?.nametag ?? null,
    };

    if (created && generatedMnemonic) {
      // Print generated mnemonic so the developer can save it for future runs.
      // In production you would store this securely (env var / secrets manager).
      console.log('[Sphere] ✅ New wallet created on', network);
      console.log('[Sphere] ⚠️  Save this mnemonic to reuse the same wallet:');
      console.log('[Sphere]   ', generatedMnemonic);
    } else {
      console.log('[Sphere] ✅ Existing wallet loaded. Address:', walletInfo.address);
    }
  } catch (err) {
    // Non-fatal: the game remains playable even without a chain connection.
    console.error('[Sphere] ❌ Connection failed:', err.message);
    console.warn('[Sphere]    Score submission will be disabled this session.');
  }
}

// ─── Score Submission ─────────────────────────────────────────────────────────

/**
 * Submits the player's final score to the Unicity network as a signed broadcast.
 *
 * The broadcast is a JSON string published via sphere.communications.broadcast().
 * Under the hood the SDK signs it with the wallet's Nostr key and publishes it to
 * the Unicity relay — making the record publicly verifiable and tamper-proof.
 *
 * Tags are used to filter/subscribe to game-score broadcasts on the relay.
 *
 * @param {number}   score    Final numeric score
 * @param {number[][]} board  Final board state (4×4 grid)
 * @returns {Promise<{ success: boolean, eventId?: string, error?: string }>}
 */
export async function submitScore(score, board) {
  if (!initialised || !sphereInstance) {
    return { success: false, error: 'Sphere SDK not initialised' };
  }

  // Build a structured payload stored on-chain
  const payload = {
    game:      '2048',
    score,
    board,
    network:   walletInfo.network,
    player:    walletInfo.address,
    nametag:   walletInfo.nametag,
    timestamp: new Date().toISOString(),
  };

  // Tags let anyone filter Unicity relay events for 2048 game scores
  const tags = ['game:2048', `score:${score}`];

  try {
    console.log(`[Sphere] Submitting score ${score} to the chain…`);

    const broadcast = await sphereInstance.communications.broadcast(
      JSON.stringify(payload),
      tags
    );

    const eventId = broadcast.id ?? broadcast.eventId ?? 'unknown';
    console.log(`[Sphere] ✅ Score submitted. Event ID: ${eventId}`);

    return { success: true, eventId };
  } catch (err) {
    console.error('[Sphere] ❌ Score submission failed:', err.message);
    return { success: false, error: err.message };
  }
}

// ─── Status ───────────────────────────────────────────────────────────────────

/**
 * Returns the current Sphere connection status for the /api/sphere-status route.
 * @returns {{ connected: boolean, wallet: object }}
 */
export function getSphereStatus() {
  return {
    connected: initialised,
    wallet:    walletInfo,
  };
}
