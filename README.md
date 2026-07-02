# WriteLens

> Pay-per-call text quality scoring API. Free 50/day, then $0.01/call.

**Live:** https://writelens.ivixivi.workers.dev

## What is WriteLens?

WriteLens scores any text on clarity, coherence, voice consistency, claim density, and
plagiarism-risk markers. Built for editors, content reviewers, and writing tools that
need a fast, cheap quality signal in their pipeline.

By analyzing the text against multiple quality dimensions simultaneously, WriteLens produces a composite score and actionable feedback, letting platforms automatically filter low-effort content or flag high-risk submissions before a human editor needs to get involved.

## Who Pays?

WriteLens is designed for platforms handling user-generated content at scale, as well as editorial teams managing large volume ingestion.

Typical paying customers include:
- **Publishers & Media sites** needing a pre-publish quality gate to filter out AI-generated slop or low-quality freelance submissions.
- **Content marketplaces** validating writer deliverables.
- **EdTech platforms** checking student essays for structure, clarity, and risk markers.
- **Tool builders** integrating quality scoring directly into their own SaaS platforms or editor extensions.

## Installation

WriteLens is a Cloudflare Worker project. You can run it locally or deploy it to your own Cloudflare account.

1. **Clone the repository:**
   ```bash
   git clone https://github.com/4444J99/writelens.git
   cd writelens
   ```

2. **Install dependencies:**
   *(Assuming standard Node/npm environment. If `package.json` is present, run `npm install`. Otherwise, use `wrangler` directly).*
   ```bash
   npm install -g wrangler
   ```

3. **Configure your environment:**
   Create the required KV namespaces and update `wrangler.toml` with your own KV IDs:
   ```bash
   wrangler kv:namespace create "WL_RATE"
   wrangler kv:namespace create "WL_KEYS"
   ```

4. **Deploy:**
   ```bash
   wrangler deploy
   ```

## Usage

WriteLens provides a straightforward REST API.

For complete documentation including authentication, purchasing credits, and key management, please see the [API Documentation](./API.md).

**Quick Start: Score a text payload (Free Tier)**
```bash
curl -X POST https://writelens.ivixivi.workers.dev/v1/score \
  -H "Content-Type: application/json" \
  -d '{"text": "Your text payload goes here. WriteLens will evaluate its clarity, coherence, and more."}'
```

## Pricing & Monetization

WriteLens operates on a usage-based tier model designed to be frictionless for evaluation while scaling seamlessly with production traffic.

- **Free Tier:** 50 scores per day per IP. Perfect for testing the API, local development, or small-scale hobby projects.
- **Metered Tier:** $0.01 per call. Kicks in automatically after the free tier is exhausted. There is a soft cap of $10/day by default to prevent accidental runaway costs until formal billing integration is set up.
- **Volume Tier:** Contact us for custom rates if you anticipate exceeding 100K calls/month. Includes dedicated rate limits and customized SLA.

**Payment Rails Supported:** GitHub Sponsors, crypto, Buy Me a Coffee (BMC), and latent Stripe integration.

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
