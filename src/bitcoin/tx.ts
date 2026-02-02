import { rpc } from './rpc.js';

function explainRpcError(code: number | undefined, message: string | undefined): void {
  if (code === -5 && message?.includes('No such mempool or blockchain transaction')) {
    console.error(
      'Hint: transaction not found. Ensure the txid exists on this node’s network and has been seen by the node. If txindex is off, enable txindex=1 (with prune=0) and reindex for historical lookups.'
    );
  }
  if (code === -8 && message?.includes('Block pruning')) {
    console.error('Hint: node is pruned; full tx lookups require prune=0 and txindex=1.');
  }
}

function getTxidArg(): string {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    throw new Error('Usage: npm run tx -- <txid>');
  }

  const txid = args[0].trim();
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
    throw new Error('txid must be a 64-character hex string');
  }

  return txid;
}

async function main() {
  try {
    const txid = getTxidArg();
    const tx = await rpc.getRawTransaction(txid, true);
    console.log(JSON.stringify(tx, null, 2));
  } catch (error: any) {
    const rpcError = error?.response?.data?.error;
    if (rpcError) {
      console.error(`RPC Error: ${rpcError.message} (code: ${rpcError.code})`);
      explainRpcError(rpcError.code, rpcError.message);
    } else if (error?.response) {
      console.error(`HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`);
    }
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}

void main();
