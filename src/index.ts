#!/usr/bin/env node
import { runDeposit } from './swap/orchestrator.js';
import { isValidCompressedPubkey, validateWIF } from './utils/crypto.js';
import { config } from './config.js';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

interface ParsedArgs {
  amountSat: number;
  userRefundPubkeyHex: string;
  userRefundAddress: string;
}

async function promptAmount(): Promise<{ amountSat: number }> {
  const rl = readline.createInterface({ input, output });

  const amountAnswer = await rl.question('Enter swap amount in sats: ');
  const amountSat = parseInt(amountAnswer.trim(), 10);
  if (!Number.isFinite(amountSat) || amountSat <= 0) {
    rl.close();
    throw new Error('Invalid amount. Must be a positive integer number of sats.');
  }

  rl.close();
  return { amountSat };
}

async function parseArgs(): Promise<ParsedArgs> {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: npx tsx src/index.ts "<USER_REFUND_PUBKEY_HEX>" "<USER_REFUND_ADDRESS>"');
    console.error('');
    console.error('Example:');
    console.error('  npx tsx src/index.ts "02abc..." "tb1..."');
    console.error('');
    console.error('Arguments:');
    console.error('  USER_REFUND_PUBKEY User refund public key (33 bytes compressed hex)');
    console.error('  USER_REFUND_ADDRESS User refund Bitcoin address');
    process.exit(1);
  }

  const [userRefundPubkeyHex, userRefundAddress] = args;

  // Validate inputs
  if (!isValidCompressedPubkey(userRefundPubkeyHex)) {
    console.error('ERROR: Invalid user refund pubkey');
    console.error('  Expected: 33-byte compressed pubkey (66 hex chars starting with 02/03)');
    console.error(`  Got: ${userRefundPubkeyHex} (${userRefundPubkeyHex.length} chars)`);
    process.exit(1);
  }

  if (userRefundAddress.length < 26 || userRefundAddress.length > 90) {
    console.error('ERROR: Invalid user refund address format', userRefundAddress);
    console.error('  Expected valid Bitcoin address');
    process.exit(1);
  }

  const { amountSat } = await promptAmount();

  return {
    amountSat,
    userRefundPubkeyHex,
    userRefundAddress
  };
}

function validateEnvironment(): void {
  console.log('🔧 Environment configuration check...');

  // Check required env vars
  try {
    const role = process.env.CLIENT_ROLE?.toUpperCase();
    console.log(`   Bitcoin RPC: ${config.BITCOIN_RPC_URL}`);
    console.log(`   Network: ${config.NETWORK}`);
    console.log(`   WIF: ${config.WIF.slice(0, 10)}...`);
    if (config.LP_PUBKEY_HEX) {
      console.log(`   LP Pubkey (hex): ${config.LP_PUBKEY_HEX}`);
    }
    console.log(`   RLN URL: ${config.RLN_BASE_URL}`);

    if (!validateWIF(config.WIF)) {
      throw new Error('WIF is not a valid WIF format');
    }

    console.log('   Environment looks good\n');
  } catch (error: any) {
    console.error(`Environment setup error: ${error.message}`);
    console.error('   Check your .env file matches .env.example');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  console.log('RGB-LN Submarine Swap POC');
  console.log('=====================================\n');

  try {
    // Validate environment
    validateEnvironment();

    // Parse command line arguments
    const args = await parseArgs();

    console.log('Swap Parameters:');
    console.log(`   Amount: ${args.amountSat} sats`);
    console.log(`   User Pubkey: ${args.userRefundPubkeyHex.slice(0, 20)}...`);
    console.log(`   Refund Address: ${args.userRefundAddress}\n`);

    // User-side deposit flow: create HODL invoice and wait for funding
    const result = await runDeposit(args);

    console.log('\n=====================================');
    console.log('HODL invoice prepared and deposit confirmed.');
    console.log(`   Invoice: ${result.invoice}`);
    console.log(`   Payment Hash: ${result.payment_hash}`);
    console.log(`   Preimage: ${result.preimage}`);
    console.log(`   Payment Secret: ${result.payment_secret}`);
    console.log(`   HTLC (P2TR) Address: ${result.htlc_p2tr_address}`);
    console.log(`   Internal Key (hex): ${result.htlc_p2tr_internal_key_hex}`);

    if (result.deposit.fee_sat > 0) {
      console.log(`   Fee: ${result.deposit.fee_sat} sats`);
    }
    console.log(`   Deposit txid: ${result.deposit.txid}`);
    if (result.deposit.change_sat > 0) {
      console.log(
        `   Change: ${result.deposit.change_sat} sats → ${result.deposit.change_address}`
      );
    }

    console.log(
      `   Funding: ${result.funding.txid}:${result.funding.vout} (${result.funding.value} sats)`
    );
    console.log('Share invoice with the payer; proceed to node-side execution to pay/claim.');
  } catch (error: any) {
    console.error(`Fatal error: ${error.message}`);
    console.error('   Stack trace:', error.stack);
    process.exit(1);
  }
}

// Handle uncaught exceptions gracefully
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

// Run the main function
main();
