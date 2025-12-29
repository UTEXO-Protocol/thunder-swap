import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const STORE_FILENAME = 'hodl_store.json';
const STORE_DIR = path.join(os.homedir(), '.thunder-swap');
const storePath = path.join(STORE_DIR, STORE_FILENAME);

export interface HodlRecord {
  payment_hash: string;
  preimage: string;
  amount_msat: number;
  expiry_sec: number;
  invoice: string;
  payment_secret: string;
  created_at: number;
}

interface HodlStore {
  [payment_hash: string]: HodlRecord;
}

async function ensureStoreDir(): Promise<void> {
  await fs.mkdir(STORE_DIR, { recursive: true });
}

async function loadStore(): Promise<HodlStore> {
  try {
    const data = await fs.readFile(storePath, 'utf8');
    return JSON.parse(data) as HodlStore;
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return {};
    }
    throw err;
  }
}

async function saveStore(store: HodlStore): Promise<void> {
  await ensureStoreDir();
  const tmpPath = `${storePath}.tmp`;
  const data = JSON.stringify(store, null, 2);
  await fs.writeFile(tmpPath, data, 'utf8');
  await fs.rename(tmpPath, storePath);
}

export async function persistHodlRecord(record: HodlRecord): Promise<void> {
  const store = await loadStore();
  store[record.payment_hash] = record;
  await saveStore(store);
}

export async function getHodlRecord(paymentHash: string): Promise<HodlRecord | undefined> {
  const store = await loadStore();
  return store[paymentHash];
}

export async function listHodlRecords(): Promise<HodlRecord[]> {
  const store = await loadStore();
  return Object.values(store);
}
