import { rpc } from './rpc.js';
import { config } from '../config.js';
import * as bitcoin from 'bitcoinjs-lib';
import * as tinysecp from 'tiny-secp256k1';
import { ECPairFactory, ECPairAPI } from 'ecpair';
import { getNetwork } from './network.js';
import { DUST_LIMIT_SAT, SpendableUtxo, btcToSat, selectUtxosP2TR } from './utxo_utils.js';

bitcoin.initEccLib(tinysecp);
const ECPair: ECPairAPI = ECPairFactory(tinysecp);

export interface DepositSendResult {
  txid: string;
  hex: string;
  psbt_base64: string;
  fee_sat: number;
  input_count: number;
  change_sat: number;
  change_address: string;
}

async function fetchUtxosForAddress(address: string): Promise<SpendableUtxo[]> {
  const result = await rpc.scanTxOutSet(address);
  const unspents = (result.unspents || []) as Array<{
    txid: string;
    vout: number;
    amount: number;
    scriptPubKey: string;
  }>;

  return unspents.map((utxo) => ({
    txid: utxo.txid,
    vout: utxo.vout,
    valueSat: btcToSat(utxo.amount),
    scriptHex: utxo.scriptPubKey,
    script_pubkey_hex: utxo.scriptPubKey
  }));
}

export async function sendDepositTransaction(
  address: string,
  amountSat: number
): Promise<DepositSendResult> {
  // Enforced PSBT flow:
  // 1) Derive taproot address from WIF and select spendable UTXOs.
  // 2) Build an unsigned P2TR PSBT (inputs + HTLC output + change).
  // 3) Use WIF to sign the PSBT locally.
  // 4) Finalize the PSBT into a raw transaction.
  // 5) Broadcast the transaction to the network.
  if (!address || !address.trim()) {
    throw new Error('address must be a non-empty string');
  }
  if (!Number.isInteger(amountSat) || amountSat <= 0) {
    throw new Error('amountSat must be a positive integer');
  }
  if (!config.WIF) {
    throw new Error('WIF is required for local funding');
  }

  const network = getNetwork();
  const keyPair = ECPair.fromWIF(config.WIF, network);
  if (keyPair.publicKey.length !== 33) {
    throw new Error('WIF must correspond to a compressed public key for Taproot');
  }

  const xOnlyPubkey = keyPair.publicKey.subarray(1, 33);
  const userPayment = bitcoin.payments.p2tr({ internalPubkey: xOnlyPubkey, network });
  if (!userPayment.address || !userPayment.output) {
    throw new Error('Failed to derive a taproot address from WIF');
  }

  const expectedScriptPubkey = userPayment.output.toString('hex');
  const utxos = (await fetchUtxosForAddress(userPayment.address)).filter(
    (utxo): utxo is SpendableUtxo & { script_pubkey_hex: string } =>
      utxo.script_pubkey_hex !== undefined &&
      utxo.script_pubkey_hex.toLowerCase() === expectedScriptPubkey.toLowerCase()
  );

  if (utxos.length === 0) {
    throw new Error('No UTXOs found for the taproot address derived from WIF');
  }

  const selection = selectUtxosP2TR(utxos, amountSat);

  const psbt = new bitcoin.Psbt({ network });
  for (const utxo of selection.selected) {
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: userPayment.output,
        value: utxo.valueSat
      },
      tapInternalKey: xOnlyPubkey
    });
  }

  psbt.addOutput({ address, value: amountSat });
  if (selection.changeSat >= DUST_LIMIT_SAT) {
    psbt.addOutput({ address: userPayment.address, value: selection.changeSat });
  }

  // Taproot key-path signing requires a tweaked signer so that the public key
  // matches the output key in the witness UTXO (BIP341 key tweak).
  const tapTweakHash = bitcoin.crypto.taggedHash('TapTweak', xOnlyPubkey);
  const tweakedSigner = keyPair.tweak(tapTweakHash);

  const unsignedPsbtBase64 = psbt.toBase64();
  psbt.signAllInputs(tweakedSigner);
  psbt.finalizeAllInputs();

  const tx = psbt.extractTransaction();
  const hex = tx.toHex();
  const txid = tx.getId();

  await rpc.sendRawTransaction(hex);

  return {
    txid,
    hex,
    psbt_base64: unsignedPsbtBase64,
    fee_sat: selection.feeSat,
    input_count: selection.selected.length,
    change_sat: selection.changeSat,
    change_address: userPayment.address
  };
}
