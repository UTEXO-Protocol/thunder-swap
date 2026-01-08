#!/usr/bin/env node
import * as bitcoin from 'bitcoinjs-lib';
import * as tinysecp from 'tiny-secp256k1';
import { ECPairFactory, ECPairAPI } from 'ecpair';
import { config } from '../config.js';
import { deriveTaprootFromWIF } from './keys.js';
import { rpc } from './rpc.js';
import { getNetwork } from './network.js';
import { isValidCompressedPubkey } from '../utils/crypto.js';

bitcoin.initEccLib(tinysecp);
const ECPair: ECPairAPI = ECPairFactory(tinysecp);

const SATS_PER_BTC = 100_000_000;

type BalanceResult = {
  address: string;
  utxoCount: number;
  totalSat: number;
};

function compressedPubkeyToTaprootAddress(pubkeyHex: string): string {
  if (!isValidCompressedPubkey(pubkeyHex)) {
    throw new Error('LP_PUBKEY_HEX must be a 33-byte compressed public key (hex)');
  }

  const network = getNetwork();
  const pubkey = Buffer.from(pubkeyHex, 'hex');
  const xOnly = pubkey.subarray(1, 33);
  const payment = bitcoin.payments.p2tr({ internalPubkey: xOnly, network });

  if (!payment.address) {
    throw new Error('Failed to derive a taproot address from LP_PUBKEY_HEX');
  }

  return payment.address;
}

function deriveP2wpkhFromWIF(wif: string): { address: string; pubkeyHex: string } {
  const network = getNetwork();
  const keyPair = ECPair.fromWIF(wif, network);
  if (!keyPair.publicKey || keyPair.publicKey.length !== 33) {
    throw new Error('WIF must correspond to a compressed public key');
  }

  const payment = bitcoin.payments.p2wpkh({
    pubkey: keyPair.publicKey,
    network
  });

  if (!payment.address) {
    throw new Error('Failed to derive P2WPKH address from WIF');
  }

  return { address: payment.address, pubkeyHex: keyPair.publicKey.toString('hex') };
}

async function fetchBalance(address: string): Promise<BalanceResult> {
  const result = await rpc.scanTxOutSet(address);
  const unspents = (result.unspents || []) as Array<{ amount: number }>;

  const totalSat = unspents.reduce((acc, utxo) => {
    // RPC returns BTC values as floats; convert safely to sats
    return acc + Math.round(utxo.amount * SATS_PER_BTC);
  }, 0);

  return {
    address,
    utxoCount: unspents.length,
    totalSat
  };
}

function formatBtc(sats: number): string {
  return (sats / SATS_PER_BTC).toFixed(8);
}

async function main(): Promise<void> {
  console.log('🔎 Fetching balances...\n');
  console.log(`RPC: ${config.BITCOIN_RPC_URL}`);
  console.log(`Network: ${config.NETWORK}\n`);

  // Simple connectivity check to surface RPC issues early
  const tip = await rpc.getBlockCount();
  console.log(`Tip height: ${tip}\n`);

  // User (from WIF)
  const userKeys = deriveTaprootFromWIF(config.WIF);
  const userBalance = await fetchBalance(userKeys.taproot_address);
  const userP2wpkh = deriveP2wpkhFromWIF(config.WIF);
  const userP2wpkhBalance = await fetchBalance(userP2wpkh.address);

  console.log('User (from WIF)');
  console.log(`  taproot address: ${userKeys.taproot_address}`);
  console.log(`  pubkey (hex):    ${userKeys.pubkey_hex}`);
  console.log(
    `  balance:         ${userBalance.totalSat} sats (${formatBtc(userBalance.totalSat)} BTC)`
  );
  console.log(`  utxos:           ${userBalance.utxoCount}`);
  console.log(`  p2wpkh address:  ${userP2wpkh.address}`);
  console.log(
    `  p2wpkh balance:  ${userP2wpkhBalance.totalSat} sats (${formatBtc(userP2wpkhBalance.totalSat)} BTC)`
  );
  console.log(`  p2wpkh utxos:    ${userP2wpkhBalance.utxoCount}`);

  // LP (from LP_PUBKEY_HEX)
  if (!config.LP_PUBKEY_HEX) {
    console.warn('\nLP_PUBKEY_HEX is not set; skipping LP balance lookup.');
    return;
  }

  const lpAddress = compressedPubkeyToTaprootAddress(config.LP_PUBKEY_HEX);
  const lpBalance = await fetchBalance(lpAddress);
  console.log('\nLP (from LP_PUBKEY_HEX)');
  console.log(`  taproot address: ${lpAddress}`);
  console.log(`  pubkey (hex):    ${config.LP_PUBKEY_HEX}`);
  console.log(
    `  balance:         ${lpBalance.totalSat} sats (${formatBtc(lpBalance.totalSat)} BTC)`
  );
  console.log(`  utxos:           ${lpBalance.utxoCount}`);
}

main().catch((err) => {
  console.error('Error fetching balances:', err.message);
  process.exit(1);
});
