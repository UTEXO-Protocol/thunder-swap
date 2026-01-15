import { rlnClient } from '../rln/client.js';
import { rpc } from '../bitcoin/rpc.js';
import { waitForFunding } from '../bitcoin/watch.js';
import { buildHtlcRedeemScript } from '../bitcoin/htlc.js';
import { buildP2TRHTLC } from '../bitcoin/htlc_p2tr.js';
import { claimWithPreimage } from '../bitcoin/claim.js';
import { claimP2trHtlc } from '../bitcoin/htlc_p2tr_finalize.js';
import { buildRefundPsbtBase64 } from '../bitcoin/refund.js';
import { sendDepositTransaction } from '../bitcoin/deposit.js';
import { verifyFundingTransaction } from '../bitcoin/verify_p2tr.js';
import { sha256hex, hexToBuffer } from '../utils/crypto.js';
import { randomBytes } from 'crypto';
import { getHodlRecord, persistHodlRecord } from '../utils/store.js';
import { config } from '../config.js';
import { deriveTaprootFromWIF } from '../bitcoin/keys.js';

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
  htlc_p2tr_address: string;
  htlc_p2tr_internal_key_hex: string;
  t_lock: number;
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

interface LpOperatorParams {
  invoice: string;
  fundingTxid: string;
  fundingVout: number;
  userRefundPubkeyHex: string;
  tLock: number; // Timelock block height (must match USER's HTLC construction)
}

interface LpOperatorResult {
  payment_hash: string;
  status: 'Pending' | 'Claimable' | 'Succeeded' | 'Cancelled' | 'Failed' | 'Timeout';
  claim_txid?: string;
}

type RunDepositDeps = {
  rlnClient: typeof rlnClient;
  rpc: typeof rpc;
  waitForFunding: typeof waitForFunding;
  buildP2TRHTLC: typeof buildP2TRHTLC;
  sendDeposit: typeof sendDepositTransaction;
  persistHodlRecord: typeof persistHodlRecord;
  config: typeof config;
};

type RunUserSettleDeps = {
  rlnClient: typeof rlnClient;
  getHodlRecord: typeof getHodlRecord;
};

type RunLpOperatorDeps = {
  rlnClient: typeof rlnClient;
  verifyFundingTransaction: typeof verifyFundingTransaction;
  config: typeof config;
};

/**
 * User-side flow: create HODL invoice, build HTLC, wait for deposit.
 */
export async function runDeposit(
  { amountSat, userRefundPubkeyHex }: DepositParams,
  depsOverride: Partial<RunDepositDeps> = {}
): Promise<DepositResult> {
  const rln = depsOverride.rlnClient ?? rlnClient;
  const rpcClient = depsOverride.rpc ?? rpc;
  const waitFunding = depsOverride.waitForFunding ?? waitForFunding;
  const buildP2tr = depsOverride.buildP2TRHTLC ?? buildP2TRHTLC;
  const sendDeposit = depsOverride.sendDeposit ?? sendDepositTransaction;
  const persist = depsOverride.persistHodlRecord ?? persistHodlRecord;
  const cfg = depsOverride.config ?? config;

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

  if (!cfg.LP_PUBKEY_HEX) {
    throw new Error(
      'LP_PUBKEY_HEX is required for HTLC construction. Provide the LP compressed pubkey hex.'
    );
  }

  // Step 1: Generate preimage/hash and create HODL invoice
  const preimage = randomBytes(32).toString('hex');
  const H = sha256hex(Buffer.from(preimage, 'hex'));
  const amountMsat = amountSat * 1000;

  console.log('\nStep 1: Creating HODL invoice...');
  const invoiceResp = await rln.invoiceHodl({
    payment_hash: H,
    expiry_sec: expirySec,
    amt_msat: amountMsat
  });

  console.log(`   Payment Hash (H): ${H}`);
  console.log(`   Amount: ${amountSat} sats`);
  console.log(`   Expiry: ${expirySec} seconds`);
  console.log(`   Invoice (share with payer): ${invoiceResp.invoice}`);

  await persist({
    payment_hash: H,
    preimage,
    amount_msat: amountMsat,
    expiry_sec: expirySec,
    invoice: invoiceResp.invoice,
    payment_secret: invoiceResp.payment_secret,
    created_at: Date.now()
  });

  // Step 2: Build HTLC (P2TR)
  console.log('\nStep 2: Building HTLC (P2TR)...');
  // Read tip height and set timeout block height
  const tipHeight = await rpcClient.getBlockCount();
  const tLock = tipHeight + cfg.LOCKTIME_BLOCKS;
  console.log(`   Current block height: ${tipHeight}`);
  console.log(`   Time lock block height: ${tLock}`);

  const lpPubkeyHex = cfg.LP_PUBKEY_HEX;
  console.log(`   LP Public Key: ${lpPubkeyHex}`);

  const p2trResult = buildP2tr(H, lpPubkeyHex, userRefundPubkeyHex, tLock);
  console.log(`   P2TR HTLC Address: ${p2trResult.taproot_address}`);
  console.log(`   Amount to fund: ${amountSat} sats`);

  // Step 3: Send deposit to HTLC address
  console.log('\nStep 3: Sending on-chain deposit...');
  const depositTx = await sendDeposit(p2trResult.taproot_address, amountSat);
  console.log(`   Transaction ID: ${depositTx.txid}`);
  if (depositTx.fee_sat > 0) {
    console.log(`   Fee: ${depositTx.fee_sat} sats`);
  }
  if (depositTx.change_sat > 0) {
    console.log(`   Change: ${depositTx.change_sat} sats → ${depositTx.change_address}`);
  }

  // Step 4: Wait for funding transaction confirmation
  console.log('\nStep 4: Waiting for funding confirmation...');
  const funding = await waitFunding(p2trResult.taproot_address, cfg.MIN_CONFS);
  console.log(`   Funding confirmed: ${funding.txid}:${funding.vout} (${funding.value} sats)`);

  return {
    payment_hash: H,
    preimage,
    payment_secret: invoiceResp.payment_secret,
    invoice: invoiceResp.invoice,
    amount_msat: amountMsat,
    expiry_sec: expirySec,
    htlc_p2tr_address: p2trResult.taproot_address,
    htlc_p2tr_internal_key_hex: p2trResult.internal_key_hex,
    t_lock: tLock,
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
 * LP/operator-side flow: verify HTLC, pay invoice, wait for settlement, claim on-chain.
 */
export async function runLpOperatorFlow(
  { invoice, fundingTxid, fundingVout, userRefundPubkeyHex, tLock }: LpOperatorParams,
  depsOverride: Partial<RunLpOperatorDeps> = {}
): Promise<LpOperatorResult> {
  const rln = depsOverride.rlnClient ?? rlnClient;
  const verifyFunding = depsOverride.verifyFundingTransaction ?? verifyFundingTransaction;
  const cfg = depsOverride.config ?? config;

  // Step 1: Decode invoice to get payment hash and amount.
  console.log('\nStep 1: Decoding HODL invoice...');
  const decoded = await rln.decode(invoice);
  const paymentHash = decoded.payment_hash;
  const amountMsat = decoded.amt_msat;
  console.log(`   Decoded Invoice: ${JSON.stringify(decoded, null, 2)}`);
  console.log(`   Payment Hash (H): ${paymentHash}`);
  console.log(`   Amount: ${amountMsat} millisatoshis`);

  if (!cfg.LP_PUBKEY_HEX) {
    throw new Error('LP_PUBKEY_HEX is required to verify the HTLC');
  }

  // Step 2: Verify HTLC funding output (P2TR).
  // Use the exact tLock that USER used when building the HTLC (sent via submarine data)
  // Do NOT recalculate - block height will have changed!
  const template = {
    payment_hash: paymentHash,
    lp_pubkey: cfg.LP_PUBKEY_HEX,
    user_pubkey: userRefundPubkeyHex,
    cltv_expiry: tLock // Use USER's tLock from submarine data
  };

  console.log('\nStep 2: Verify P2TR HTLC funding output...');
  console.log(`   Funding Transaction: ${fundingTxid}:${fundingVout}`);
  console.log(`   Template: ${JSON.stringify(template, null, 2)}`);
  console.log(`   Min Confs: ${cfg.MIN_CONFS}`);

  const fundingInfo = await verifyFunding(
    { txid: fundingTxid, vout: fundingVout },
    template,
    amountMsat,
    cfg.MIN_CONFS
  );
  console.log(`   Funding info: ${JSON.stringify(fundingInfo, null, 2)}`);

  // Step 3: Send payment.
  console.log('\nStep 3: Sending payment...');
  const payResult = await rln.pay(invoice);
  console.log(`   Payment result: ${JSON.stringify(payResult, null, 2)}`);

  if (payResult.status === 'Failed') {
    return { payment_hash: paymentHash, status: 'Failed' };
  }

  // Step 4: Wait until payment is settled.
  console.log('\nStep 4: Waiting for payment settlement...');
  const maxAttempts = 120;
  let finalStatus: LpOperatorResult['status'] = 'Timeout';
  let preimage: string | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const paymentDetails = await rln.getPayment(paymentHash);
    finalStatus = paymentDetails.payment.status as LpOperatorResult['status'];
    console.log(`   Attempt ${attempt + 1}/${maxAttempts}: Status = ${finalStatus}`);

    if (finalStatus === 'Succeeded' || finalStatus === 'Cancelled' || finalStatus === 'Failed') {
      preimage = paymentDetails.payment.preimage;
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  console.log(`   Payment status: ${finalStatus}`);

  if (finalStatus !== 'Succeeded') {
    return { payment_hash: paymentHash, status: finalStatus };
  }

  if (!preimage) {
    throw new Error('Payment succeeded but no preimage is available for on-chain claim');
  }
  console.log(`   Payment preimage: ${preimage}`);

  // Step 5: Claim HTLC on-chain.
  console.log('\nStep 5: Claiming HTLC on-chain...');

  const claimResult = await claimP2trHtlc(
    { txid: fundingTxid, vout: fundingVout, value: fundingInfo.amount_sat },
    paymentHash,
    preimage,
    cfg.WIF,
    userRefundPubkeyHex,
    tLock
  );
  console.log(`   Claim transaction broadcast: ${claimResult.txid}`);
  console.log(`   LP claim address: ${claimResult.lp_address}`);
  return { payment_hash: paymentHash, status: 'Succeeded', claim_txid: claimResult.txid };
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

    // Step 3: Generate LP pubkey and claim address from role-based WIF
    const derived = deriveTaprootFromWIF(config.WIF);
    const lpPubkeyHex = derived.pubkey_hex;
    const lpClaimAddress = derived.taproot_address;
    console.log(`   LP Public Key: ${lpPubkeyHex}`);
    console.log(`   LP Claim Address (derived): ${lpClaimAddress}`);
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
          await new Promise((resolve) => setTimeout(resolve, 5000));
        } catch (error: any) {
          console.log(`   Attempt ${attempt + 1} failed: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, 5000));
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
          config.WIF,
          lpClaimAddress
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
        config.WIF,
        lpClaimAddress
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
    console.error('   - Check WIF in environment');
    return { success: false, error: errorMsg };
  }
}
