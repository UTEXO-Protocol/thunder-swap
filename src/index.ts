#!/usr/bin/env node
import { runSwap } from './swap/orchestrator.js';
import { isValidCompressedPubkey, validateWIF } from './utils/crypto.js';
import { config } from './config.js';

interface ParsedArgs {
  invoice: string;
  userRefundPubkeyHex: string;
  userRefundAddress: string;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  
  if (args.length < 3) {
    console.error('❌ Usage: npx tsx src/index.ts "<RGB_INVOICE>" "<USER_REFUND_PUBKEY_HEX>" "<USER_REFUND_ADDRESS>"');
    console.error('');
    console.error('Example:');
    console.error('  npx tsx src/index.ts "rgb1..." "02abc..." "tb1..."');
    console.error('');
    console.error('Arguments:');
    console.error('  RGB_INVOICE         RGB-LN invoice string');
    console.error('  USER_REFUND_PUBKEY User refund public key (33 bytes compressed hex)');
    console.error('  USER_REFUND_ADDRESS User refund Bitcoin address');
    process.exit(1);
  }

  const [invoice, userRefundPubkeyHex, userRefundAddress] = args;

  // Validate inputs
  if (invoice.length < 10 || !invoice.startsWith('rgb')) {
    console.error('❌ ERROR: Invalid RGB invoice format');
    console.error('  Expected format: rgb1...');
    process.exit(1);
  }

  if (!isValidCompressedPubkey(userRefundPubkeyHex)) {
    console.error('❌ ERROR: Invalid user refund pubkey');
    console.error('  Expected: 33-byte compressed pubkey (66 hex chars starting with 02/03)');
    console.error(`  Got: ${userRefundPubkeyHex} (${userRefundPubkeyHex.length} chars)`);
    process.exit(1);
  }

  if (userRefundAddress.length < 26 || userRefundAddress.length > 62) {
    console.error('❌ ERROR: Invalid user refund address format');
    console.error('  Expected valid Bitcoin address');
    process.exit(1);
  }

  return {
    invoice,
    userRefundPubkeyHex,
    userRefundAddress
  };
}

function validateEnvironment(): void {
  console.log('🔧 Environment configuration check...');
  
  // Check required env vars
  try {
    console.log(`   Bitcoin RPC: ${config.BITCOIN_RPC_URL}`);
    console.log(`   Network: ${config.NETWORK}`);
    console.log(`   LP WIF: ${config.LP_WIF.slice(0, 10)}...`);
    console.log(`   LP Claim: ${config.LP_CLAIM_ADDRESS}`);
    console.log(`   RLN URL: ${config.RLN_BASE_URL}`);
    
    // Validate WIF format
    if (!validateWIF(config.LP_WIF)) {
      throw new Error('LP_WIF is not a valid WIF format');
    }
    
    console.log('   ✓ Environment looks good\n');
  } catch (error: any) {
    console.error(`❌ Environment setup error: ${error.message}`);
    console.error('   Check your .env file matches .env.example');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  console.log('🌊 RGB-LN Submarine Swap POC');
  console.log('=====================================\n');

  try {
    // Validate environment
    validateEnvironment();

    // Parse command line arguments
    const args = parseArgs();

    console.log('📋 Swap Parameters:');
    console.log(`   Invoice: ${args.invoice.slice(0, 20)}...`);
    console.log(`   User Pubkey: ${args.userRefundPubkeyHex.slice(0, 20)}...`);
    console.log(`   Refund Address: ${args.userRefundAddress}\n`);

    // Run the swap
    const result = await runSwap(args);

    console.log('\n=====================================');
    if (result.success && result.txid) {
      console.log('🎉 SUCCESS: HTLC claimed!');
      console.log(`   Claim Transaction ID: ${result.txid}`);
      console.log(`   Block Explorer: https://blockstream.info/tx/${result.txid}`);
    } else if (result.psbt && result.instructions) {
      console.log('⚠️  PAYMENT FAILED: Refund PSBT prepared');
      console.log(`   Refund PSBT: ${result.psbt}`);
      console.log('\n' + result.instructions);
    } else {
      console.log('❌ SWAP FAILED');
      if (result.error) {
        console.log(`   Error: ${result.error}`);
      }
      process.exit(1);
    }

  } catch (error: any) {
    console.error(`💥 Fatal error: ${error.message}`);
    console.error('   Stack trace:', error.stack);
    process.exit(1);
  }
}

// Handle uncaught exceptions gracefully
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('💥 Unhandled rejection:', reason);
  process.exit(1);
});

// Run the main function
main();
