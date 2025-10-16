# RGB onchain sumbmarine swap

We're implementing atomic swaps between RGB assets and Lightning payments using a Bitcoin HTLC P2WSH as the funding output for an RGB transfer (user funds HTLC with BTC + RGB state; LP pays LN invoice and later claims RGB using the preimage).

1. User wants RGB asset in RGB LN channel → LP sends RGB assets
2. LP builds HTLC script and address P2WSH(htlc_script) then generates an RGB witness invoice where recipientId = beneficiary_from_script_buf(P2WSH(htlc_script)) (custom script_receive mirrors witness_receive but accepts arbitrary ScriptBuf).
2. LP creates HTLC and generate witness invoice with HTLC to put it in recipientId we added script_receive func that work similar to witness_recive  but allow to pass script_buf (HTLC in our case)
3. User Pay RGB witness invoice to HTLC address with `witness_data` 
4. LP pays Lightning invoice → reveals preimage
5. LP claims RGB assets using preimage from HTLC script we are going to implement it similar to send for destination we are going to use witness rgb invoice that LP should pay from HTLC UTXO
6. User gets Lightning payment → LP gets RGB assets


## Flow Example

### 1. Create Wallet
```rust
let wallet_data = WalletData {
    data_dir: "/tmp/rgb_wallet".to_string(),
    bitcoin_network: BitcoinNetwork::Regtest,
    database_type: DatabaseType::Sqlite,
    max_allocations_per_utxo: 1,
    account_xpub_vanilla: "tpubDChEpEANeKpzFCcMXy387Xb5t6ELbdbwVxNrSMvMk7N9EYbriGYoLMyJPJQtpCRY81yscQ5kKWkQRZvydEG3CFqLKDT7gDYpz4Mp4hQA3M3".to_string(),
    account_xpub_colored: "tpubDCBwNQaPvsg7YpDak6Qcgkn2Sidc9oKHzhdNxhKCz3Kbrw4SvbWVPC6JtKmWVSe5skaWpRb8yTLUsi9fxAmFcGZiAxDbDzUQpxH3tgebb5E".to_string(),
    mnemonic: Some("segment enter garden around setup learn fiber nominee text network basket describe".to_string()),
    master_fingerprint: "7f6d1a6b".to_string(),
    vanilla_keychain: Some(1),
    supported_schemas: vec![AssetSchema::Nia],
};

let mut wallet = Wallet::new(wallet_data)?;
```

### 2. Create HTLC Script
```rust

 let xpub = Xpub::from_str(&lp_keys.account_xpub_colored) // used also vanila but same result
        .expect("Valid xPub");

    let secp = rgb_lib::bitcoin::secp256k1::Secp256k1::new();
    let derived_xpub = xpub.derive_pub(&secp, &[
        rgb_lib::bitcoin::bip32::ChildNumber::from_normal_idx(0).unwrap()
    ]).expect("Derivation succeeds");
    
    let lp_pubkey = PublicKey::new(derived_xpub.public_key);

let htlc_script = Builder::new()
    .push_opcode(OP_IF)
        .push_opcode(OP_SHA256)
        .push_slice(&payment_hash)
        .push_opcode(OP_EQUALVERIFY)
        .push_key(&lp_pubkey)
        .push_opcode(OP_CHECKSIG)
    .push_opcode(OP_ELSE)
        .push_int(timelock_blocks as i64)
        .push_opcode(OP_CSV)
        .push_opcode(OP_DROP)
        .push_key(&user_pubkey)
        .push_opcode(OP_CHECKSIG)
    .push_opcode(OP_ENDIF)
    .into_script();

// Create P2WSH address
let htlc_address = Address::p2wsh(&htlc_script, network).to_string();
```

### 3. Use script_receive (Custom Function)
```rust
// script_receive is a custom function similar to witness_receive
// but can receive to custom ScriptBuf 
  let script_pubkey = if script_buf.is_p2wpkh() || script_buf.is_p2wsh() || script_buf.is_p2tr() {
            script_buf.clone()
        } else {
            let bdk_network: BdkNetwork = self.bitcoin_network().into();
            BdkAddress::p2wsh(&script_buf, bdk_network).script_pubkey()
        };

        let beneficiary = beneficiary_from_script_buf(script_pubkey.clone());

let receive_data = wallet.script_receive(
    htlc_script.clone(),  // Custom HTLC script (ScriptBuf)
    None,
    Assignment::Fungible(13),
    Some(86400),
    vec!["rpc://regtest.thunderstack.org:3000/json-rpc".to_string()],
    1,
)?;
```

**Note**: `script_receive` is a custom function that works like `witness_receive` but accepts a `ScriptBuf` parameter for custom Bitcoin scripts (like HTLC contracts).

### 4. User sends with witness_data
```rust
let recipient = Recipient {
    recipient_id: receive_data.recipient_id.clone(),
    assignment: Assignment::Fungible(13),
    witness_data: Some(WitnessData {
        amount_sat: 1000,  
        blinding: None,
    }),
    transport_endpoints: receive_data.transport_endpoints.clone(),
};

wallet.send(online, recipient_map, true, 2, 1, false)?;
```

## The Problem
After funding confirms, RGB wallet shows the colored allocation attached to that outpoint but reports
It seems that rgb utxo isnt synced with btc htlc utxo
When user sends with `witness_data`, the system should:
1. Create Bitcoin transaction to HTLC address (1000 sats)
2. Update the RGB UTXO to Bitcoin UTXO


## Bitcoin UTXO
There amount is as expected
```json
{
  "unspents": [
            {
                "txid": "50e45619eaf8aabe9b4fe25309b6095cf57cdf6f7382be2fb819b70eec4f67a9",
                "vout": 1,
                "scriptPubKey": "0020f6bb27eee22b269a32f55e9b0a1979bdbe9bc88f854f57fe3799b1de2b58e48c",
                "desc": "addr(bcrt1q76aj0mhz9vnf5vh4t6ds5xtehklfhjy0s4840l3hnxcau26cujxqpqyp4w)#mh5dkz8g",
                "amount": 0.00001000,
                "coinbase": false,
                "height": 22239
            }
        ],
}
```

The RGB UTXO:
it expected to be `btc_amount: 1000` and `exists: true`
```
Unspent { 
    utxo: Utxo { 
        outpoint: Outpoint { txid: "50e45619...", vout: 1 }, 
        btc_amount: 0,       
        colorable: true, 
        exists: false       
    }, 
    rgb_allocations: [RgbAllocation { 
        asset_id: Some("rgb:HCwuw9vr..."), 
        assignment: Fungible(13), 
        settled: true 
    }]
}
```

## Question

How should rgb work with external HTLC addresses for atomic RGB-LN swaps? The current sync mechanism only looks at wallet-controlled addresses, but HTLC addresses are external P2WSH addresses. Should the sync mechanism be extended to monitor external addresses, or is there a different approach for HTLC integration?

Also how claim can be implemented in RGB context. Should it be similar to send but with but allow custom PSBT input params witness_script etc? 