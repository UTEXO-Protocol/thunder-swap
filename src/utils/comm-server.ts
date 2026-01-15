import http from 'http';
import { CLIENT_ROLE, config } from '../config.js';

export interface SubmarineData {
  invoice: string;
  fundingTxid: string;
  fundingVout: number;
  userRefundPubkeyHex: string;
  paymentHash: string;
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
    if (!submarineData) {
      // Explicitly signal "not ready" without returning an error payload to the client.
      res.writeHead(204, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      });
      res.end();
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(submarineData));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

export function startCommServer(): void {
  if (CLIENT_ROLE !== 'USER') return;

  server.listen(PORT, () => {
    console.log(`📡 Submarine comm server listening on http://localhost:${PORT}/submarine`);
  });
}

export function publishSubmarineData(data: SubmarineData): void {
  submarineData = data;
  console.log('📤 Published submarine data for LP retrieval.');
}
