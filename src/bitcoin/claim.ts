import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { rpc } from './rpc.js';
import { config } from '../config.js';
import { hexToBuffer, sha256hex } from '../utils/crypto.js';
import * as tinysecp from 'tiny-secp256k1';
import {
  Signer,
  SignerAsync,
  ECPairInterface,
  ECPairFactory,
  ECPairAPI,
  TinySecp256k1Interface
} from 'ecpair';

// Initialize ECC library for bitcoinjs-lib
bitcoin.initEccLib(ecc);
const btcnetwork = bitcoin.networks.testnet;

interface UTXO {
  txid: string;
  vout: number;
  value: number;
}

interface ClaimResult {
  txid: string;
  hex: string;
}

/**
 * Claim HTLC with preimage witness
 * Witness stack: [LP_sig, preimage, OP_TRUE, redeemScript]
 */
export async function claimWithPreimage(
  utxo: UTXO,
  redeemScript: Buffer,
  preimageHex: string,
  lpWif: string,
  lpClaimAddress: string
): Promise<ClaimResult> {
  // Validate inputs
  if (!preimageHex.match(/^[0-9a-fA-F]*$/) || preimageHex.length === 0) {
    throw new Error('Preimage must be valid hex');
  }

  const preimage = hexToBuffer(preimageHex);
  console.log('Preimage length:', preimage.length, 'bytes');
  console.log('Preimage hex:', Buffer.from(preimage).toString('hex'));

  // Validate preimage format
  if (preimage.length !== 32) {
    throw new Error(`Invalid preimage length: ${preimage.length} bytes, expected 32`);
  }

  const ECPair: ECPairAPI = ECPairFactory(tinysecp);
  // Parse WIF
  let lpKeyPair: ECPairInterface;
  try {
    lpKeyPair = ECPair.fromWIF(lpWif, btcnetwork);
    console.log('LP KeyPair created successfully');
    console.log('Public key:', Buffer.from(lpKeyPair.publicKey).toString('hex'));
  } catch (error) {
    throw new Error(`Invalid LP WIF: ${error}`);
  }

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

  // Create transaction manually for HTLC witness
  const tx = new bitcoin.Transaction();
  tx.version = 2;

  // Add input
  const txHash = Buffer.from(utxo.txid, 'hex').reverse();
  tx.addInput(txHash, utxo.vout, 0xffffffff);

  // Create output to our claim address
  const claimAddress = bitcoin.address.toOutputScript(lpClaimAddress, network);

  // Estimate fee
  const estimatedFee = 1000; // 1000 sats fee estimate
  const outputValue = utxo.value - estimatedFee;

  if (outputValue <= 1000) {
    throw new Error(
      `UTXO value too low: ${utxo.value} sats, need at least ${estimatedFee + 1000} sats`
    );
  }

  tx.addOutput(claimAddress, outputValue);

  // Create hash for signing
  const hashType = bitcoin.Transaction.SIGHASH_ALL;
  const signatureHash = tx.hashForWitnessV0(
    0, // input index
    redeemScript,
    utxo.value,
    hashType
  );

  // Sign with proper DER encoding
  const signature = lpKeyPair.sign(signatureHash);
  console.log('Signature length:', signature.length);
  console.log('Signature hex:', Buffer.from(signature).toString('hex'));

  // Validate DER signature format
  if (signature.length !== 71) {
    console.warn(`Warning: Signature length is ${signature.length}, expected 71 for DER format`);
  }

  // Check if signature starts with DER header (0x30)
  if (signature[0] !== 0x30) {
    console.warn('Warning: Signature does not start with DER header (0x30)');
  }

  // Ensure signature is DER-encoded (ECPair should do this automatically)

  const sigDerPlus = bitcoin.script.signature.encode(Buffer.from(signature), hashType);
  // const signatureWithHashType = Buffer.concat([signature, Buffer.from([hashType])]);
  console.log('Signature with hash type length:', sigDerPlus.length);

  // Build witness stack for HTLC claim: [LP_sig, preimage, OP_TRUE, redeemScript]
  const witness: Buffer[] = [
    sigDerPlus, // LP signature
    preimage, // Secret preimage
    Buffer.from([1]), // OP_TRUE for claiming path
    redeemScript // Full redeem script
  ];

  // Set witness on the transaction
  tx.setWitness(0, witness);

  // Serialize
  const rawTx = tx.toHex();

  // Broadcast transaction
  try {
    console.log('Sending raw transaction...', rawTx);
    const txid = await rpc.sendRawTransaction(rawTx);
    console.log(`Claim transaction broadcast: ${txid}`);

    return {
      txid,
      hex: rawTx
    };
  } catch (error) {
    throw new Error(`Failed to broadcast claim transaction: ${error}`);
  }
}
