import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker from '../src/index';

const mockAI = {
  run: vi.fn().mockResolvedValue({
    response: JSON.stringify({
      clarity: 9,
      persuasiveness: 8,
      structure: 9,
      factuality_concerns: [],
      overall: 9,
      suggestions: ["Keep up the great work!"]
    })
  })
};

const mockPayrail = {
  fetch: vi.fn()
};

const getEnv = () => ({
  ...env,
  AI: mockAI,
  PAYRAIL: mockPayrail,
  ASSETS: { fetch: vi.fn().mockResolvedValue(new Response("Asset Content")) },
});

describe('E2E User Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('completes the full flow: subscribe -> confirm payment -> use metered API key', async () => {
    // 1. User wants to buy credits, requests a quote
    mockPayrail.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      quote_id: "e2e-quote-123",
      pay_to: { rail: "crypto", address: "0xabc", amount: "10" },
      checkout: "https://checkout/e2e",
      instructions: "Pay 10 USDC",
      expires_in_seconds: 600
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const reqSubscribe = new Request('http://localhost/api/subscribe', {
      method: 'POST',
      body: JSON.stringify({ email: 'e2e@example.com' })
    });
    const resSubscribe = await worker.fetch(reqSubscribe, getEnv());
    expect(resSubscribe.status).toBe(402);
    const quoteData = await resSubscribe.json();
    const quoteId = quoteData.quote_id;
    expect(quoteId).toBe('e2e-quote-123');

    // 2. Client might poll for payment status while waiting for the user to pay
    mockPayrail.fetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    const reqPayStatusNotPaid = new Request(`http://localhost/api/pay-status?quote_id=${quoteId}`);
    const resPayStatusNotPaid = await worker.fetch(reqPayStatusNotPaid, getEnv());
    expect(resPayStatusNotPaid.status).toBe(200);
    expect(await resPayStatusNotPaid.json()).toEqual({ paid: false, quote_id: quoteId });

    // 3. User pays on-chain, gets a tx_hash, calls confirm
    // We mock the payrail receipt endpoint to confirm payment
    mockPayrail.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      receipt: { id: "rcpt-e2e" }
    }), { status: 200 }));

    const reqConfirm = new Request('http://localhost/api/confirm', {
      method: 'POST',
      body: JSON.stringify({ quote_id: quoteId, tx_hash: '0x123tx' })
    });
    const resConfirm = await worker.fetch(reqConfirm, getEnv());
    expect(resConfirm.status).toBe(201);
    const confirmData = await resConfirm.json();
    
    expect(confirmData.key).toBeDefined();
    expect(confirmData.id).toBeDefined();
    expect(confirmData.cap_cents).toBe(1000);

    const apiKey = confirmData.key;
    const keyId = confirmData.id;

    // 4. Client polls payment status again after the webhook or UI flow completes
    mockPayrail.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      id: "rcpt-e2e", amount: 10
    }), { status: 200 }));
    const reqPayStatusPaid = new Request(`http://localhost/api/pay-status?quote_id=${quoteId}`);
    const resPayStatusPaid = await worker.fetch(reqPayStatusPaid, getEnv());
    expect(resPayStatusPaid.status).toBe(200);
    const payStatusData = await resPayStatusPaid.json();
    expect(payStatusData.paid).toBe(true);
    expect(payStatusData.receipt).toBeDefined();

    // 5. Check key status
    const reqStatus = new Request(`http://localhost/api/key/${keyId}`);
    const resStatus = await worker.fetch(reqStatus, getEnv());
    expect(resStatus.status).toBe(200);
    const statusData = await resStatus.json();
    expect(statusData.email).toBe('e2e@example.com');
    expect(statusData.cents_owed).toBe(0);
    expect(statusData.call_count).toBe(0);
    expect(statusData.active).toBe(true);

    // 6. Use the key to score some text
    const reqScore = new Request('http://localhost/v1/score', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ text: 'This is my masterpiece document.' })
    });
    const resScore = await worker.fetch(reqScore, getEnv());
    expect(resScore.status).toBe(200);
    const scoreData = await resScore.json();
    
    expect(scoreData.overall).toBe(9);
    expect(scoreData.calls_this_period).toBe(1);
    expect(scoreData.cents_owed).toBe(1);

    // 7. Use the key again to verify meter increments
    const reqScore2 = new Request('http://localhost/v1/score', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ text: 'Another text.' })
    });
    const resScore2 = await worker.fetch(reqScore2, getEnv());
    expect(resScore2.status).toBe(200);
    const scoreData2 = await resScore2.json();
    
    expect(scoreData2.calls_this_period).toBe(2);
    expect(scoreData2.cents_owed).toBe(2);
  });
});
