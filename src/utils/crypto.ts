import { createHash } from 'node:crypto';

/**
 * Compute SHA256 hash of buffer and return as hex string
 */
export function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Convert hex string to buffer
 */
export function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

/**
 * Convert buffer to hex string
 */
export function bufferToHex(buf: Buffer): string {
  return buf.toString('hex');
}

/**
 * Validate hex string format
 */
export function isValidHex(hex: string, expectedLength?: number): boolean {
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    return false;
  }
  
  if (expectedLength !== undefined && hex.length !== expectedLength * 2) {
    return false;
  }
  
  return true;
}

/**
 * Validate pubkey format (33 bytes compressed)
 */
export function isValidCompressedPubkey(hex: string): boolean {
  if (!isValidHex(hex, 33)) {
    return false;
  }
  
  const firstByte = hex.slice(0, 2);
  return firstByte === '02' || firstByte === '03';
}

/**
 * Parse WIF and extract private key (for validation)
 */
export function validateWIF(wif: string): boolean {
  try {
    // Basic WIF validation - 51 or 52 chars and patterns
    return /^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(wif);
  } catch {
    return false;
  }
}
