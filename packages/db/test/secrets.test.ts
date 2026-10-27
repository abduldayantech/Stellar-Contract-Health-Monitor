import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createSecretBox,
  openDestinationConfig,
  openWebhookConfig,
  sealDestinationConfig,
  parseEncryptionKey,
  sealWebhookConfig,
} from '../src/secrets';

const key = randomBytes(32).toString('base64');

describe('SecretBox', () => {
  it('round-trips values with a random IV each time', () => {
    const box = createSecretBox(key);
    const a = box.seal('whsec_abc');
    const b = box.seal('whsec_abc');
    expect(a).toMatch(/^enc:v1:/);
    expect(a).not.toBe(b);
    expect(box.open(a)).toBe('whsec_abc');
    expect(box.seal(a)).toBe(a); // already sealed
  });

  it('reads legacy plaintext and passes values through when disabled', () => {
    const box = createSecretBox(key);
    expect(box.open('plain')).toBe('plain');
    const off = createSecretBox(undefined);
    expect(off.enabled).toBe(false);
    expect(off.seal('plain')).toBe('plain');
    expect(() => off.open(box.seal('x'))).toThrow(/SECRETS_ENCRYPTION_KEY/);
  });

  it('detects tampering and wrong keys', () => {
    const box = createSecretBox(key);
    const sealed = box.seal('secret');
    const tampered = sealed.slice(0, -4) + (sealed.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => box.open(tampered)).toThrow();
    expect(() => createSecretBox(randomBytes(32).toString('hex')).open(sealed)).toThrow();
  });

  it('accepts hex or base64 keys of 32 bytes only', () => {
    expect(parseEncryptionKey('ab'.repeat(32))).toHaveLength(32);
    expect(parseEncryptionKey(key)).toHaveLength(32);
    expect(() => parseEncryptionKey('too-short')).toThrow(/32 bytes/);
  });

  it('seals only the secret and header values of a webhook config', () => {
    const box = createSecretBox(key);
    const sealed = sealWebhookConfig(box, {
      url: 'https://x',
      secret: 's',
      headers: { Authorization: 'Bearer t' },
    });
    expect(sealed.url).toBe('https://x');
    expect(String(sealed.secret)).toMatch(/^enc:v1:/);
    expect(JSON.stringify(sealed)).not.toContain('Bearer t');
    expect(openWebhookConfig(box, sealed)).toEqual({
      url: 'https://x',
      secret: 's',
      headers: { Authorization: 'Bearer t' },
    });
  });

  it('seals chat webhook URLs and bot tokens', () => {
    const box = createSecretBox(key);
    const config = { webhookUrl: 'https://hooks.slack.com/services/T/B/x', botToken: '1:abc' };
    const sealed = sealDestinationConfig(box, config);
    expect(JSON.stringify(sealed)).not.toContain('hooks.slack.com');
    expect(JSON.stringify(sealed)).not.toContain('1:abc');
    expect(openDestinationConfig(box, sealed)).toEqual(config);
    expect(sealDestinationConfig(box, { to: ['a@b.co'] })).toEqual({ to: ['a@b.co'] });
  });
});
