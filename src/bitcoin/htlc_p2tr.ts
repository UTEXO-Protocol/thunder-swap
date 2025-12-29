import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { hexToBuffer, bufferToHex } from '../utils/crypto.js';
import { config } from '../config.js';
import { assertValidPaymentHash, assertValidCompressedPubkey } from '../utils/crypto.js';

// Initialize ECC library for bitcoinjs-lib
bitcoin.initEccLib(ecc);

// Protocol constants for deterministic internal key and tapscript leaves
const INTERNAL_KEY_CONSTANT = 'HODL_INVOICE_P2TR_HTLC_INTERNAL_KEY_v0';
const INTERNAL_KEY_MAX_ATTEMPTS = 256;
const TAPLEAF_VERSION = 0xc0;

export interface P2TRHTLCBuildResult {
  taproot_address: string;
  internal_key_hex: string;
}

export interface P2TRHTLCTemplate {
  payment_hash: string; // H_hex (64-char hex)
  lp_pubkey: string; // Operator pubkey (66-char hex, compressed; converted to x-only)
  user_pubkey: string; // User pubkey (66-char hex, compressed; converted to x-only)
  cltv_expiry: number; // Timelock block height
}

type Tapleaf = { output: Buffer; version?: number };
type Taptree = [Tapleaf, Tapleaf];

function assertValidCltvExpiry(cltvExpiry: number): void {
  if (!Number.isSafeInteger(cltvExpiry) || cltvExpiry < 0) {
    throw new Error('cltv_expiry must be a non-negative integer');
  }

  if (cltvExpiry > 0xffffffff) {
    throw new Error('cltv_expiry must be <= 0xffffffff');
  }
}

function toXOnlyPubkey(pubkeyHex: string, label: string): Buffer {
  assertValidCompressedPubkey(pubkeyHex, label);
  const pubkey = hexToBuffer(pubkeyHex);
  const xOnly = Buffer.from(ecc.xOnlyPointFromPoint(pubkey));

  if (!ecc.isXOnlyPoint(xOnly)) {
    throw new Error(`${label} pubkey is not a valid x-only key`);
  }

  return xOnly;
}

function getNetwork(): bitcoin.Network {
  switch (config.NETWORK) {
    case 'mainnet':
      return bitcoin.networks.bitcoin;
    case 'testnet':
    case 'signet':
      return bitcoin.networks.testnet;
    case 'regtest':
      return bitcoin.networks.regtest;
    default:
      throw new Error(`Unsupported network: ${config.NETWORK}`);
  }
}

/**
 * Derive deterministic unspendable internal key for Taproot HTLC
 * Uses protocol constant to ensure no party controls the private key
 */
export function deriveDeterministicInternalKey(): Buffer {
  const seed = Buffer.from(INTERNAL_KEY_CONSTANT, 'utf8');
  for (let attempt = 0; attempt < INTERNAL_KEY_MAX_ATTEMPTS; attempt++) {
    const attemptBuf = Buffer.alloc(4);
    attemptBuf.writeUInt32BE(attempt, 0);
    const data = attempt === 0 ? seed : Buffer.concat([seed, attemptBuf]);
    const candidate = bitcoin.crypto.sha256(data);

    if (ecc.isXOnlyPoint(candidate)) {
      return candidate;
    }
  }

  throw new Error('Failed to derive deterministic internal key');
}

/**
 * Build claim tapscript leaf
 * Script: OP_SHA256 <payment_hash> OP_EQUALVERIFY <LP_pubkey_xonly> OP_CHECKSIG
 */
export function buildClaimTapscript(paymentHashHex: string, lpPubkeyHex: string): Buffer {
  assertValidPaymentHash(paymentHashHex);
  const H = hexToBuffer(paymentHashHex);
  const lpPubkey = toXOnlyPubkey(lpPubkeyHex, 'LP');

  const script = bitcoin.script.compile([
    bitcoin.opcodes.OP_SHA256,
    H,
    bitcoin.opcodes.OP_EQUALVERIFY,
    lpPubkey,
    bitcoin.opcodes.OP_CHECKSIG
  ]);

  return script;
}

/**
 * Build refund tapscript leaf
 * Script: <t_lock> OP_CHECKLOCKTIMEVERIFY OP_DROP <User_pubkey_xonly> OP_CHECKSIG
 */
export function buildRefundTapscript(cltvExpiry: number, userPubkeyHex: string): Buffer {
  assertValidCltvExpiry(cltvExpiry);
  const userPubkey = toXOnlyPubkey(userPubkeyHex, 'User');
  const lockTimeBuffer = bitcoin.script.number.encode(cltvExpiry);

  const script = bitcoin.script.compile([
    lockTimeBuffer,
    bitcoin.opcodes.OP_CHECKLOCKTIMEVERIFY,
    bitcoin.opcodes.OP_DROP,
    userPubkey,
    bitcoin.opcodes.OP_CHECKSIG
  ]);

  return script;
}

/**
 * Serialize script with length prefix (BIP-341 ser_string)
 */
function serString(script: Buffer): Buffer {
  const len = script.length;
  if (len < 0xfd) {
    return Buffer.concat([Buffer.from([len]), script]);
  } else if (len <= 0xffff) {
    const lenBuf = Buffer.alloc(3);
    lenBuf[0] = 0xfd;
    lenBuf.writeUInt16LE(len, 1);
    return Buffer.concat([lenBuf, script]);
  } else if (len <= 0xffffffff) {
    const lenBuf = Buffer.alloc(5);
    lenBuf[0] = 0xfe;
    lenBuf.writeUInt32LE(len, 1);
    return Buffer.concat([lenBuf, script]);
  } else {
    throw new Error('Script too long');
  }
}

/**
 * Compute Taproot script tree hash (TaggedHash with "TapLeaf" tag)
 * BIP-341: tapleaf_version || ser_string(script)
 */
function computeTapLeafHash(script: Buffer, leafVersion: number = TAPLEAF_VERSION): Buffer {
  const serialized = serString(script);
  const data = Buffer.concat([Buffer.from([leafVersion]), serialized]);
  return bitcoin.crypto.taggedHash('TapLeaf', data);
}

/**
 * Compute Taproot Merkle tree root from leaf hashes
 * For two leaves, returns the sorted hash of both leaves
 */
function computeTaprootTreeRoot(leafHashes: Buffer[]): Buffer {
  if (leafHashes.length === 0) {
    throw new Error('Taproot tree requires at least one leaf');
  }

  if (leafHashes.length === 1) {
    return leafHashes[0];
  }

  if (leafHashes.length !== 2) {
    throw new Error('Taproot tree supports exactly two leaves for this HTLC');
  }

  const [left, right] =
    Buffer.compare(leafHashes[0], leafHashes[1]) <= 0
      ? [leafHashes[0], leafHashes[1]]
      : [leafHashes[1], leafHashes[0]];

  return bitcoin.crypto.taggedHash('TapBranch', Buffer.concat([left, right]));
}

/**
 * Compute TapTweak for Taproot output key
 * BIP-341: tagged_hash("TapTweak", internal_key || tree_root)
 */
function computeTapTweak(internalKey: Buffer, treeRoot: Buffer): Buffer {
  if (internalKey.length !== 32 || !ecc.isXOnlyPoint(internalKey)) {
    throw new Error('Invalid internal key for TapTweak');
  }

  if (treeRoot.length !== 32) {
    throw new Error('Invalid Taproot tree root');
  }

  const data = Buffer.concat([internalKey, treeRoot]);
  return bitcoin.crypto.taggedHash('TapTweak', data);
}

/**
 * Compute Taproot output key from internal key and tree root
 */
function computeTaprootOutputKey(internalKey: Buffer, treeRoot: Buffer): Buffer {
  const tapTweak = computeTapTweak(internalKey, treeRoot);
  const tweaked = ecc.xOnlyPointAddTweak(internalKey, tapTweak);

  if (!tweaked || !tweaked.xOnlyPubkey) {
    throw new Error('Failed to compute Taproot output key');
  }

  return Buffer.from(tweaked.xOnlyPubkey);
}

/**
 * Reconstruct expected P2TR scriptPubKey from template
 * This is used for verification to compare against on-chain output
 */
export function reconstructP2TRScriptPubKey(template: P2TRHTLCTemplate): Buffer {
  // Build tapscript leaves
  const claimScript = buildClaimTapscript(template.payment_hash, template.lp_pubkey);
  const refundScript = buildRefundTapscript(template.cltv_expiry, template.user_pubkey);

  // Derive deterministic internal key
  const internalKey = deriveDeterministicInternalKey();

  // Compute leaf hashes
  const claimLeafHash = computeTapLeafHash(claimScript);
  const refundLeafHash = computeTapLeafHash(refundScript);

  // Compute tree root
  const treeRoot = computeTaprootTreeRoot([claimLeafHash, refundLeafHash]);

  // Compute output key and scriptPubKey
  const outputKey = computeTaprootOutputKey(internalKey, treeRoot);
  return bitcoin.script.compile([bitcoin.opcodes.OP_1, outputKey]);
}

/**
 * Build P2TR HTLC
 * Returns minimal result: taproot address and internal key
 */
export function buildP2TRHTLC(
  paymentHashHex: string,
  lpPubkeyHex: string,
  userPubkeyHex: string,
  cltvExpiry: number
): P2TRHTLCBuildResult {
  // Build tapscript leaves
  const claimScript = buildClaimTapscript(paymentHashHex, lpPubkeyHex);
  const refundScript = buildRefundTapscript(cltvExpiry, userPubkeyHex);

  // Derive deterministic internal key
  const internalKey = deriveDeterministicInternalKey();
  const internalKeyHex = bufferToHex(internalKey);

  const network = getNetwork();
  const scriptTree: Taptree = [
    { output: claimScript, version: TAPLEAF_VERSION },
    { output: refundScript, version: TAPLEAF_VERSION }
  ];

  const p2tr = bitcoin.payments.p2tr({
    internalPubkey: internalKey,
    scriptTree,
    network
  });

  if (!p2tr.address) {
    throw new Error('Failed to generate P2TR address');
  }

  return {
    taproot_address: p2tr.address,
    internal_key_hex: internalKeyHex
  };
}
