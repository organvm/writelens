# WriteLens API Documentation

WriteLens is a pay-per-call text quality scoring API. It provides a single main endpoint for text analysis, and additional endpoints for managing your account and credits.

## Base URL

All API requests should be made to:
`https://writelens.ivixivi.workers.dev`

## Authentication

WriteLens uses Bearer authentication. To access the paid tier (which removes daily IP limits), you must include your API key in the `Authorization` header of your requests:

```http
Authorization: Bearer wl_...
```

If you do not provide an `Authorization` header, your requests will fall back to the **Free Tier**, which is limited to 50 calls per day per IP address.

---

## 1. Score Text

Evaluates the quality of a given text payload. 

**Endpoint:** `POST /v1/score`  
**Auth:** Bearer Token (Optional. Unauthenticated requests use IP-based free tier)

### Request Body (JSON)

| Field | Type | Description |
|-------|------|-------------|
| `text` | string | **Required**. The text to analyze. Maximum length is 16,000 characters. |

### Example Request

```bash
curl -X POST https://writelens.ivixivi.workers.dev/v1/score \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "Your text payload goes here."}'
```

### Response

The response provides scores from 0 to 10 (0=incoherent, 5=passable, 7=publishable, 9=excellent), along with specific concerns and suggestions.

```json
{
  "clarity": 8,
  "persuasiveness": 7,
  "structure": 9,
  "factuality_concerns": [],
  "overall": 8,
  "suggestions": [
    "Consider adding a more compelling conclusion"
  ],
  "char_count": 28,
  "calls_this_period": 142,
  "cents_owed": 142
}
```

*Note: Unauthenticated free-tier requests will return `quota_remaining` instead of `calls_this_period` and `cents_owed`.*

---

## 2. Purchase Credits (Subscribe)

Initiates a $10 USDC credit top-up to purchase 1,000 API calls (1¢ / call).

**Endpoint:** `POST /api/subscribe`  

### Request Body (JSON)

| Field | Type | Description |
|-------|------|-------------|
| `email` | string | **Required**. Your email address for the account. |

### Example Request

```bash
curl -X POST https://writelens.ivixivi.workers.dev/api/subscribe \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com"}'
```

### Response (402 Payment Required)

WriteLens will return payment instructions to send USDC on-chain.

```json
{
  "status": "payment_required",
  "tier": "credits",
  "quote_id": "req_12345",
  "pay_to": {
    "rail": "crypto",
    "chain": "base",
    "asset": "USDC",
    "address": "0xYourPaymentAddress...",
    "amount": "10"
  },
  "checkout": null,
  "instructions": "Send exactly 10 USDC on Base...",
  "expires_in_seconds": 3600,
  "confirm_url": "/api/confirm"
}
```

---

## 3. Confirm Payment & Get API Key

Once you have sent the USDC payment, submit the transaction hash to confirm your payment and receive your API key.

**Endpoint:** `POST /api/confirm`

### Request Body (JSON)

| Field | Type | Description |
|-------|------|-------------|
| `quote_id` | string | **Required**. The `quote_id` received from `/api/subscribe`. |
| `tx_hash` | string | **Required**. The on-chain transaction hash proving your payment. |

### Example Request

```bash
curl -X POST https://writelens.ivixivi.workers.dev/api/confirm \
  -H "Content-Type: application/json" \
  -d '{"quote_id": "req_12345", "tx_hash": "0xabc123..."}'
```

### Response (201 Created)

**IMPORTANT:** Save the `key` value. It will only be shown once and cannot be retrieved later.

```json
{
  "ok": true,
  "tier": "credits",
  "key": "wl_secret_api_key_here",
  "id": "wl_public_id_here",
  "cap_cents": 1000,
  "rate": "$0.01 per call (1¢)",
  "note": "Save this key — shown once. Send to /v1/score as Bearer token.",
  "receipt": { }
}
```

---

## 4. Check Key Status & Balance

Check the usage and active status of your API key.

**Endpoint:** `GET /api/key/:id`  

*(Note: You must use your public `id` returned during confirmation, not your secret `key`.)*

### Example Request

```bash
curl https://writelens.ivixivi.workers.dev/api/key/wl_public_id_here
```

### Response

```json
{
  "id": "wl_public_id_here",
  "email": "you@example.com",
  "active": true,
  "call_count": 142,
  "cents_owed": 142,
  "cap_cents": 1000,
  "created_at": "2023-10-01T12:00:00.000Z"
}
```

---

## 5. Check Payment Status

Poll the status of an ongoing payment to verify if it has settled.

**Endpoint:** `GET /api/pay-status?quote_id=:quote_id`

### Example Request

```bash
curl "https://writelens.ivixivi.workers.dev/api/pay-status?quote_id=req_12345"
```

### Response

```json
{
  "paid": true,
  "receipt": { }
}
```
