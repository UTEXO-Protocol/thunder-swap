import http from 'http';
import { CLIENT_ROLE, config } from '../config.js';

export interface SubmarineData {
  invoice: string;
  fundingTxid: string;
  fundingVout: number;
  userRefundPubkeyHex: string;
  tLock: number; // Timelock block height used by USER when building HTLC
  // paymentHash is NOT included - LP decodes invoice & extracts it
}

let submarineData: SubmarineData | null = null;

const PORT = config.CLIENT_COMM_PORT || 9999;

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/submarine') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        submarineData = JSON.parse(body) as SubmarineData;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/submarine') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        submarineData ?? { error: 'No submarine data available yet; waiting for USER publish.' }
      )
    );
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

export function startCommServer(): Promise<void> {
  if (CLIENT_ROLE !== 'USER') return Promise.resolve();

  return new Promise((resolve) => {
    server.listen(PORT, () => {
      console.log(
        `📡 USER comm server running on http://localhost:${PORT}/submarine (LP will connect via comm client)\n`
      );
      resolve();
    });
  });
}

export function publishSubmarineData(data: SubmarineData): void {
  submarineData = data;
  console.log('   📤 Published submarine data for LP retrieval.');
}
