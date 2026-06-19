# WriteLens

> Paid-tier text quality scoring API. Free 50/day, then $49 for 1000 authenticated calls.

**Live:** https://writelens.ivixivi.workers.dev

WriteLens scores any text on clarity, coherence, voice consistency, claim density, and
plagiarism-risk markers. Built for editors, content reviewers, and writing tools that
need a fast, cheap quality signal in their pipeline.

## API

```
POST /v1/score              — Score one text payload
POST /api/subscribe         — Start paid checkout for a $49 / 1000-call API key
POST /api/confirm           — Confirm payment and mint the API key shown once
GET  /api/key/:id           — Per-key subscription and usage status
GET  /api/pay-status        — Payment receipt status by quote_id
```

Paid requests use either `Authorization: Bearer wl_...` or `X-API-Key: wl_...`.
Requests without a key use the free IP-based quota.

## Pricing

- Free: 50 scores per day per IP
- Paid: $49 / 1000 calls for a 30-day paid period
- Volume: contact for >100K/mo

Checkout is backed by the shared payrail service. Payment confirmation records the
receipt and returns the raw API key once.

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
