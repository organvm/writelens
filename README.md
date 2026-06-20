# WriteLens

> Paid-tier text quality scoring API. Free 50/day, then $49 for 1000 authenticated calls.

**Live:** https://writelens.ivixivi.workers.dev

WriteLens scores any text on clarity, coherence, voice consistency, claim density, and
plagiarism-risk markers. Built for editors, content reviewers, and writing tools that
need a fast, cheap quality signal in their pipeline.

## API

```
POST /v1/score              — Score one text payload
POST /api/subscribe         — Create a Stripe Checkout session for the paid tier
POST /api/checkout/claim    — Verify a paid Checkout session and mint the key once
GET  /api/checkout/status   — Checkout payment/claim status by session_id
GET  /api/license           — Subscription/license status for an API key
GET  /api/key/:id           — Per-key subscription and usage status
POST /api/stripe/webhook    — Stripe subscription lifecycle webhook
```

Paid requests use either `Authorization: Bearer wl_...` or `X-API-Key: wl_...`.
Requests without a key use the free IP-based quota.

## Pricing

- Free: 50 scores per day per IP
- Paid: $49 / 1000 calls for a 30-day paid period
- Volume: contact for >100K/mo

Checkout is backed by Stripe Checkout. Payment confirmation verifies the paid
Checkout Session against Stripe, records the subscription entitlement, and returns
the raw API key once.

## Billing setup

Create a recurring Stripe Price for the $49 / 1000-call plan, then configure:

```
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
```

Set `STRIPE_PRICE_ID` in `wrangler.toml` or as an environment variable. Keep
`PUBLIC_BASE_URL` pointed at the deployed Worker origin so Checkout redirects back
to `/?checkout=success&session_id={CHECKOUT_SESSION_ID}`.

Register the Stripe webhook endpoint:

```
https://writelens.ivixivi.workers.dev/api/stripe/webhook
```

Subscribe it to `checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`,
`invoice.payment_succeeded`, and `invoice.payment_failed`.

## Use cases

- CMS pre-publish quality gate
- Editor / content tool integration
- Bulk corpus quality stratification
- Plagiarism / AI-content flagging triage

## Stack

- Cloudflare Workers (compute)
- Cloudflare Workers AI — Llama 3.3 70B
- Cloudflare KV — key registry, rate limiting, subscription usage ledger
- sha256 hashing of API keys; never store plaintext

## Sister products

WriteLens is part of an intelligence portfolio:

- [PromptScope](https://promptscope.ivixivi.workers.dev) — LLM system-prompt analyzer
- [EdgarFlash](https://edgarflash.ivixivi.workers.dev) — Real-time SEC EDGAR alerts
- [BountyScope](https://bountyscope.ivixivi.workers.dev) — Bug-bounty intel + smart-contract analyzer
- [TrendPulse](https://trendpulse.ivixivi.workers.dev) — Daily emerging-tech digest
- [VulnPulse](https://vulnpulse.ivixivi.workers.dev) — Defender-side CVE feed

## License

MIT — see [LICENSE](./LICENSE).
