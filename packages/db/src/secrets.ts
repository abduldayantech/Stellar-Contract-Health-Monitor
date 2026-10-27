import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';

/**
 * Encrypts secrets stored in the database (webhook signing secrets, custom header values)
 * with AES-256-GCM. Values written before encryption was enabled stay readable and are
 * re-encrypted when next written.
 */
export interface SecretBox {
  /** True when a key is configured; without one, values are stored as given. */
  readonly enabled: boolean;
  seal(value: string): string;
  open(value: string): string;
  isSealed(value: string): boolean;
}

/** Accepts 32 bytes as 64 hex characters or base64 (e.g. `openssl rand -base64 32`). */
export function parseEncryptionKey(material: string): Buffer {
  const trimmed = material.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (key.length !== 32) {
    throw new Error('SECRETS_ENCRYPTION_KEY must be 32 bytes, as 64 hex characters or base64');
  }
  return key;
}

export function createSecretBox(keyMaterial?: string | null): SecretBox {
  const key = keyMaterial ? parseEncryptionKey(keyMaterial) : null;
  const isSealed = (value: string) => value.startsWith(PREFIX);
  return {
    enabled: key !== null,
    isSealed,
    seal(value) {
      if (!key || isSealed(value)) return value;
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return `${PREFIX}${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
    },
    open(value) {
      if (!isSealed(value)) return value;
      if (!key) throw new Error('SECRETS_ENCRYPTION_KEY is required to read encrypted secrets');
      const [iv, tag, data] = value.slice(PREFIX.length).split(':');
      if (!iv || !tag || data === undefined) throw new Error('Malformed encrypted secret');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(data, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}

/** Top-level destination config fields that hold credentials and are encrypted at rest. */
export const SENSITIVE_CONFIG_KEYS = ['secret', 'webhookUrl', 'botToken', 'routingKey'] as const;

function mapSensitive(config: unknown, fn: (v: string) => string): Record<string, unknown> {
  const c = { ...((config ?? {}) as Record<string, unknown>) };
  for (const key of SENSITIVE_CONFIG_KEYS) {
    const value = c[key];
    if (typeof value === 'string') c[key] = fn(value);
  }
  if (c.headers && typeof c.headers === 'object') {
    c.headers = Object.fromEntries(
      Object.entries(c.headers as Record<string, unknown>).map(([k, v]) => [
        k,
        typeof v === 'string' ? fn(v) : v,
      ]),
    );
  }
  return c;
}

/**
 * Encrypts the credential fields of a destination config: webhook secrets and header values,
 * chat webhook URLs and bot tokens. Other fields (and email configs) pass through unchanged.
 */
export function sealDestinationConfig(box: SecretBox, config: unknown): Record<string, unknown> {
  return mapSensitive(config, (v) => box.seal(v));
}

/** Decrypts the fields sealed by `sealDestinationConfig`. */
export function openDestinationConfig(box: SecretBox, config: unknown): Record<string, unknown> {
  return mapSensitive(config, (v) => box.open(v));
}

/** @deprecated Use sealDestinationConfig. */
export const sealWebhookConfig = sealDestinationConfig;
/** @deprecated Use openDestinationConfig. */
export const openWebhookConfig = openDestinationConfig;
