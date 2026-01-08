import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory, ECPairAPI } from 'ecpair';
import { config } from '../config.js';
import { getNetwork } from './network.js';

// Initialize ECC library for bitcoinjs-lib
bitcoin.initEccLib(ecc);
const ECPair: ECPairAPI = ECPairFactory(ecc);

export type DerivedTaprootInfo = {
  network: string;
  pubkey_hex: string;
  x_only_pubkey_hex: string;
  taproot_address: string;
};

/**
 * Derive compressed pubkey hex and taproot (bech32m) address from a WIF.
 * Uses config.NETWORK for network selection.
 */
export function deriveTaprootFromWIF(wif: string): DerivedTaprootInfo {
  const network = getNetwork();
  const keyPair = ECPair.fromWIF(wif, network);

  if (keyPair.publicKey.length !== 33) {
    throw new Error('WIF must correspond to a compressed public key for Taproot');
  }

  const pubkeyHex = keyPair.publicKey.toString('hex');
  const xOnlyPubkey = keyPair.publicKey.subarray(1, 33); // drop 0x02/0x03 prefix

  const payment = bitcoin.payments.p2tr({
    internalPubkey: xOnlyPubkey,
    network
  });

  if (!payment.address) {
    throw new Error('Failed to derive taproot address from WIF');
  }

  return {
    network: config.NETWORK,
    pubkey_hex: pubkeyHex,
    x_only_pubkey_hex: xOnlyPubkey.toString('hex'),
    taproot_address: payment.address
  };
}
