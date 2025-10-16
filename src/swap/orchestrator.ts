import { rlnClient } from '../rln/client.js';
import { rpc } from '../bitcoin/rpc.js';
import { waitForFunding } from '../bitcoin/watch.js';
import { buildHtlcRedeemScript } from '../bitcoin/htlc.js';
import { claimWithPreimage } from '../bitcoin/claim.js';
import { buildRefundPsbtBase64 } from '../bitcoin/refund.js';
import { sha256hex, hexToBuffer } from '../utils/crypto.js';
import BIP32Factory from 'bip32';
import * as tools from 'uint8array-tools';
import * as ecc from 'tiny-secp256k1';
import { BIP32Interface } from 'bip32';

import { config } from '../config.js';
import * as bitcoin from 'bitcoinjs-lib';
import { Signer, SignerAsync, ECPairInterface, ECPairFactory, ECPairAPI, TinySecp256k1Interface } from 'ecpair';
import * as tinysecp from 'tiny-secp256k1';

// Initialize ECC library for bitcoinjs-lib
bitcoin.initEccLib(tinysecp);
const ECPair: ECPairAPI = ECPairFactory(tinysecp);



const network = bitcoin.networks.testnet;

interface SwapParams {
  invoice: string;
  userRefundPubkeyHex: string;
  userRefundAddress: string;
}

interface SwapResult {
  success: boolean;
  txid?: string;
  psbt?: string;
  instructions?: string;
  error?: string;
}

/**
 * Main swap orchestrator that handles the complete submarine swap flow
 */
export async function runSwap({
  invoice,
  userRefundPubkeyHex,
  userRefundAddress
}: SwapParams): Promise<SwapResult> {
  try {
    console.log('Starting RGB-LN submarine swap...\n');

    // Step 1: Decode RGB-LN invoice to get payment hash and amount
    console.log('Step 1: Decoding RGB-LN invoice...');
    const decodedInvoice = await rlnClient.decode(invoice);
     // TODO: test data
    // const decodedInvoice = {
    //   payment_hash: 'f4d376425855e2354bf30e17904f4624f6f9aa297973cca0445cdf4cef718b2a',
    //   amt_msat: 3000000,
    //   expires_at: 1759931597
    // };
    const H = decodedInvoice.payment_hash;
    const amount_sat = decodedInvoice.amt_msat;
    const expires_at = decodedInvoice.expires_at;

    console.log(`   Payment Hash (H): ${H}`);
    console.log(`   Amount: ${amount_sat} sats`);
    if (expires_at) {
      console.log(`   Expires: ${new Date(expires_at * 1000).toISOString()}`);
    }

    // Validate H format
    if (!H.match(/^[0-9a-fA-F]{64}$/)) {
      throw new Error('Invalid payment hash format from RGB-LN invoice');
    }

    // Step 2: Read tip height and set timeout block height
    console.log('\nStep 2: Setting timelock...');
    const tipHeight = await rpc.getBlockCount();
    const tLock = tipHeight + config.LOCKTIME_BLOCKS;
    console.log(`   Current block height: ${tipHeight}`);
    console.log(`   Time lock block height: ${tLock}`);

    // Security check: ensure invoice hasn't expired and we have enough time
    if (expires_at && expires_at <= Date.now() / 1000) {
      throw new Error('Invoice has expired');
    }

    // Step 3: Generate LP pubkey from WIF
    // console.log('\nStep 3: Preparing LP keys...');
    // let lpKeyPair: ECPairInterface;
    // try {
    //   lpKeyPair = ECPair.fromWIF(config.LP_WIF);
    // } catch (error) {
    //   throw new Error(`Invalid LP WIF: ${error}`);
    // }
    // const lpPubkeyHex = tools.toHex(lpKeyPair.publicKey);
    // console.log(`   LP Public Key: ${lpPubkeyHex}`);  
    // const network = bitcoin.networks.testnet;

    // 1) Your account xprv/tprv from listdescriptors(true)
   
    
    // 2) Derive to the exact path (example: m/84'/1'/0'/0/1 for your addr)
    const CHAIN = 0;   // 0 = external, 1 = change
    const INDEX = 1;
    const bip32 = BIP32Factory(ecc);

    const node = bip32.fromBase58(config.LP_ACCOUNT_XPRV, network);
    // const child = node.derive(CHAIN).derive(INDEX);

    const child = node.derivePath(`m/84'/1'/0'/0/${INDEX}`);
    console.log('node.derive(CHAIN).derive(INDEX);',tools.toHex(child.publicKey))
    if (!child.privateKey) throw new Error("No private key (did you use tpub instead of tprv?)");
    
    // 3) Build ECPair from the raw 32-byte private key
    console.log(network)
    const keyPair2 = ECPair.fromPrivateKey(child.privateKey, { network, compressed: true });
    
    // Optional: WIF / address check
    const LP_WIF = keyPair2.toWIF();
    // Step 3: Generate LP pubkey from WIF
    let lpKeyPair: ECPairInterface;
    try {
      lpKeyPair = ECPair.fromWIF(LP_WIF,network);
    } catch (error) {
      throw new Error(`Invalid LP WIF: ${error}`);
    }
    const lpPubkeyHex = tools.toHex(lpKeyPair.publicKey);
    console.log(`   LP Public Key: ${lpPubkeyHex}`);  
    // const addr = bitcoin.payments.p2wpkh({ pubkey: keyPair2.publicKey, network }).address;
    // console.log({ wif, addr });

    // Step 4: Build HTLC redeem script and P2WSH address
    console.log('\nStep 4: Building HTLC...');
    const htlcResult = buildHtlcRedeemScript(H, lpPubkeyHex, userRefundPubkeyHex, tLock);
    console.log(`   P2WSH HTLC Address: ${htlcResult.p2wshAddress}`);
    console.log(`   Amount to fund: ${amount_sat} sats`);
    console.log(`   Redeem Script Hash: ${sha256hex(htlcResult.redeemScript)}`);

    
    // Step 5: Wait for funding transaction confirmation
    console.log('\nStep 5: Waiting for funding confirmation...');
    const funding = await waitForFunding(htlcResult.p2wshAddress, config.MIN_CONFS);
    console.log(`   Funding confirmed: ${funding.txid}:${funding.vout} (${funding.value} sats)`);

    // Step 6: Pay RGB-LN invoice
    console.log('\nStep 6: Paying RGB-LN invoice...');
    const paymentResult = await rlnClient.pay(invoice);
     // TODO: test data
    // const paymentResult = { status: 'Succeeded' };

    if (paymentResult.status === 'Pending') {
      console.log('   Payment initiated, status: Pending');
      console.log('   Polling for payment completion...');
      
      // Poll getPayment until status changes from Pending
      const maxAttempts = 60; // 5 minutes at 5 second intervals
      let finalStatus = 'pending';
      let preimage: string | undefined;
      
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const paymentDetails = await rlnClient.getPayment(H);
          finalStatus = paymentDetails.payment.status;
          
          console.log(`   Attempt ${attempt + 1}/${maxAttempts}: Status = ${finalStatus}`);
          
          if (finalStatus === 'Succeeded') {
            preimage = paymentDetails.payment.preimage;
            console.log(`   Payment succeeded! Preimage: ${preimage}`);
            break;
          } else if (finalStatus === 'Failed') {
            console.log('   Payment failed');
            break;
          }
          
          // Wait 5 seconds before next attempt
          await new Promise(resolve => setTimeout(resolve, 5000));
        } catch (error: any) {
          console.log(`   Attempt ${attempt + 1} failed: ${error.message}`);
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
      
      if (finalStatus === 'Succeeded' && preimage) {
        // Step 7: Verify preimage matches hash
        console.log('\nStep 7: Verifying preimage...');
        const preimageHash = sha256hex(hexToBuffer(preimage));
        if (preimageHash !== H) {
          throw new Error(`Preimage verification failed: ${preimageHash} !== ${H}`);
        }
        console.log(`   Preimage verified: ${preimage}`);

        // Step 8: Claim HTLC with preimage
        console.log('\nStep 8: Claiming HTLC...');
        const claimResult = await claimWithPreimage(
          { txid: funding.txid, vout: funding.vout, value: funding.value },
          htlcResult.redeemScript,
          preimage,
          LP_WIF,
          config.LP_CLAIM_ADDRESS
        );

        console.log(`   Claim transaction broadcast: ${claimResult.txid}`);
        return { success: true, txid: claimResult.txid };
        
      } else if (finalStatus === 'Failed') {
        // Step 8b: Payment failed - prepare refund PSBT
        console.log('\nStep 8b: Payment failed, preparing refund PSBT...');
        const refundResult = await buildRefundPsbtBase64(
          { txid: funding.txid, vout: funding.vout, value: funding.value },
          htlcResult.redeemScript,
          userRefundAddress,
          tLock
        );

        console.log(`   Refund PSBT prepared (base64): ${refundResult.psbtBase64}`);
        console.log('   Instructions:');
        console.log(refundResult.instructions);

        return {
          success: false,
          psbt: refundResult.psbtBase64,
          instructions: refundResult.instructions
        };
      } else {
        // Timeout
        console.log('\nStep 8b: Payment timeout, preparing refund PSBT...');
        const refundResult = await buildRefundPsbtBase64(
          { txid: funding.txid, vout: funding.vout, value: funding.value },
          htlcResult.redeemScript,
          userRefundAddress,
          tLock
        );

        console.log(`   Refund PSBT prepared (base64): ${refundResult.psbtBase64}`);
        console.log('   Instructions:');
        console.log(refundResult.instructions);

        return {
          success: false,
          psbt: refundResult.psbtBase64,
          instructions: refundResult.instructions
        };
      }
      
    } else if (paymentResult.status === 'Succeeded') {
      // Handle immediate success (fallback for older implementations)
      console.log('   Payment succeeded immediately');
      console.log('   Fetching preimage via getPayment...');
      
      let preimage: string | undefined;
      try {
        const paymentDetails = await rlnClient.getPayment(H);
        preimage = paymentDetails.payment.preimage;
        // TODO: test data
        // preimage = '86a85cd1cb86c51186d190972c9f8413f436911fc0de241b6df20877ebbadecc';
        
        if (!preimage) {
          return { success: false, error: 'Payment succeeded but no preimage available' };
        }
      } catch (error: any) {
        console.error(`   Failed to get preimage: ${error.message}`);
        return { success: false, error: `Failed to get preimage: ${error.message}` };
      }

      // Step 7: Verify preimage matches hash
      console.log('\nStep 7: Verifying preimage...');
      const preimageHash = sha256hex(hexToBuffer(preimage!));
      if (preimageHash !== H) {
        throw new Error(`Preimage verification failed: ${preimageHash} !== ${H}`);
      }
      console.log(`   Preimage verified: ${preimage}`);

      // Step 8: Claim HTLC with preimage
      console.log('\nStep 8: Claiming HTLC...');
      const claimResult = await claimWithPreimage(
        { txid: funding.txid, vout: funding.vout, value: funding.value },
        htlcResult.redeemScript,
        preimage,
        LP_WIF,
        config.LP_CLAIM_ADDRESS
      );

      console.log(`   Claim transaction broadcast: ${claimResult.txid}`);
      return { success: true, txid: claimResult.txid };
      
    } else {
      // Payment failed immediately
      console.log('\nStep 8b: Payment failed immediately, preparing refund PSBT...');
      const refundResult = await buildRefundPsbtBase64(
        { txid: funding.txid, vout: funding.vout, value: funding.value },
        htlcResult.redeemScript,
        userRefundAddress,
        tLock
      );

      console.log(`   Refund PSBT prepared (base64): ${refundResult.psbtBase64}`);
      console.log('   Instructions:');
      console.log(refundResult.instructions);

      return {
        success: false,
        psbt: refundResult.psbtBase64,
        instructions: refundResult.instructions
      };
    }

  } catch (error: any) {
    const errorMsg = error.message || String(error);
    console.error(`Swap failed: ${errorMsg}`);
    console.error('\nTroubleshooting:');
    console.error('   - Check NETWORK setting matches your Bitcoin node');
    console.error('   - Verify RLN node is running and API accessible');
    console.error('   - Ensure funding transaction was sent to the correct HTLC address');
    console.error('   - Check LP_WIF and LP_CLAIM_ADDRESS in environment');
    return { success: false, error: errorMsg };
  }
}
