import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker from '../src/index';

const mockAI = {
  run: vi.fn().mockResolvedValue({
    response: JSON.stringify({
      clarity: 8,
      persuasiveness: 7,
      structure: 8,
      factuality_concerns: [],
      overall: 8,
      suggestions: ["Good text"]
    })
  })
};

const mockPayrail = {
  fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({
    quote_id: "test-quote",
    pay_to: { rail: "crypto", address: "0x123", amount: "10" },
    checkout: "https://checkout",
    instructions: "Pay here",
    expires_in_seconds: 600
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
};

// Create a custom environment wrapper
const getEnv = () => ({
  ...env,
  AI: mockAI,
  PAYRAIL: mockPayrail,
  ASSETS: { fetch: vi.fn().mockResolvedValue(new Response("Asset Content")) },
});

describe('WriteLens API Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/key/request', () => {
    it('creates a new key with valid email', async () => {
      const request = new Request('http://localhost/api/key/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com' })
      });
      const response = await worker.fetch(request, getEnv());
      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data).toHaveProperty('key');
      expect(data).toHaveProperty('id');
      
      // Verify KV store
      const keysEnv = getEnv().WL_KEYS;
      const stored = await keysEnv.get(`id:${data.id}`);
      expect(stored).toBeTruthy();
      const parsed = JSON.parse(stored!);
      expect(parsed.email).toBe('test@example.com');
      expect(parsed.cap_cents).toBe(1000);
    });

    it('fails with invalid email', async () => {
      const request = new Request('http://localhost/api/key/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'invalid' })
      });
      const response = await worker.fetch(request, getEnv());
      expect(response.status).toBe(400);
    });
  });

  describe('POST /v1/score', () => {
    it('returns a score using free quota (IP-based)', async () => {
      const request = new Request('http://localhost/v1/score', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'cf-connecting-ip': '1.1.1.1'
        },
        body: JSON.stringify({ text: 'This is a test document.' })
      });
      const response = await worker.fetch(request, getEnv());
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty('clarity', 8);
      expect(data).toHaveProperty('overall', 8);
      expect(data).toHaveProperty('quota_remaining', 49);
    });

    it('returns a score using a valid API key', async () => {
      // First create a key
      const reqKey = new Request('http://localhost/api/key/request', {
        method: 'POST',
        body: JSON.stringify({ email: 'test2@example.com' })
      });
      const resKey = await worker.fetch(reqKey, getEnv());
      const { key } = await resKey.json();

      // Now use it
      const request = new Request('http://localhost/v1/score', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify({ text: 'Another test document.' })
      });
      const response = await worker.fetch(request, getEnv());
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty('clarity', 8);
      expect(data).toHaveProperty('calls_this_period', 1);
      expect(data).toHaveProperty('cents_owed', 1);
    });

    it('rejects overly long text', async () => {
      const request = new Request('http://localhost/v1/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'a'.repeat(16001) })
      });
      const response = await worker.fetch(request, getEnv());
      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/subscribe', () => {
    it('returns a payrail quote', async () => {
      const request = new Request('http://localhost/api/subscribe', {
        method: 'POST',
        body: JSON.stringify({ email: 'payer@example.com' })
      });
      const response = await worker.fetch(request, getEnv());
      expect(response.status).toBe(402);
      const data = await response.json();
      expect(data).toHaveProperty('quote_id', 'test-quote');
      expect(mockPayrail.fetch).toHaveBeenCalled();
    });
  });

  describe('POST /api/confirm', () => {
    it('confirms payment and provisions a new metered key', async () => {
      // Setup pending record in KV
      const pendingRecord = { email: 'buyer@example.com', quote_id: 'q-123', credits_to_grant: 1000 };
      await getEnv().WL_KEYS.put('pending:q-123', JSON.stringify(pendingRecord));

      // Mock the receipt fetch response
      mockPayrail.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        receipt: { id: "rcpt-1" }
      }), { status: 200 }));

      const request = new Request('http://localhost/api/confirm', {
        method: 'POST',
        body: JSON.stringify({ quote_id: 'q-123', tx_hash: '0xabc' })
      });
      const response = await worker.fetch(request, getEnv());
      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data).toHaveProperty('key');
      expect(data.tier).toBe('credits');
      expect(data.cap_cents).toBe(1000);
    });

    it('fails if quote is not found in KV', async () => {
      const request = new Request('http://localhost/api/confirm', {
        method: 'POST',
        body: JSON.stringify({ quote_id: 'q-unknown', tx_hash: '0xabc' })
      });
      const response = await worker.fetch(request, getEnv());
      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/key/:id', () => {
    it('returns key status', async () => {
      // Create a key
      const reqKey = new Request('http://localhost/api/key/request', {
        method: 'POST',
        body: JSON.stringify({ email: 'status@example.com' })
      });
      const resKey = await worker.fetch(reqKey, getEnv());
      const { id } = await resKey.json();

      const request = new Request(`http://localhost/api/key/${id}`);
      const response = await worker.fetch(request, getEnv());
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.email).toBe('status@example.com');
      expect(data.active).toBe(true);
    });
  });
});
