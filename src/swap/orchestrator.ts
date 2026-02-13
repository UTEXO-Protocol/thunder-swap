import { rlnClient } from '../rln/client.js';
import { rpc } from '../bitcoin/rpc.js';
import { waitForFunding, waitForTxConfirmation } from '../bitcoin/watch.js';
import { buildHtlcRedeemScript } from '../bitcoin/htlc.js';
import { claimWithPreimage } from '../bitcoin/claim.js';
import { buildRefundPsbtBase64 } from '../bitcoin/refund.js';
import { sendDepositTransaction } from '../bitcoin/deposit.js';
import { sha256hex, hexToBuffer } from '../utils/crypto.js';
import { randomBytes } from 'crypto';
import { getHodlRecord, persistHodlRecord } from '../utils/store.js';
import { config } from '../config.js';
import { deriveTaprootFromWIF } from '../bitcoin/keys.js';
import { getNetwork } from '../bitcoin/network.js';
import * as bitcoin from 'bitcoinjs-lib';
import {
  publishSubmarineRequest,
  publishFundingData,
  waitForRgbInvoiceHtlcResponse
} from '../utils/comm-server.js';
import { logStep } from '../utils/log.js';

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

interface DepositParams {
  amountSat: number;
  userRefundPubkeyHex: string;
}

interface DepositResult {
  payment_hash: string;
  preimage: string;
  payment_secret: string;
  invoice: string;
  amount_msat: number;
  expiry_sec: number;
  rgb_invoice: string;
  rgb_send?: {
    txid: string;
  };
  htlc_p2tr_address: string;
  htlc_p2tr_script_pubkey: string;
  htlc_p2tr_internal_key_hex?: string;
  t_lock?: number;
  deposit: {
    fee_sat: number;
    txid: string;
    psbt_base64: string;
    input_count: number;
    change_sat: number;
    change_address: string;
  };
  funding: {
    txid: string;
    vout: number;
    value: number;
  };
}

interface UserSettleParams {
  paymentHash: string;
  maxAttempts?: number;
  pollIntervalMs?: number;
}

interface UserSettleResult {
  payment_hash: string;
  settled: boolean;
  status: 'Pending' | 'Claimable' | 'Succeeded' | 'Cancelled' | 'Failed' | 'Timeout';
}

interface UserInvoiceStatusParams {
  invoice: string;
  maxAttempts?: number;
  pollIntervalMs?: number;
}

interface UserInvoiceStatusResult {
  status: 'Pending' | 'Succeeded' | 'Cancelled' | 'Failed' | 'Expired' | 'Timeout';
}

interface LpOperatorParams {
  invoice: string;
  fundingTxid: string;
  fundingVout: number;
  userRefundPubkeyHex: string;
  tLock?: number; // Optional if scriptPubKey is provided
  htlcScriptPubKeyHex?: string;
}

interface LpOperatorResult {
  payment_hash: string;
  status: 'Pending' | 'Claimable' | 'Succeeded' | 'Cancelled' | 'Failed' | 'Timeout';
  claim_txid?: string;
}

type RunDepositDeps = {
  rlnClient: typeof rlnClient;
  waitForFunding: typeof waitForFunding;
  waitForTxConfirmation: typeof waitForTxConfirmation;
  sendDeposit: typeof sendDepositTransaction;
  persistHodlRecord: typeof persistHodlRecord;
  config: typeof config;
  publishSubmarineRequest: typeof publishSubmarineRequest;
  waitForRgbInvoiceHtlcResponse: typeof waitForRgbInvoiceHtlcResponse;
  publishFundingData: typeof publishFundingData;
};

type RunUserSettleDeps = {
  rlnClient: typeof rlnClient;
  getHodlRecord: typeof getHodlRecord;
};

type RunLpOperatorDeps = {
  rlnClient: typeof rlnClient;
};

/**
 * User-side flow: create HODL invoice, build HTLC, wait for deposit.
 */
export async function runDeposit(
  { amountSat, userRefundPubkeyHex }: DepositParams,
  depsOverride: Partial<RunDepositDeps> = {}
): Promise<DepositResult> {
  const rln = depsOverride.rlnClient ?? rlnClient;
  const waitFunding = depsOverride.waitForFunding ?? waitForFunding;
  const waitTxConfirmation = depsOverride.waitForTxConfirmation ?? waitForTxConfirmation;
  const sendDeposit = depsOverride.sendDeposit ?? sendDepositTransaction;
  const persist = depsOverride.persistHodlRecord ?? persistHodlRecord;
  const cfg = depsOverride.config ?? config;
  const publishRequest = depsOverride.publishSubmarineRequest ?? publishSubmarineRequest;
  const waitRgbInvoice = depsOverride.waitForRgbInvoiceHtlcResponse ?? waitForRgbInvoiceHtlcResponse;
  const publishFunding = depsOverride.publishFundingData ?? publishFundingData;

  if (!Number.isFinite(amountSat) || amountSat <= 0) {
    throw new Error('amountSat must be a positive integer (sats)');
  }
  if (amountSat < 330) {
    throw new Error('amountSat must be at least 330 sats (P2TR dust limit)');
  }
  const expirySec = cfg.HODL_EXPIRY_SEC;

  // Ensure on-chain timelock safely outlasts the invoice expiry
  const BLOCK_TARGET_SEC = 600; // Approx 10 minutes per block
  const TIMECUSHION_SEC = 3600; // 1 hour buffer to broadcast and confirm claim
  const estimatedTimelockSec = cfg.LOCKTIME_BLOCKS * BLOCK_TARGET_SEC;
  if (estimatedTimelockSec <= expirySec + TIMECUSHION_SEC) {
    throw new Error(
      'LOCKTIME_BLOCKS is too low for HODL_EXPIRY_SEC. Increase LOCKTIME_BLOCKS or reduce HODL_EXPIRY_SEC.'
    );
  }

  // Step 1: Generate preimage/hash and create HODL invoice
  const preimage = randomBytes(32).toString('hex');
  const H = sha256hex(Buffer.from(preimage, 'hex'));
  const amountMsat = amountSat * 1000;

  logStep('\nStep 1: Creating HODL invoice...');
  const asset_amount = 1;
  const asset_id = process.env.ASSET_ID_L2;
  const invoiceResp = await rln.invoiceHodl({
    payment_hash: H,
    expiry_sec: expirySec,
    amt_msat: amountMsat,
    asset_id,
    asset_amount
  });

  console.log(`   Payment Hash (H): ${H}`);
  console.log(`   Amount: ${amountSat} sats`);
  console.log(`   RGB Asset ID: ${asset_id}`);
  console.log(`   RGB Asset Amount: ${asset_amount}`);
  console.log(`   Expiry: ${expirySec} seconds`);

  await persist({
    payment_hash: H,
    preimage,
    amount_msat: amountMsat,
    expiry_sec: expirySec,
    invoice: invoiceResp.invoice,
    payment_secret: invoiceResp.payment_secret,
    created_at: Date.now()
  });

  // Step 2: Publish HODL invoice to LP and wait for RGB HTLC invoice response
  logStep('\nStep 2: Publishing HODL invoice to LP...');
  publishRequest({ invoice: invoiceResp.invoice, userRefundPubkeyHex });
  console.log('   Waiting for RGB HTLC invoice from LP...');
  const rgbInvoiceResp = await waitRgbInvoice();

  if (!rgbInvoiceResp.htlc_p2tr_script_pubkey) {
    throw new Error('RLN did not return htlc_p2tr_script_pubkey');
  }
  const htlcScriptPubKeyHex = rgbInvoiceResp.htlc_p2tr_script_pubkey;
  const derivedAddress = bitcoin.address.fromOutputScript(
    Buffer.from(htlcScriptPubKeyHex, 'hex'),
    getNetwork()
  );
  if (
    rgbInvoiceResp.htlc_p2tr_address &&
    rgbInvoiceResp.htlc_p2tr_address !== derivedAddress
  ) {
    console.warn(
      `   WARNING: htlc_p2tr_address mismatch (server ${rgbInvoiceResp.htlc_p2tr_address} vs derived ${derivedAddress})`
    );
  }
  const htlcAddress = rgbInvoiceResp.htlc_p2tr_address ?? derivedAddress;

  const tLock = rgbInvoiceResp.t_lock;
  if (tLock == null) {
    console.warn('   WARNING: LP did not return t_lock in rgbinvoicehtlc response');
  }

  console.log(`   HTLC script pubkey: ${htlcScriptPubKeyHex}`);
  console.log(`   P2TR HTLC Address: ${htlcAddress}`);
  if (tLock != null) {
    console.log(`   Time lock block height: ${tLock}`);
  }

  // Step 3: Send deposit to HTLC address
  logStep('\nStep 3: Sending on-chain deposit...');
  const depositTx = await sendDeposit(htlcAddress, amountSat);
  console.log(`   Transaction ID: ${depositTx.txid}`);
  if (depositTx.fee_sat > 0) {
    console.log(`   Fee: ${depositTx.fee_sat} sats`);
  }
  if (depositTx.change_sat > 0) {
    console.log(`   Change: ${depositTx.change_sat} sats → ${depositTx.change_address}`);
  }

  // Step 4: Wait for funding transaction confirmation
  logStep('\nStep 4: Waiting for funding confirmation...');
  const funding = await waitFunding(htlcAddress, cfg.MIN_CONFS);
  console.log(`   Funding confirmed: ${funding.txid}:${funding.vout} (${funding.value} sats)`);

  // Step 5: Send RGB asset to HTLC via /sendasset (uses L1 backend)
  logStep('\nStep 5: Sending RGB asset via /sendasset...');
  const rgbSendResp = await rln.sendAsset(rgbInvoiceResp.invoice);
  console.log(
    `   Assign RGB asset txid: ${rgbSendResp.txid}`
  );

  // Step 6: Wait for RGB send confirmation, then refresh transfers (posts consignment)
  logStep('\nStep 6: Waiting for RGB send confirmation...');
  await waitTxConfirmation(rgbSendResp.txid, cfg.MIN_CONFS);
  logStep('\nStep 7: Refreshing RGB transfers (post consignment)...');
  await rln.refreshTransfers({ skip_sync: false });

  // Step 8: Publish funding data for LP
  logStep('\nStep 8: Publishing funding data to LP...');
  publishFunding({ fundingTxid: funding.txid, fundingVout: funding.vout });

  return {
    payment_hash: H,
    preimage,
    payment_secret: invoiceResp.payment_secret,
    invoice: invoiceResp.invoice,
    amount_msat: amountMsat,
    expiry_sec: expirySec,
    htlc_p2tr_address: htlcAddress,
    htlc_p2tr_script_pubkey: htlcScriptPubKeyHex,
    t_lock: tLock ?? undefined,
    rgb_invoice: rgbInvoiceResp.invoice,
    rgb_send: rgbSendResp,
    deposit: {
      fee_sat: depositTx.fee_sat,
      txid: depositTx.txid,
      psbt_base64: depositTx.psbt_base64,
      input_count: depositTx.input_count,
      change_sat: depositTx.change_sat,
      change_address: depositTx.change_address
    },
    funding
  };
}

/**
 * User-side flow: wait for claimable HTLC, then settle HODL invoice.
 */
export async function runUserSettleHodlInvoice(
  { paymentHash, maxAttempts = 120, pollIntervalMs = 5000 }: UserSettleParams,
  depsOverride: Partial<RunUserSettleDeps> = {}
): Promise<UserSettleResult> {
  const rln = depsOverride.rlnClient ?? rlnClient;
  const loadHodlRecord = depsOverride.getHodlRecord ?? getHodlRecord;

  const record = await loadHodlRecord(paymentHash);
  if (!record) {
    throw new Error(`No HODL record found for payment hash: ${paymentHash}`);
  }

  let status: UserSettleResult['status'] = 'Timeout';
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const paymentDetails = await rln.getPayment(paymentHash);
      if (!paymentDetails.payment.inbound) {
        throw new Error('Payment is outbound; check payment hash and role');
      }

      status = paymentDetails.payment.status as UserSettleResult['status'];
      console.log(`   Attempt ${attempt + 1}/${maxAttempts}: Status = ${status}`);

      if (
        status === 'Claimable' ||
        status === 'Succeeded' ||
        status === 'Cancelled' ||
        status === 'Failed'
      ) {
        break;
      }
    } catch (error: any) {
      console.log(`   Attempt ${attempt + 1} failed: ${error.message}`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  if (status === 'Cancelled' || status === 'Failed' || status === 'Timeout') {
    return { payment_hash: paymentHash, settled: false, status };
  }

  if (status === 'Succeeded') {
    return { payment_hash: paymentHash, settled: true, status };
  }

  if (status !== 'Claimable') {
    return { payment_hash: paymentHash, settled: false, status };
  }

  await rln.invoiceSettle({
    payment_hash: paymentHash,
    payment_preimage: record.preimage
  });

  return { payment_hash: paymentHash, settled: true, status: 'Succeeded' };
}

/**
 * User-side flow: poll invoice status after settlement until final.
 */
export async function runUserWaitInvoiceStatus(
  { invoice, maxAttempts = 120, pollIntervalMs = 5000 }: UserInvoiceStatusParams,
  depsOverride: Partial<RunUserSettleDeps> = {}
): Promise<UserInvoiceStatusResult> {
  const rln = depsOverride.rlnClient ?? rlnClient;

  let status: UserInvoiceStatusResult['status'] = 'Timeout';
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await rln.invoiceStatus({ invoice });
    status = response.status;
    console.log(`   Attempt ${attempt + 1}/${maxAttempts}: Status = ${status}`);

    if (
      status === 'Succeeded' ||
      status === 'Cancelled' ||
      status === 'Failed' ||
      status === 'Expired'
    ) {
      return { status };
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return { status };
}

/**
 * LP/operator-side flow: verify HTLC, pay invoice, wait for settlement, claim on-chain.
 */
export async function runLpOperatorFlow(
  { invoice, fundingTxid, fundingVout, userRefundPubkeyHex, tLock, htlcScriptPubKeyHex }: LpOperatorParams,
  depsOverride: Partial<RunLpOperatorDeps> = {}
): Promise<LpOperatorResult> {
  const rln = depsOverride.rlnClient ?? rlnClient;

  // Step 1: Decode invoice to get payment hash and amount.
  logStep('\nStep 1: Decoding HODL invoice...');
  const decoded = await rln.decode(invoice);
  const paymentHash = decoded.payment_hash;
  const amountMsat = decoded.amt_msat;
  if (amountMsat == null) {
    throw new Error('Decoded invoice missing amt_msat; cannot verify funding amount.');
  }
  const expiresAt = decoded.timestamp + decoded.expiry_sec;
  console.log(`   Decoded Invoice: ${JSON.stringify(decoded, null, 2)}`);
  console.log(`   Payment Hash (H): ${paymentHash}`);
  console.log(`   Amount: ${amountMsat} millisatoshis`);
  console.log(`   Expires: ${new Date(expiresAt * 1000).toISOString()}`);

  // Step 2: Verify HTLC funding output (P2TR).
  logStep('\nStep 2: Skipping client-side HTLC verification for now.'); // TODO call htcl scan to verify funding
  console.log(`   Funding Transaction: ${fundingTxid}:${fundingVout}`);
  if (htlcScriptPubKeyHex) {
    console.log(`   HTLC scriptPubKey: ${htlcScriptPubKeyHex}`);
  }

  // Step 3: Send payment.
  logStep('\nStep 3: Sending payment...');
  const payResult = await rln.pay(invoice);

  if (payResult.status === 'Failed') {
    return { payment_hash: paymentHash, status: 'Failed' };
  }

  // Step 4: Wait until payment is settled.
  logStep('\nStep 4: Waiting for payment settlement...');
  const maxAttempts = 120;
  let finalStatus: LpOperatorResult['status'] = 'Timeout';
  let preimage: string | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const paymentStatus = await rln.getPaymentPreimage(paymentHash);
    finalStatus = paymentStatus.status as LpOperatorResult['status'];
    console.log(`   Attempt ${attempt + 1}/${maxAttempts}: Status = ${finalStatus}`);

    if (finalStatus === 'Succeeded') {
      preimage = paymentStatus.preimage ?? undefined;
      if (preimage) {
        break;
      }
    } else if (finalStatus === 'Cancelled' || finalStatus === 'Failed') {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  if (finalStatus !== 'Succeeded') {
    return { payment_hash: paymentHash, status: finalStatus };
  }

  if (!preimage) {
    throw new Error('Payment succeeded but no preimage is available for on-chain claim');
  }
  console.log(`   Payment preimage: ${preimage}`);

  // Step 5: Scan HTLC funding and refresh RGB transfer state on RLN L1.
  logStep('\nStep 5: Scanning HTLC funding (confirm RGB transfer)...');
  await rln.htlcScan({ payment_hash: paymentHash });

  // Step 6: Request HTLC claim on RLN L1.
  logStep('\nStep 6: Requesting HTLC claim on RLN L1...');
  await rln.htlcClaim({ payment_hash: paymentHash, preimage });
  console.log('   HTLC claim requested (sweep will be broadcast by RLN).');
  return { payment_hash: paymentHash, status: 'Succeeded' };
}

/**
 * @deprecated Prefer runDeposit (user) + operator-side executor split flow.
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
    logStep('Step 1: Decoding RGB-LN invoice...');
    const decodedInvoice = await rlnClient.decode(invoice);
    // TODO: test data
    // const decodedInvoice = {
    //   payment_hash: 'f4d376425855e2354bf30e17904f4624f6f9aa297973cca0445cdf4cef718b2a',
    //   amt_msat: 3000000,
    //   expiry_sec: 420,
    //   timestamp: 1759931177
    // };
    const H = decodedInvoice.payment_hash;
    const amount_msat = decodedInvoice.amt_msat;
    if (amount_msat == null) {
      throw new Error('Decoded invoice missing amt_msat; cannot determine funding amount.');
    }
    const expires_at = decodedInvoice.timestamp + decodedInvoice.expiry_sec;

    console.log(`   Payment Hash (H): ${H}`);
    console.log(`   Amount: ${amount_msat} millisatoshis`);
    if (expires_at) {
      console.log(`   Expires: ${new Date(expires_at * 1000).toISOString()}`);
    }

    // Validate H format
    if (!H.match(/^[0-9a-fA-F]{64}$/)) {
      throw new Error('Invalid payment hash format from RGB-LN invoice');
    }

    // Step 2: Read tip height and set timeout block height
    logStep('\nStep 2: Setting timelock...');
    const tipHeight = await rpc.getBlockCount();
    const tLock = tipHeight + config.LOCKTIME_BLOCKS;
    console.log(`   Current block height: ${tipHeight}`);
    console.log(`   Time lock block height: ${tLock}`);

    // Security check: ensure invoice hasn't expired and we have enough time
    if (expires_at && expires_at <= Date.now() / 1000) {
      throw new Error('Invoice has expired');
    }

    // Step 3: Generate LP pubkey and claim address from role-based WIF
    const derived = deriveTaprootFromWIF(config.WIF);
    const lpPubkeyHex = derived.pubkey_hex;
    const lpClaimAddress = derived.taproot_address;
    console.log(`   LP Public Key: ${lpPubkeyHex}`);
    console.log(`   LP Claim Address (derived): ${lpClaimAddress}`);
    // const addr = bitcoin.payments.p2wpkh({ pubkey: keyPair2.publicKey, network }).address;
    // console.log({ wif, addr });

    // Step 4: Build HTLC redeem script and P2WSH address
    logStep('\nStep 4: Building HTLC...');
    const htlcResult = buildHtlcRedeemScript(H, lpPubkeyHex, userRefundPubkeyHex, tLock);
    console.log(`   P2WSH HTLC Address: ${htlcResult.p2wshAddress}`);
    console.log(`   Amount to fund: ${amount_msat} msats`);
    console.log(`   Redeem Script Hash: ${sha256hex(htlcResult.redeemScript)}`);

    // Step 5: Wait for funding transaction confirmation
    logStep('\nStep 5: Waiting for funding confirmation...');
    const funding = await waitForFunding(htlcResult.p2wshAddress, config.MIN_CONFS);
    console.log(`   Funding confirmed: ${funding.txid}:${funding.vout} (${funding.value} sats)`);

    // Step 6: Pay RGB-LN invoice
    logStep('\nStep 6: Paying HODL invoice...');
    const paymentResult = await rlnClient.pay(invoice);

    if (paymentResult.status === 'Pending') {
      console.log('   Payment initiated, status: Pending');
      console.log('   Polling for payment completion...');

      // Poll getPayment until status changes from Pending
      const maxAttempts = 60; // 5 minutes at 5 second intervals
      let finalStatus: 'Pending' | 'Claimable' | 'Succeeded' | 'Cancelled' | 'Failed' = 'Pending';
      let preimage: string | undefined;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const paymentStatus = await rlnClient.getPaymentPreimage(H);
          finalStatus = paymentStatus.status;

          console.log(`   Attempt ${attempt + 1}/${maxAttempts}: Status = ${finalStatus}`);

          if (finalStatus === 'Succeeded') {
            preimage = paymentStatus.preimage ?? undefined;
            if (preimage) {
              console.log(`   Payment succeeded! Preimage: ${preimage}`);
              break;
            }
          } else if (finalStatus === 'Cancelled' || finalStatus === 'Failed') {
            console.log('   Payment failed or cancelled');
            break;
          }

          // Wait 5 seconds before next attempt
          await new Promise((resolve) => setTimeout(resolve, 5000));
        } catch (error: any) {
          console.log(`   Attempt ${attempt + 1} failed: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }

      if (finalStatus === 'Succeeded' && preimage) {
        // Step 7: Verify preimage matches hash
        logStep('\nStep 7: Verifying preimage...');
        const preimageHash = sha256hex(hexToBuffer(preimage));
        if (preimageHash !== H) {
          throw new Error(`Preimage verification failed: ${preimageHash} !== ${H}`);
        }
        console.log(`   Preimage verified: ${preimage}`);

        // Step 8: Claim HTLC with preimage
        logStep('\nStep 8: Claiming HTLC...');
        const claimResult = await claimWithPreimage(
          { txid: funding.txid, vout: funding.vout, value: funding.value },
          htlcResult.redeemScript,
          preimage,
          config.WIF,
          lpClaimAddress
        );

        console.log(`   Claim transaction broadcast: ${claimResult.txid}`);
        return { success: true, txid: claimResult.txid };
      } else if (finalStatus === 'Failed') {
        // Step 8b: Payment failed - prepare refund PSBT
        logStep('\nStep 8b: Payment failed, preparing refund PSBT...');
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
        logStep('\nStep 8b: Payment timeout, preparing refund PSBT...');
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
      console.log('   Fetching preimage via getPaymentPreimage...');

      let preimage: string | undefined;
      try {
        const paymentDetails = await rlnClient.getPaymentPreimage(H);
        preimage = paymentDetails.preimage ?? undefined;

        if (!preimage) {
          return { success: false, error: 'Payment succeeded but no preimage available' };
        }
      } catch (error: any) {
        console.error(`   Failed to get preimage: ${error.message}`);
        return { success: false, error: `Failed to get preimage: ${error.message}` };
      }

      // Step 7: Verify preimage matches hash
      logStep('\nStep 7: Verifying preimage...');
      const preimageHash = sha256hex(hexToBuffer(preimage!));
      if (preimageHash !== H) {
        throw new Error(`Preimage verification failed: ${preimageHash} !== ${H}`);
      }
      console.log(`   Preimage verified: ${preimage}`);

      // Step 8: Claim HTLC with preimage
      logStep('\nStep 8: Claiming HTLC...');
      const claimResult = await claimWithPreimage(
        { txid: funding.txid, vout: funding.vout, value: funding.value },
        htlcResult.redeemScript,
        preimage,
        config.WIF,
        lpClaimAddress
      );

      console.log(`   Claim transaction broadcast: ${claimResult.txid}`);
      return { success: true, txid: claimResult.txid };
    } else {
      // Payment failed immediately
      logStep('\nStep 8b: Payment failed immediately, preparing refund PSBT...');
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
    console.error('   - Check WIF in environment');
    return { success: false, error: errorMsg };
  }
}
