import http from 'http';
import { CLIENT_ROLE, config } from '../config.js';
import type { RgbInvoiceHtlcResponse } from '../rln/types.js';

export interface SubmarineRequest {
  invoice: string; // HODL invoice
  userRefundPubkeyHex: string;
  // paymentHash is NOT included - LP decodes invoice & extracts it
}

export interface FundingData {
  fundingTxid: string;
  fundingVout: number;
}

let submarineRequest: SubmarineRequest | null = null;
let rgbInvoiceHtlcResponse: RgbInvoiceHtlcResponse | null = null;
let fundingData: FundingData | null = null;

const PORT = config.CLIENT_COMM_PORT || 9999;

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/submarine') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        submarineRequest = JSON.parse(body) as SubmarineRequest;
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
        submarineRequest ?? { error: 'No submarine request available yet; waiting for USER publish.' }
      )
    );
    return;
  }

  if (req.method === 'POST' && req.url === '/rgbinvoicehtlc') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        rgbInvoiceHtlcResponse = JSON.parse(body) as RgbInvoiceHtlcResponse;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/rgbinvoicehtlc') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        rgbInvoiceHtlcResponse ??
        { error: 'No rgbinvoicehtlc response available yet; waiting for LP publish.' }
      )
    );
    return;
  }

  if (req.method === 'POST' && req.url === '/funding') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        fundingData = JSON.parse(body) as FundingData;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/funding') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        fundingData ?? { error: 'No funding data available yet; waiting for USER publish.' }
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
        `📡 USER comm server running on http://localhost:${PORT} (LP will connect via comm client)\n`
      );
      resolve();
    });
  });
}

export function stopCommServer(): Promise<void> {
  if (CLIENT_ROLE !== 'USER') return Promise.resolve();
  if (!server.listening) return Promise.resolve();

  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        return reject(err);
      }
      console.log('📡 USER comm server stopped.');
      resolve();
    });
  });
}

export function publishSubmarineRequest(data: SubmarineRequest): void {
  submarineRequest = data;
  console.log('   📤 Published submarine request for LP retrieval.');
}

export function publishFundingData(data: FundingData): void {
  fundingData = data;
  console.log('   📤 Published funding data for LP retrieval.');
}

export async function waitForRgbInvoiceHtlcResponse(
  maxAttempts: number = 1800,
  pollIntervalMs: number = 2000
): Promise<RgbInvoiceHtlcResponse> {
  for (let i = 0; i < maxAttempts; i++) {
    if (rgbInvoiceHtlcResponse) {
      return rgbInvoiceHtlcResponse;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error('Failed to retrieve rgbinvoicehtlc response.');
}
