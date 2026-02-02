import * as bitcoin from 'bitcoinjs-lib';
import { rpc } from './rpc.js';
import { getNetwork } from './network.js';

function getAddressArg(): string {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    throw new Error('Usage: npm run addr -- <address>');
  }
  const address = args[0].trim();
  try {
    // Validate address for current network
    bitcoin.address.toOutputScript(address, getNetwork());
  } catch {
    throw new Error('Invalid address for configured NETWORK');
  }
  return address;
}

async function main() {
  try {
    const address = getAddressArg();
    const scan = await rpc.scanTxOutSet(address);
    console.log(
      JSON.stringify(
        {
          address,
          total_amount_btc: scan.total_amount,
          unspent_count: scan.unspents?.length ?? 0,
          unspents: scan.unspents ?? []
        },
        null,
        2
      )
    );
  } catch (error: any) {
    const rpcError = error?.response?.data?.error;
    if (rpcError) {
      console.error(`RPC Error: ${rpcError.message} (code: ${rpcError.code})`);
    } else if (error?.response) {
      console.error(`HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`);
    }
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}

void main();
