# WriteLens

> Pay-per-call text quality scoring API. Free 50/day, then $0.01/call.

**Live:** https://writelens.ivixivi.workers.dev

WriteLens scores any text on clarity, coherence, voice consistency, claim density, and
plagiarism-risk markers. Built for editors, content reviewers, and writing tools that
need a fast, cheap quality signal in their pipeline.

## API

```
POST /api/score             — Score one text payload (returns 5-dimension scores + comments)
POST /api/keys              — Provision an authValue (returns hashed identifier)
GET  /api/usage             — Per-key call count + remaining free tier
GET  /api/status            — System health
```

## Pricing

- Free: 50 scores per day per IP
- Metered: $0.01 / call (soft cap $10 until billing wires up)
- Volume: contact for >100K/mo

**Pay any rail:** GitHub Sponsors, crypto, BMC, latent Stripe.

## Use cases

- CMS pre-publish quality gate
- Editor / content tool integration
- Bulk corpus quality stratification
- Plagiarism / AI-content flagging triage

## Stack

- Cloudflare Workers (compute)
- Cloudflare Workers AI — Llama 3.3 70B
- Cloudflare KV — key registry, rate limiting, accrual ledger
- sha256 hashing of authValues; never store plaintext

## Sister products

WriteLens is part of an intelligence portfolio:

- [PromptScope](https://promptscope.ivixivi.workers.dev) — LLM system-prompt analyzer
- [EdgarFlash](https://edgarflash.ivixivi.workers.dev) — Real-time SEC EDGAR alerts
- [BountyScope](https://bountyscope.ivixivi.workers.dev) — Bug-bounty intel + smart-contract analyzer
- [TrendPulse](https://trendpulse.ivixivi.workers.dev) — Daily emerging-tech digest
- [VulnPulse](https://vulnpulse.ivixivi.workers.dev) — Defender-side CVE feed

## License

MIT — see [LICENSE](./LICENSE).
