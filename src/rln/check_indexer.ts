import axios from 'axios';
import { parse } from 'dotenv';
import { readFileSync } from 'fs';

function getIndexerUrlArg(): string {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    throw new Error('Usage: npm run check-indexer -- <indexer_url>');
  }
  return args[0].trim();
}

async function main() {
  try {
    const indexer_url = getIndexerUrlArg();

    const lpEnv = parse(readFileSync('.env.lp'));
    const baseUrl = lpEnv.RLN_BASE_URL_L1 ?? lpEnv.RLN_BASE_URL;
    if (!baseUrl) {
      throw new Error('LP L1 base URL not configured. Set RLN_BASE_URL_L1 in .env.lp');
    }
    const apiKey = lpEnv.RLN_API_KEY_L1 ?? lpEnv.RLN_API_KEY;
    const httpClient = axios.create({
      baseURL: baseUrl,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey && {
          Authorization: `Bearer ${apiKey}`
        })
      }
    });

    const response = await httpClient.post(
      '/checkindexerurl',
      { indexer_url },
      { validateStatus: () => true }
    );

    if (response.status >= 400) {
      console.error(`HTTP ${response.status}: ${JSON.stringify(response.data ?? null)}`);
      process.exitCode = 1;
      return;
    }

    console.log(
      JSON.stringify(
        {
          indexer_url,
          result: response.data
        },
        null,
        2
      )
    );
  } catch (error: any) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}

void main();
