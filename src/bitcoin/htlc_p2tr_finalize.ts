import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory, ECPairAPI, ECPairInterface } from 'ecpair';
import * as varuint from 'varuint-bitcoin';
import { rpc } from './rpc.js';
import { config } from '../config.js';
import { getNetwork } from './network.js';
import { deriveTaprootFromWIF } from './keys.js';
import {
  buildClaimTapscript,
  buildRefundTapscript,
  deriveDeterministicInternalKey,
  reconstructP2TRScriptPubKey
} from './htlc_p2tr.js';
import type { Taptree } from './htlc_p2tr.js';
import { assertValidPaymentHash, hexToBuffer, sha256hex } from '../utils/crypto.js';
import { DUST_LIMIT_SAT, P2TR_OUTPUT_VBYTES, TX_OVERHEAD_VBYTES } from './utxo_utils.js';

bitcoin.initEccLib(ecc);
const ECPair: ECPairAPI = ECPairFactory(ecc);

const TAPLEAF_VERSION = 0xc0;

export interface htlcP2trUtxo {
  txid: string;
  vout: number;
  value: number;
}

export interface ClaimP2TRResult {
  txid: string;
  hex: string;
  lp_address: string;
  fee_sat: number;
}

export interface RefundP2TRResult {
  psbt_base64: string;
  instructions: string;
}

function assertValidPreimage(preimageHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(preimageHex)) {
    throw new Error('Preimage must be a 32-byte hex string');
  }

  return hexToBuffer(preimageHex);
}

function estimateClaimFeeSat(feeRateSatPerVb: number): number {
  const estimatedInputVbytes = 120;
  const vbytes = TX_OVERHEAD_VBYTES + estimatedInputVbytes + P2TR_OUTPUT_VBYTES;
  return Math.max(1000, Math.ceil(vbytes * feeRateSatPerVb));
}

function witnessStackToScriptWitness(witnessStack: Buffer[]): Buffer {
  const buffers: Buffer[] = [];
  buffers.push(Buffer.from(varuint.encode(witnessStack.length)));

  for (const item of witnessStack) {
    buffers.push(Buffer.from(varuint.encode(item.length)));
    buffers.push(item);
  }

  return Buffer.concat(buffers);
}

function buildControlBlock(
  internalKey: Buffer,
  claimScript: Buffer,
  refundScript: Buffer,
  network: bitcoin.Network
): Buffer {
  const scriptTree: Taptree = [
    { output: claimScript, version: TAPLEAF_VERSION },
    { output: refundScript, version: TAPLEAF_VERSION }
  ];

  const p2tr = bitcoin.payments.p2tr({
    internalPubkey: internalKey,
    scriptTree,
    redeem: { output: claimScript },
    network
  });

  const witness = p2tr.witness;
  if (!witness || witness.length < 2) {
    throw new Error('Failed to derive control block for claim tapscript');
  }

  return Buffer.from(witness[witness.length - 1]);
}

function buildTaprootSigner(
  lpKeyPair: ECPairInterface & { signSchnorr?: (hash: Buffer) => Buffer },
  xOnlyPubkey: Buffer
) {
  if (typeof lpKeyPair.signSchnorr !== 'function') {
    throw new Error('LP key does not support Schnorr signing for Taproot');
  }

  return {
    publicKey: xOnlyPubkey,
    signSchnorr: (hash: Buffer) => lpKeyPair.signSchnorr!(hash)
  };
}

/**
 * Claim a P2TR HTLC output using the claim tapscript (preimage + LP signature).
 */
export async function claimP2trHtlc(
  utxo: htlcP2trUtxo,
  paymentHashHex: string,
  preimageHex: string,
  lpWif: string,
  userRefundPubkeyHex: string,
  tLock: number
): Promise<ClaimP2TRResult> {
  assertValidPaymentHash(paymentHashHex);
  const preimage = assertValidPreimage(preimageHex);
  const derivedHash = sha256hex(preimage);
  if (derivedHash.toLowerCase() !== paymentHashHex.toLowerCase()) {
    throw new Error('Preimage does not match payment hash');
  }

  if (!lpWif || !lpWif.trim()) {
    throw new Error('LP WIF is required to sign the claim transaction');
  }

  const network = getNetwork();
  const lpKeyPair = ECPair.fromWIF(lpWif, network);
  const derived = deriveTaprootFromWIF(lpWif);
  const lpPubkeyHex = derived.pubkey_hex;
  const lpXOnlyPubkey = Buffer.from(derived.x_only_pubkey_hex, 'hex');

  const claimScript = buildClaimTapscript(paymentHashHex, lpPubkeyHex);
  const refundScript = buildRefundTapscript(tLock, userRefundPubkeyHex);
  const internalKey = deriveDeterministicInternalKey();
  const controlBlock = buildControlBlock(internalKey, claimScript, refundScript, network);
  const expectedScriptPubkey = reconstructP2TRScriptPubKey({
    payment_hash: paymentHashHex,
    lp_pubkey: lpPubkeyHex,
    user_pubkey: userRefundPubkeyHex,
    cltv_expiry: tLock
  });

  const feeSat = estimateClaimFeeSat(config.FEE_RATE_SAT_PER_VB);
  const outputValue = utxo.value - feeSat;
  if (outputValue < DUST_LIMIT_SAT) {
    throw new Error(`UTXO value too low after fee: ${utxo.value} sats, fee ${feeSat} sats`);
  }

  const psbt = new bitcoin.Psbt({ network });
  psbt.addInput({
    hash: utxo.txid,
    index: utxo.vout,
    witnessUtxo: {
      script: expectedScriptPubkey,
      value: utxo.value
    },
    tapLeafScript: [
      {
        leafVersion: TAPLEAF_VERSION,
        script: claimScript,
        controlBlock
      }
    ]
  });

  psbt.addOutput({
    address: derived.taproot_address,
    value: outputValue
  });

  const taprootSigner = buildTaprootSigner(lpKeyPair, lpXOnlyPubkey);
  psbt.signInput(0, taprootSigner as any);

  psbt.finalizeInput(0, (_index: any, input: any) => {
    const tapScriptSig = (input as any).tapScriptSig?.[0];
    if (!tapScriptSig) {
      throw new Error('Missing taproot script signature for claim input');
    }

    const witnessStack = [Buffer.from(tapScriptSig.signature), preimage, claimScript, controlBlock];
    const finalScriptWitness = witnessStackToScriptWitness(witnessStack);
    return { finalScriptWitness };
  });

  const tx = psbt.extractTransaction();
  const hex = tx.toHex();
  const txid = tx.getId();

  await rpc.sendRawTransaction(hex);

  return {
    txid,
    hex,
    lp_address: derived.taproot_address,
    fee_sat: feeSat
  };
}

/**
 * Refund PSBT skeleton for the user to sign after timelock expiry.
 * This is a placeholder for the P2TR script-path refund implementation.
 */
export async function refundP2trHtlc(
  utxo: htlcP2trUtxo,
  paymentHashHex: string,
  userRefundPubkeyHex: string,
  tLock: number
): Promise<RefundP2TRResult> {
  void utxo;
  void paymentHashHex;
  void userRefundPubkeyHex;
  void tLock;

  return {
    psbt_base64: '',
    instructions:
      'TODO: build P2TR refund PSBT (script-path) for user signing after timelock expiry.'
  };
}
