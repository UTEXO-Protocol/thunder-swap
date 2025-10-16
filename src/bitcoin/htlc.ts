import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { sha256hex, hexToBuffer } from '../utils/crypto.js';
import { config } from '../config.js';

// Initialize ECC library for bitcoinjs-lib
bitcoin.initEccLib(ecc);

interface HTLCBuildResult {
  redeemScript: Buffer;
  redeemScriptHex: string;
  p2wshAddress: string;
}

/**
 * Build HTLC redeem script for P2WSH
 * Script format:
 * OP_IF
 *   OP_SHA256 <H> OP_EQUALVERIFY
 *   <LP_pubkey> OP_CHECKSIG
 * OP_ELSE
 *   <t_lock> OP_CHECKLOCKTIMEVERIFY OP_DROP
 *   <User_pubkey> OP_CHECKSIG
 * OP_ENDIF
 */
export function buildHtlcRedeemScript(
  H_hex: string,
  lpPubkeyHex: string,
  userPubkeyHex: string,
  tLock: number
): HTLCBuildResult {
  // Validate inputs
  if (!/^[0-9a-fA-F]{64}$/.test(H_hex)) {
    throw new Error('H must be 64-character hex string (32 bytes)');
  }
  
  if (lpPubkeyHex.length !== 66 || (!lpPubkeyHex.startsWith('02') && !lpPubkeyHex.startsWith('03'))) {
    throw new Error('LP pubkey must be 33-byte compressed (66 hex chars starting with 02/03)');
  }
  
  if (userPubkeyHex.length !== 66 || (!userPubkeyHex.startsWith('02') && !userPubkeyHex.startsWith('03'))) {
    throw new Error('User pubkey must be 33-byte compressed (66 hex chars starting with 02/03)');
  }

  // Convert hex strings to buffers
  const H = hexToBuffer(H_hex);
  const lpPubkey = hexToBuffer(lpPubkeyHex);
  const userPubkey = hexToBuffer(userPubkeyHex);

  // Encode time lock as little-endian 4-byte buffer
  // const lockTimeBuffer = Buffer.alloc(4);
  // lockTimeBuffer.writeUInt32LE(tLock, 0);
  const lockTimeBuffer = bitcoin.script.number.encode(tLock);
  // Build the redeem script using proper script compilation
  const compiledScript = bitcoin.script.compile([
    // Conditional branch
    bitcoin.opcodes.OP_IF,
    // Hash commitment branch (preimage branch)  
    bitcoin.opcodes.OP_SHA256,
    H,                                    // <H> 32 bytes
    bitcoin.opcodes.OP_EQUALVERIFY,       // verify hash matches
    lpPubkey,                             // <LP_pubkey> 33 bytes
    bitcoin.opcodes.OP_CHECKSIG,          // LP can claim
    // Refund branch
    bitcoin.opcodes.OP_ELSE,
    // Time lock
    lockTimeBuffer,                       // <t_lock> as pushdata
    bitcoin.opcodes.OP_CHECKLOCKTIMEVERIFY,
    bitcoin.opcodes.OP_DROP,
    userPubkey,                           // <User_pubkey> 33 bytes
    bitcoin.opcodes.OP_CHECKSIG,          // User can refund
    bitcoin.opcodes.OP_ENDIF
  ]);

  // Compute SHA256(redeemScript) for P2WSH
  const scriptHash = sha256hex(compiledScript);
  
  // Determine network
  let network: bitcoin.Network;
  switch (config.NETWORK) {
    case 'mainnet':
      network = bitcoin.networks.bitcoin;
      break;
    case 'testnet':
    case 'signet':
      network = bitcoin.networks.testnet;
      break;
    case 'regtest':
      network = bitcoin.networks.regtest;
      break;
    default:
      throw new Error(`Unsupported network: ${config.NETWORK}`);
  }

  // Create P2WSH address
  const p2wsh = bitcoin.payments.p2wsh({
    redeem: {
      output: compiledScript
    },
    network
  });

  if (!p2wsh.address) {
    throw new Error('Failed to generate P2WSH address');
  }

  return {
    redeemScript: compiledScript,
    redeemScriptHex: compiledScript.toString('hex'),
    p2wshAddress: p2wsh.address
  };
}

/**
 * Validate that redeem script can be executed with provided witness
 */
export function validateHtlcWitness(
  redeemScript: Buffer,
  witness: Buffer[],
  spendingPath: 'claim' | 'refund'
): boolean {
  // Basic witness structure validation
  if (spendingPath === 'claim') {
    // For claim: [LP_sig, S, OP_TRUE, redeemScript]
    if (witness.length !== 4) return false;
    // Additional validation could be added here
    return true;
  } else {
    // For refund: [User_sig, OP_FALSE, redeemScript]
    if (witness.length !== 3) return false;
    // Additional validation could be added here
    return true;
  }
}
