/**
 * PII Scrubber Tests
 *
 * Validates that sensitive patterns are properly redacted,
 * including Supabase keys, Google API keys, and generic base64 secrets.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scrubPII, scrubMemory } from '../src/reasoningbank/utils/pii-scrubber.js';

// Force PII scrubber on (it checks config.governance.pii_scrubber)
// The default config has it enabled, so this should work out of the box.

describe('PII Scrubber', () => {
  it('redacts Supabase JWT keys (eyJhbGciOi...)', () => {
    const text = 'curl -H "apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFiY2RlZmdoaWprbG1ub3BxcnN0IiwidHlwZSI6ImFub24ifQ.abcdefghijklmnopqrstuvwxyz123456" https://example.supabase.co';
    const scrubbed = scrubPII(text);
    assert.ok(!scrubbed.includes('eyJhbGciOi'), `Should redact Supabase JWT key, got: ${scrubbed}`);
    assert.ok(scrubbed.includes('[JWT]'), 'Should replace with [JWT] placeholder');
  });

  it('redacts Supabase project URLs', () => {
    const text = 'connected to https://abcdefghijklmnopqrstu.supabase.co/rest/v1/profiles';
    const scrubbed = scrubPII(text);
    assert.ok(!scrubbed.includes('abcdefghijklmnopqrstu'), `Should redact project ref, got: ${scrubbed}`);
    assert.ok(scrubbed.includes('[SUPABASE_PROJECT].supabase.co'), 'Should replace with placeholder');
  });

  it('redacts Google API keys (AIza...)', () => {
    const text = 'export GOOGLE_API_KEY=AIzaSyA1234567890abcdefghijklmnopqrstuv';
    const scrubbed = scrubPII(text);
    assert.ok(!scrubbed.includes('AIzaSy'), `Should redact Google key, got: ${scrubbed}`);
    assert.ok(scrubbed.includes('[GOOGLE_API_KEY]'), 'Should use Google placeholder');
  });

  it('redacts GitHub App tokens (ghs_...)', () => {
    const text = 'token: ghs_abcdefghijklmnopqrstuvwxyz1234567890';
    const scrubbed = scrubPII(text);
    assert.ok(!scrubbed.includes('ghs_'), `Should redact GitHub App token, got: ${scrubbed}`);
  });

  it('redacts generic long base64 secrets (40+ chars)', () => {
    const text = 'SECRET=aVeryLongBase64EncodedSecretKeyThatIsAtLeast40CharsLong==';
    const scrubbed = scrubPII(text);
    assert.ok(!scrubbed.includes('aVeryLongBase64'), `Should redact long base64, got: ${scrubbed}`);
  });

  it('redacts service_role in URL params', () => {
    const text = 'https://example.com/api?service_role=super_secret_key_123';
    const scrubbed = scrubPII(text);
    assert.ok(!scrubbed.includes('super_secret'), `Should redact service_role param, got: ${scrubbed}`);
    assert.ok(scrubbed.includes('service_role=[REDACTED]'), 'Should use REDACTED placeholder');
  });

  it('redacts Anthropic keys with new format (sk-ant-...)', () => {
    const text = 'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890';
    const scrubbed = scrubPII(text);
    assert.ok(!scrubbed.includes('sk-ant-'), `Should redact Anthropic key, got: ${scrubbed}`);
  });

  it('preserves normal text without false positives', () => {
    const text = 'When working on auth: use JWT refresh tokens with 15-minute expiry.';
    const scrubbed = scrubPII(text);
    assert.equal(scrubbed, text, 'Normal text should not be modified');
  });

  it('scrubMemory scrubs title, description, and content', () => {
    const memory = {
      title: 'Used key eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFiY2RlZmdoaWprbG1ub3BxcnN0IiwidHlwZSI6ImFub24ifQ.abcdefghijklmnopqrstuvwxyz123456',
      description: 'Connected to https://abcdefghijklmnopqrstu.supabase.co',
      content: 'Set GOOGLE_API_KEY=AIzaSyA1234567890abcdefghijklmnopqrstuv',
      tags: ['auth'],
    };
    const scrubbed = scrubMemory(memory);
    assert.ok(!scrubbed.title.includes('eyJhbGciOi'), `Title should be scrubbed, got: ${scrubbed.title}`);
    assert.ok(!scrubbed.description.includes('abcdefghijklmnopqrstu.supabase'), 'Description should be scrubbed');
    assert.ok(!scrubbed.content.includes('AIzaSy'), 'Content should be scrubbed');
    assert.deepEqual(scrubbed.tags, ['auth'], 'Tags should pass through');
  });
});
