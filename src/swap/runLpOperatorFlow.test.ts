import assert from 'node:assert/strict';
import http from 'node:http';
import type { Config } from '../config.js';

// Minimal env defaults so config parsing succeeds when this file is run
// directly (mirrors runDeposit.test.ts). WIF is a valid regtest key;
// BITCOIN_RPC_URL is set after the stub binds (see bootStub).
process.env.CLIENT_ROLE ??= 'LP';
process.env.BITCOIN_RPC_USER ??= 'user';
process.env.BITCOIN_RPC_PASS ??= 'pass';
process.env.NETWORK ??= 'regtest';
process.env.MIN_CONFS ??= '1';
process.env.LOCKTIME_BLOCKS ??= '144';
process.env.WIF ??= 'cNj3zTdrLAMQtUhdFPPVJtRY7a3TdUF38ShW5MrJkVh1CVaeuEGU';
process.env.LP_PUBKEY_HEX ??= '02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27';
process.env.RLN_BASE_URL ??= 'https://example.com';

const H = '11'.repeat(32);
const PREIMAGE = '22'.repeat(32);
const T_LOCK = 800000;
const FUNDING_TXID = '33'.repeat(32);
const FUNDING_VOUT = 0;
const FUND_AMOUNT_SAT = 10000;
const INVOICE = 'lnbcrt1operatorinvoice';
const INVOICE_AMT_MSAT = 100000; // 100 sats, covered by funding

type TestCase = { name: string; run: () => Promise<void> | void };
type RpcHandler = (method: string, params: any[]) => any;

let stub: {
  url: string;
  close: () => Promise<void>;
  setHandler: (h: RpcHandler) => void;
} | null = null;

async function bootStub(): Promise<void> {
  let handler: RpcHandler = () => {
    throw new Error('no handler installed');
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const { method, params, id } = JSON.parse(body);
        const result = handler(method, params);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      } catch (err: any) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { message: String(err?.message ?? err), code: -1 }
          })
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  process.env.BITCOIN_RPC_URL = `http://127.0.0.1:${port}`;
  stub = {
    url: process.env.BITCOIN_RPC_URL,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    setHandler: (h: RpcHandler) => {
      handler = h;
    }
  };
}

async function loadDeps() {
  const { runLpOperatorFlow } = await import('./orchestrator.js');
  const { deriveTaprootFromWIF } = await import('../bitcoin/keys.js');
  const { reconstructP2TRScriptPubKey } = await import('../bitcoin/htlc_p2tr.js');
  const { bufferToHex } = await import('../utils/crypto.js');
  const ecc = await import('tiny-secp256k1');
  const { ECPairFactory } = await import('ecpair');
  return {
    runLpOperatorFlow,
    deriveTaprootFromWIF,
    reconstructP2TRScriptPubKey,
    bufferToHex,
    ECPair: ECPairFactory((ecc as any).default ?? ecc)
  };
}

function makeRln(calls: any) {
  return {
    decode: async () => ({
      payment_hash: H,
      amt_msat: INVOICE_AMT_MSAT,
      timestamp: Math.floor(Date.now() / 1000),
      expiry_sec: 3600
    }),
    pay: async (invoice: string) => {
      calls.pay = invoice;
      return { status: 'Pending' };
    },
    getPaymentPreimage: async () => ({ status: 'Succeeded', preimage: PREIMAGE }),
    htlcScan: async () => ({}),
    htlcClaim: async () => {
      calls.claimed = true;
      return {};
    }
  } as any;
}

const tests: TestCase[] = [
  {
    name: 'pays only after verifying real funding',
    run: async () => {
      const calls: any = {};
      const {
        runLpOperatorFlow,
        deriveTaprootFromWIF,
        reconstructP2TRScriptPubKey,
        bufferToHex,
        ECPair
      } = await loadDeps();
      const userKey = ECPair.makeRandom();
      const userRefundPubkeyHex = Buffer.from(userKey.publicKey).toString('hex');
      const lpPubkeyHex = deriveTaprootFromWIF(process.env.WIF!).pubkey_hex;
      const scriptHex = bufferToHex(
        reconstructP2TRScriptPubKey({
          payment_hash: H,
          lp_pubkey: lpPubkeyHex,
          user_pubkey: userRefundPubkeyHex,
          cltv_expiry: T_LOCK
        })
      );
      stub!.setHandler((method: string) => {
        if (method === 'getrawtransaction') {
          return {
            txid: FUNDING_TXID,
            vout: [
              {
                value: FUND_AMOUNT_SAT / 100_000_000,
                scriptPubKey: { hex: scriptHex },
                n: FUNDING_VOUT
              }
            ],
            confirmations: 6
          };
        }
        if (method === 'gettxout') {
          return {
            confirmations: 6,
            value: FUND_AMOUNT_SAT / 100_000_000,
            scriptPubKey: { hex: scriptHex }
          };
        }
        throw new Error(`unexpected rpc method ${method}`);
      });

      const result = await runLpOperatorFlow(
        {
          invoice: INVOICE,
          fundingTxid: FUNDING_TXID,
          fundingVout: FUNDING_VOUT,
          userRefundPubkeyHex,
          tLock: T_LOCK,
          htlcScriptPubKeyHex: scriptHex
        },
        { rlnClient: makeRln(calls) }
      );

      assert.equal(calls.pay, INVOICE);
      assert.equal(result.status, 'Succeeded');
      assert.equal(calls.claimed, true);
    }
  },
  {
    name: 'refuses to pay when funding is missing',
    run: async () => {
      const calls: any = {};
      const { runLpOperatorFlow, ECPair } = await loadDeps();
      const userKey = ECPair.makeRandom();
      stub!.setHandler(() => {
        throw new Error('no such transaction');
      });

      await assert.rejects(
        runLpOperatorFlow(
          {
            invoice: INVOICE,
            fundingTxid: FUNDING_TXID,
            fundingVout: FUNDING_VOUT,
            userRefundPubkeyHex: Buffer.from(userKey.publicKey).toString('hex'),
            tLock: T_LOCK
          },
          { rlnClient: makeRln(calls) }
        ),
        /Failed to fetch transaction/
      );
      assert.equal(calls.pay, undefined);
    }
  },
  {
    name: 'refuses to pay when funding is underfunded',
    run: async () => {
      const calls: any = {};
      const {
        runLpOperatorFlow,
        deriveTaprootFromWIF,
        reconstructP2TRScriptPubKey,
        bufferToHex,
        ECPair
      } = await loadDeps();
      const userKey = ECPair.makeRandom();
      const userRefundPubkeyHex = Buffer.from(userKey.publicKey).toString('hex');
      const lpPubkeyHex = deriveTaprootFromWIF(process.env.WIF!).pubkey_hex;
      const scriptHex = bufferToHex(
        reconstructP2TRScriptPubKey({
          payment_hash: H,
          lp_pubkey: lpPubkeyHex,
          user_pubkey: userRefundPubkeyHex,
          cltv_expiry: T_LOCK
        })
      );
      // 50 sats against a 100-sat invoice.
      stub!.setHandler((method: string) => {
        if (method === 'getrawtransaction') {
          return {
            txid: FUNDING_TXID,
            vout: [
              {
                value: 50 / 100_000_000,
                scriptPubKey: { hex: scriptHex },
                n: FUNDING_VOUT
              }
            ],
            confirmations: 6
          };
        }
        if (method === 'gettxout') {
          return {
            confirmations: 6,
            value: 50 / 100_000_000,
            scriptPubKey: { hex: scriptHex }
          };
        }
        throw new Error(`unexpected rpc method ${method}`);
      });

      await assert.rejects(
        runLpOperatorFlow(
          {
            invoice: INVOICE,
            fundingTxid: FUNDING_TXID,
            fundingVout: FUNDING_VOUT,
            userRefundPubkeyHex,
            tLock: T_LOCK
          },
          { rlnClient: makeRln(calls) }
        ),
        /Insufficient amount/
      );
      assert.equal(calls.pay, undefined);
    }
  },
  {
    name: 'refuses to pay without t_lock',
    run: async () => {
      const calls: any = {};
      const { runLpOperatorFlow, ECPair } = await loadDeps();
      const userKey = ECPair.makeRandom();
      stub!.setHandler(() => {
        throw new Error('rpc must not be touched without t_lock');
      });

      await assert.rejects(
        runLpOperatorFlow(
          {
            invoice: INVOICE,
            fundingTxid: FUNDING_TXID,
            fundingVout: FUNDING_VOUT,
            userRefundPubkeyHex: Buffer.from(userKey.publicKey).toString('hex')
          },
          { rlnClient: makeRln(calls) }
        ),
        /without t_lock/
      );
      assert.equal(calls.pay, undefined);
    }
  }
];

await bootStub();
try {
  for (const test of tests) {
    try {
      await test.run();
      console.log(`ok - ${test.name}`);
    } catch (error) {
      console.error(`not ok - ${test.name}`);
      console.error(error);
      process.exitCode = 1;
    }
  }
} finally {
  await stub!.close();
}
