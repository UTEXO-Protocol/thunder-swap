# RGB-LN Submarine Swap POC

A minimal Node.js/TypeScript tool for Bitcoin-RGB-LN atomic swaps via P2TR HTLC.

## Architecture

```
RGB-LN Hodl Invoice → Extract Hash → Build P2TR HTLC → Fund/Deposit → Pay Invoice → Claim HTCL with Preimage
                                    ↓
                               Submarine Swap
                                    ↓
                              Timeout → Refund PSBT
```

## Features

✅ Extract payment hash from RGB-LN invoice  
✅ Build P2TR HTLC with timelock refund path  
✅ Wait for funding confirmations  
✅ Pay RGB-LN invoice (submarine swap)  
✅ Claim P2TR HTLC using preimage on success (POC, pays LP Taproot address derived from WIF)  
✅ Generate refund PSBT on timeout

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

#### CLIENT_ROLE and environment layering

Bootstrap order:

1. Load shared defaults from `.env` (place `CLIENT_ROLE`, Bitcoin RPC, network/signet parameters here).
2. Load role overlay `.env.lp` or `.env.user` based on `CLIENT_ROLE` (role-local secrets and endpoints, e.g., WIF, RLN).

Set `CLIENT_ROLE` in `.env`:

- `CLIENT_ROLE=LP` → `.env.lp` overlays shared defaults
- `CLIENT_ROLE=USER` → `.env.user` overlays shared defaults

**Note:** The `run-user.sh` and `run-lp.sh` scripts automatically create `.env`, `.env.user`, and `.env.lp` from their example files if they don't already exist.

**Shared defaults:**

```bash
BITCOIN_RPC_URL=http://127.0.0.1:18443
BITCOIN_RPC_USER=rpcuser
BITCOIN_RPC_PASS=rpcpass
NETWORK=signet
MIN_CONFS=1
LOCKTIME_BLOCKS=288 # 2days
HODL_EXPIRY_SEC=86400 # 1day
FEE_RATE_SAT_PER_VB=1
LP_PUBKEY_HEX=03...  # Compressed pubkey (33 bytes hex)
```

**Role-specific env overlay:**

```bash
# RGB-LN Node
RLN_BASE_URL=http://localhost:8080
RLN_API_KEY=optional_bearer_token
# Signing key
WIF=cV...
```

### 3. Start RGB-LN Node

The USER and LP clients connect to their respective RGB Lightning Nodes via `RLN_BASE_URL` configured in `.env.user` and `.env.lp`. Ensure the RLN instances are accessible with the following endpoints:

- `POST /decodelninvoice` - Returns `{payment_hash, amt_msat, expires_at?}`
- `POST /sendpayment` - Returns `{status, payment_hash, payment_secret}`
- `POST /getpayment` - Returns `{payment: {status, preimage? ...}}` (preimage required on success)
- `POST /invoice/hodl` - Returns `{invoice, payment_secret}`
- `POST /invoice/settle` - Returns `{}` (empty)
- `POST /invoice/cancel` - Returns `{}` (empty)

### 4. Run Submarine Swap

To run both USER and LP clients simultaneously (two instances), use the provided scripts:

**Terminal 1 (LP):**

```bash
./run-lp.sh
```

**Terminal 2 (USER):**

```bash
./run-user.sh
```

**Client Communication:** (TODO-comms: improve client-to-client comms).

Share invoice and deposit txid:

- USER creates HODL invoice and HTLC deposit, then shares:
  - Invoice (encoded invoice string)
  - Deposit txid (Bitcoin transaction ID and vout sending funds into the HTCL address)
- LP receives these and executes payment/claim flow

Built-in minimal comms (HTTP, no extra deps):

- USER starts a tiny HTTP server on `CLIENT_COMM_PORT` (default `9999`) and publishes submarine data (invoice, funding txid/vout, user refund pubkey).
- LP polls `USER_COMM_URL` (default `http://localhost:9999/submarine`) to fetch that data and run the operator flow.

Env variables:

- `.env.user`: `CLIENT_COMM_PORT=9999`
- `.env.lp`: `USER_COMM_URL=http://localhost:9999`

**Note:** Environment variables override `.env` file values. The scripts set `CLIENT_ROLE` via environment variable, so you can keep a default in `.env` without conflicts.

## Protocol Flow

1. Generate 32-byte preimage `P`, compute `H = SHA256(P)`
2. Create HODL invoice with payment hash `H`
3. Construct P2TR HTLC with dual spend paths:
   - Claim path: `H = SHA256(preimage)` + LP signature
   - Refund path: CLTV timelock (`tLock`) + user signature
4. Monitor UTXO confirmation (`MIN_CONFS`)
5. Execute RGB-LN invoice payment
6. On success: claim HTLC via preimage revelation (to LP Taproot address derived from LP WIF)
7. On timeout/failure: generate refund PSBT (requires `tLock` expiry)

### Two-Party Flow (User vs Operator)

The POC is split into a USER-side deposit flow and an LP/operator-side execution flow.

#### USER: Deposit + Settle or Cancel & Refund

1. Run script `./run-user.sh` and provide submarine swap amount in sats.
2. The client generates a preimage and creates a HODL invoice via `/invoice/hodl`. Persists `payment_hash → {preimage, metadata}` to `hodl_store.json`.
3. It builds the P2TR HTLC using `LP_PUBKEY_HEX` and funds it from the USER wallet (with locally built P2TR PSBT, signs with `WIF`, and broadcasts - the unsigned PSBT is included in the deposit result for future external signing). Sends invoice amount to the HTLC address:
   1. Select UTXOs from the user taproot address derived from `WIF`.
   2. Build an unsigned PSBT using the chosen inputs and the HTLC output (plus change if applicable).
   3. Load the signing key from `WIF`.
   4. Sign the PSBT locally, then finalize it into a raw transaction.
   5. Broadcast the transaction to the Bitcoin network.
4. It waits for `MIN_CONFS`, then sends the invoice and deposit txid to the operator.
5. It waits for a claimable event (poll USER RLN for `Pending` inbound payment).
6. It decides to call `/invoice/settle` or wait for timeout and refund the HTLC.

#### LP/Operator: Pay + Claim

1. Receive the invoice and HTLC deposit txid from the USER.
2. Verify the HTLC using the current verification flow (POC): confirms confirmations, scriptPubKey match, amount floor, P2TR type, and minimal tapscript sanity. Limitations TODO: no script-path spend simulation/control block validation, no signer policy proofs beyond template match, no fee/RBF/CPFP handling, and no reorg handling.
3. Call `/sendpayment` to pay the invoice.
4. Poll `/getpayment` until the payment is settled.
5. Claim the HTLC on-chain (POC, pays LP Taproot address derived from LP WIF).

## Persistence

The USER-side flow persists a `HodlRecord` to:

`~/.thunder-swap/hodl_store.json`

```json
{
  "payment_hash": "hex",
  "preimage": "hex",
  "amount_msat": 123000,
  "expiry_sec": 86400,
  "invoice": "rgb1...",
  "payment_secret": "hex",
  "created_at": 1700000000000
}
```

The preimage is required later to claim the HTLC once the payment succeeds.

TODO: Improve persistence to support recovery, retries, and multi-swap bookkeeping:

- Extend `HodlRecord` with `funding_txid`, `funding_vout`, `t_lock`, `user_pubkey`, `lp_pubkey`, `status`.
- Add encryption at rest and explicit backup/restore flow.
- Add index/list endpoints for operator and user recovery tools.

## Safety Checks

- ✅ Validates pubkey formats (33-byte compressed)
- ✅ Checks invoice expiration before processing
- ✅ Verifies preimage matches payment hash (H)
- ✅ Confirms HTLC funding before payment attempt
- ✅ Safe refund PSBT with timelock validation
- ✅ Enforces `LOCKTIME_BLOCKS` to outlast `HODL_EXPIRY_SEC` (defaults in `.env.example`: 288 blocks ≈ 2 days vs 86400 sec = 1 day)

## Tests

```bash
npm test
```

- Taproot HTLC unit tests
- `runDeposit` unit + integration-style tests (mocked deps for fast, deterministic UX)

### Refund Path

```bash
# Trigger: HTLC timeout or payment failure
# Action: Refund PSBT generated (requires CLTV timelock expiry)
# Execute: Sign and broadcast refund transaction
```

## Troubleshooting

**`CLIENT_ROLE environment variable is required`**  
→ Define `CLIENT_ROLE` in `.env` as a default, or override via scripts. The environment variable takes precedence over `.env` file values.

**Wrong environment file loaded**  
→ Verify `CLIENT_ROLE` in `.env` matches existing `.env.lp` or `.env.user`. No fallback to `.env` only.

**RPC errors**  
→ Verify Bitcoin Core RPC connectivity and credentials.

**Invoice decode failures**  
→ Confirm RGB-LN node endpoint accessibility.

**Payment succeeds but claim fails**  
→ RGB-LN node must return preimage in payment response. @TODO

**HTLC funding not detected**  
→ Verify UTXO address, amount, and confirmation depth.

## File Structure

```
run-user.sh           # Script to run USER client instance
run-lp.sh             # Script to run LP client instance
src/
├─ index.ts           # CLI entry point (role-based: USER/LP)
├─ config.ts          # Environment configuration
├─ utils/
│  ├─ crypto.ts       # SHA256, hex helpers
│  ├─ store.ts        # HODL record persistence
│  ├─ comm-server.ts  # HTTP server for USER (publishes submarine data)
│  └─ comm-client.ts  # HTTP client for LP (fetches submarine data)
├─ bitcoin/
│  ├─ rpc.ts          # Bitcoin RPC client
│  ├─ watch.ts        # UTXO monitoring
│  ├─ htlc.ts         # P2WSH HTLC builder (deprecated)
│  ├─ htlc_p2tr.ts    # P2TR HTLC builder
│  ├─ claim.ts        # Claim P2WSH HTLC with preimage
│  ├─ htlc_p2tr_finalize.ts   # Claim/refund P2TR HTLC
│  ├─ refund.ts       # Refund PSBT builder
│  ├─ deposit.ts      # Deposit transaction builder
│  ├─ verify_p2tr.ts  # HTLC verification for LP
│  ├─ keys.ts         # Key derivation from WIF
│  ├─ network.ts      # Network configuration
│  ├─ balance.ts      # Balance checking utilities
│  ├─ derive_keys.ts  # Key derivation CLI tool
│  └─ utxo_utils.ts   # UTXO selection utilities
├─ rln/
│  ├─ client.ts       # RGB-LN API client
│  └─ types.ts        # Endpoint schemas
└─ swap/
   └─ orchestrator.ts  # Main swap coordination (runDeposit, runLpOperatorFlow)
```

## Production Notes

Current implementation targets regtest/testnet. For production:

- Implement fee estimation via Bitcoin Core API
- Add RBF support for claim/refund transactions
- Validate addresses per network (mainnet/testnet)
- Consider Taproot HTLC for lower fees
- Implement WebSocket for real-time payment tracking
- Add proper DDoS protection mechanisms
- Extend RGB-LN API to formal versioning contract

## Appendix

### Key Derivation and Balance Utilities

You can also derive the PUBKEY_HEX and a Taproot (bech32m) address directly from the WIF loaded via `.env.<role>`:

```bash
# Ensure CLIENT_ROLE is set to LP or USER and the corresponding WIF is in .env.lp or .env.user
npm run derive-keys
# prints JSON with pubkey_hex, x_only_pubkey_hex, and taproot_address
```

Check current Taproot balances for both roles (LP from `LP_PUBKEY_HEX`, user from `WIF`):

```bash
npm run balance
```

Shows both user Taproot and user P2WPKH balances (from the same WIF) plus LP Taproot.

Send funds using the same keys (builds and signs locally):

```bash
# Send 10000 sats from USER or LP (if LP_WIF is present in .env.lp) to some address
npm run balance -- sendbtc <user/lp> <toAddress> <sats>
```

## License

MIT
