/**
 * Monero key derivation and address generation from BIP-39 seed
 *
 * Monero uses Ed25519 with keccak-256 hashing — NOT BIP-32/BIP-44.
 * Private spend key is derived from BIP-39 seed, view key from spend key.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";

// Ed25519 curve order (l)
const CURVE_ORDER =
  7237005577332262213973186563042994240857116359379907606001950938285454250989n;

// Monero base58 constants
const ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ENCODED_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];
const FULL_BLOCK_SIZE = 8;

/** Reduce a 32-byte LE integer modulo the curve order */
function scReduce32(buf: Uint8Array): Uint8Array {
  let n = 0n;
  for (let i = 0; i < 32; i++) {
    n += BigInt(buf[i]) << BigInt(i * 8);
  }
  n = n % CURVE_ORDER;
  const result = new Uint8Array(32);
  let tmp = n;
  for (let i = 0; i < 32; i++) {
    result[i] = Number(tmp & 0xffn);
    tmp >>= 8n;
  }
  return result;
}

/** Compute Ed25519 public key from raw scalar (no SHA-512 hashing) */
function scalarToPublicKey(privateKey: Uint8Array): Uint8Array {
  let scalar = 0n;
  for (let i = 0; i < 32; i++) {
    scalar += BigInt(privateKey[i]) << BigInt(i * 8);
  }
  return ed25519.Point.BASE.multiply(scalar).toBytes();
}

/**
 * Monero base58 encoding — processes in 8-byte blocks (11 chars each).
 * Different from Bitcoin base58check.
 */
function moneroBase58Encode(data: Uint8Array): string {
  const result: string[] = [];
  const fullBlocks = Math.floor(data.length / FULL_BLOCK_SIZE);
  const lastBlockSize = data.length % FULL_BLOCK_SIZE;

  for (let i = 0; i < fullBlocks; i++) {
    const block = data.slice(i * FULL_BLOCK_SIZE, (i + 1) * FULL_BLOCK_SIZE);
    encodeBlock(block, ENCODED_BLOCK_SIZES[FULL_BLOCK_SIZE], result);
  }

  if (lastBlockSize > 0) {
    const block = data.slice(fullBlocks * FULL_BLOCK_SIZE);
    encodeBlock(block, ENCODED_BLOCK_SIZES[lastBlockSize], result);
  }

  return result.join("");
}

function encodeBlock(
  block: Uint8Array,
  encodedSize: number,
  result: string[]
): void {
  let num = 0n;
  for (let j = 0; j < block.length; j++) {
    num = num * 256n + BigInt(block[j]);
  }
  const chars: string[] = new Array(encodedSize).fill(ALPHABET[0]);
  for (let j = encodedSize - 1; j >= 0; j--) {
    chars[j] = ALPHABET[Number(num % 58n)];
    num /= 58n;
  }
  result.push(...chars);
}

export interface MoneroKeys {
  privateSpendKey: string;
  privateViewKey: string;
  publicSpendKey: string;
  publicViewKey: string;
  address: string;
}

/**
 * Derive Monero keys from a BIP-39 seed.
 *
 * 1. HMAC-SHA512(key="monero seed", data=bip39_seed) -> 64 bytes
 * 2. First 32 bytes reduced mod l -> private spend key
 * 3. keccak256(spend_key) reduced mod l -> private view key
 * 4. Public keys via Ed25519 scalar multiplication
 * 5. Address = monero_base58(0x12 || pub_spend || pub_view || checksum)
 */
export function deriveMoneroKeys(seed: Uint8Array): MoneroKeys {
  const derived = hmac(
    sha512,
    new TextEncoder().encode("monero seed"),
    seed
  );

  const privateSpendKey = scReduce32(derived.slice(0, 32));

  const viewKeyHash = keccak_256(privateSpendKey);
  const privateViewKey = scReduce32(viewKeyHash);

  const publicSpendKey = scalarToPublicKey(privateSpendKey);
  const publicViewKey = scalarToPublicKey(privateViewKey);

  // Monero mainnet standard address: 0x12 + pub_spend(32) + pub_view(32) + checksum(4)
  const payload = new Uint8Array(65);
  payload[0] = 0x12;
  payload.set(publicSpendKey, 1);
  payload.set(publicViewKey, 33);

  const checksum = keccak_256(payload).slice(0, 4);

  const fullAddress = new Uint8Array(69);
  fullAddress.set(payload, 0);
  fullAddress.set(checksum, 65);

  const address = moneroBase58Encode(fullAddress);

  return {
    privateSpendKey: Buffer.from(privateSpendKey).toString("hex"),
    privateViewKey: Buffer.from(privateViewKey).toString("hex"),
    publicSpendKey: Buffer.from(publicSpendKey).toString("hex"),
    publicViewKey: Buffer.from(publicViewKey).toString("hex"),
    address,
  };
}
