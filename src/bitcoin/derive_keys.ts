#!/usr/bin/env node
import { deriveTaprootFromWIF } from './keys.js';
import { config, CLIENT_ROLE } from '../config.js';

async function main(): Promise<void> {
  const wif = config.WIF;
  const derived = deriveTaprootFromWIF(wif);

  const output = {
    client_role: CLIENT_ROLE,
    network: derived.network,
    pubkey_hex: derived.pubkey_hex,
    x_only_pubkey_hex: derived.x_only_pubkey_hex,
    taproot_address: derived.taproot_address
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err: any) => {
  console.error(`derive-keys failed: ${err?.message ?? err}`);
  process.exit(1);
});
