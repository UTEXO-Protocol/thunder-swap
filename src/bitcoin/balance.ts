#!/usr/bin/env node
import * as bitcoin from 'bitcoinjs-lib';
import * as tinysecp from 'tiny-secp256k1';
import { ECPairFactory, ECPairAPI } from 'ecpair';
import { config } from '../config.js';
import { deriveTaprootFromWIF } from './keys.js';
import { rpc } from './rpc.js';
import { getNetwork } from './network.js';
import { isValidCompressedPubkey } from '../utils/crypto.js';
import {
  DUST_LIMIT_SAT,
  DUST_LIMIT_P2WPKH_SAT,
  SATS_PER_BTC,
  SpendableUtxo,
  selectUtxosP2TR,
  selectUtxosP2WPKH
} from './utxo_utils.js';
import fs from 'node:fs';
import dotenv from 'dotenv';

bitcoin.initEccLib(tinysecp);
const ECPair: ECPairAPI = ECPairFactory(tinysecp);

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

async function fetchUtxos(address: string): Promise<SpendableUtxo[]> {
  const result = await rpc.scanTxOutSet(address);
  const unspents = (result.unspents || []) as Array<{
    txid: string;
    vout: number;
    amount: number;
    scriptPubKey: string;
  }>;

  return unspents.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    valueSat: Math.round(u.amount * SATS_PER_BTC),
    scriptHex: u.scriptPubKey
  }));
}

function parseLpWif(): string {
  if (process.env.LP_WIF) {
    return process.env.LP_WIF;
  }

  try {
    const envPath = '.env.lp';
    if (fs.existsSync(envPath)) {
      const parsed = dotenv.parse(fs.readFileSync(envPath));
      if (parsed.LP_WIF) return parsed.LP_WIF;
      if (parsed.WIF) return parsed.WIF; // fallback to generic key name
    }
  } catch {
    // fallthrough
  }

  throw new Error('LP WIF not found. Set LP_WIF in environment or .env.lp');
}

async function sendFromTaproot(wif: string, toAddress: string, amountSat: number): Promise<string> {
  const network = getNetwork();
  const keyPair = ECPair.fromWIF(wif, network);
  if (keyPair.publicKey.length !== 33) {
    throw new Error('Taproot requires compressed public key');
  }
  const xOnly = keyPair.publicKey.subarray(1, 33);
  const fromPay = bitcoin.payments.p2tr({ internalPubkey: xOnly, network });
  if (!fromPay.address || !fromPay.output) {
    throw new Error('Failed to derive Taproot address');
  }

  const utxos = (await fetchUtxos(fromPay.address)).filter(
    (u): u is SpendableUtxo & { scriptHex: string } =>
      u.scriptHex !== undefined &&
      u.scriptHex.toLowerCase() === fromPay.output!.toString('hex').toLowerCase()
  );
  if (utxos.length === 0) {
    throw new Error('No Taproot UTXOs available');
  }

  const selection = selectUtxosP2TR(utxos, amountSat);

  const psbt = new bitcoin.Psbt({ network });
  for (const u of selection.selected) {
    psbt.addInput({
      hash: u.txid,
      index: u.vout,
      witnessUtxo: { script: fromPay.output, value: u.valueSat },
      tapInternalKey: xOnly
    });
  }
  psbt.addOutput({ address: toAddress, value: amountSat });
  if (selection.changeSat >= DUST_LIMIT_SAT) {
    psbt.addOutput({ address: fromPay.address, value: selection.changeSat });
  }

  const tapTweakHash = bitcoin.crypto.taggedHash('TapTweak', xOnly);
  const tweakedSigner = keyPair.tweak(tapTweakHash);

  psbt.signAllInputs(tweakedSigner);
  psbt.finalizeAllInputs();
  const tx = psbt.extractTransaction();
  const txid = tx.getId();
  await rpc.sendRawTransaction(tx.toHex());
  return txid;
}

async function sendFromP2wpkh(wif: string, toAddress: string, amountSat: number): Promise<string> {
  const network = getNetwork();
  const keyPair = ECPair.fromWIF(wif, network);
  if (!keyPair.publicKey || keyPair.publicKey.length !== 33) {
    throw new Error('WIF must correspond to compressed pubkey');
  }
  const fromPay = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network });
  if (!fromPay.address || !fromPay.output) {
    throw new Error('Failed to derive P2WPKH address');
  }

  const utxos = (await fetchUtxos(fromPay.address)).filter(
    (u): u is SpendableUtxo & { scriptHex: string } =>
      u.scriptHex !== undefined &&
      u.scriptHex.toLowerCase() === fromPay.output!.toString('hex').toLowerCase()
  );
  if (utxos.length === 0) {
    throw new Error('No P2WPKH UTXOs available');
  }

  const selection = selectUtxosP2WPKH(utxos, amountSat);

  const psbt = new bitcoin.Psbt({ network });
  for (const u of selection.selected) {
    psbt.addInput({
      hash: u.txid,
      index: u.vout,
      witnessUtxo: { script: fromPay.output, value: u.valueSat }
    });
  }
  psbt.addOutput({ address: toAddress, value: amountSat });
  if (selection.changeSat >= DUST_LIMIT_P2WPKH_SAT) {
    psbt.addOutput({ address: fromPay.address, value: selection.changeSat });
  }

  psbt.signAllInputs(keyPair);
  psbt.finalizeAllInputs();
  const tx = psbt.extractTransaction();
  const txid = tx.getId();
  await rpc.sendRawTransaction(tx.toHex());
  return txid;
}

async function sendFunds(sender: 'user' | 'lp', toAddress: string, amountSat: number) {
  const wif = sender === 'user' ? config.WIF : parseLpWif();
  // Try Taproot first, fall back to P2WPKH
  try {
    const txid = await sendFromTaproot(wif, toAddress, amountSat);
    console.log(`Sent via Taproot. txid=${txid}`);
    return;
  } catch (err: any) {
    console.warn(`Taproot send failed (${err.message}). Trying P2WPKH...`);
  }

  const txid = await sendFromP2wpkh(wif, toAddress, amountSat);
  console.log(`Sent via P2WPKH. txid=${txid}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // sendbtc <lp|user> <address> <amountSat>
  if (args[0] === 'sendbtc') {
    if (args.length < 4) {
      console.error('Usage: npm run balance -- sendbtc <lp|user> <toAddress> <amountSat>');
      process.exit(1);
    }
    const sender = args[1] as 'lp' | 'user';
    const toAddress = args[2];
    const amountSat = parseInt(args[3], 10);
    if (sender !== 'lp' && sender !== 'user') {
      throw new Error('Sender must be "lp" or "user"');
    }
    if (!Number.isInteger(amountSat) || amountSat <= 0) {
      throw new Error('amountSat must be a positive integer');
    }

    console.log(`RPC: ${config.BITCOIN_RPC_URL}`);
    console.log(`Network: ${config.NETWORK}`);
    console.log(`Tip: ${await rpc.getBlockCount()}`);
    console.log(`Sending ${amountSat} sats from ${sender} to ${toAddress}...`);
    await sendFunds(sender, toAddress, amountSat);
    return;
  }

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
