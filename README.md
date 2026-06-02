# ECMA-LLM Server

Dynamic backend for the **ECMA-LLM multi-agent e-commerce chatbot** thesis prototype.

- **Frontend:** original HTML/CSS UI (unchanged) served from `public/`
- **Backend:** Node.js + TypeScript + Express
- **Structured store:** MySQL (Laragon) via Prisma — orders, billing, catalog, persona, conversation/turn logs
- **Vector store:** Qdrant (Docker) — return / refund / warranty / shipping / account policy chunks
- **LLM framework:** LangChain + LangGraph (sequential A2A pipeline with closed-loop refinement)
- **Chat (dynamic):** per-request **platform + chat model + API key** (OpenAI / Google Gemini / Anthropic Claude)
- **RAG / embeddings (fixed):** OpenAI **`text-embedding-3-small`** only, key from **`OPENAI_API_KEY`** in `.env` (ingest + query must match)

```
 Browser UI  ──fetch /api/chat/stream──►  Express
                                            │
                                            ▼
                                   LangGraph pipeline
                    ┌────────────┬────────────┬────────────┬────────────┬────────────┐
                    │ Controller │ Retriever  │ Generator  │ Persona    │ Evaluator  │── Refiner
                    └────────────┴─────┬──────┴────────────┴────────────┴────┬───────┘
                                       │                                     │
                                       ▼                                     │
                                    Tools                                    │
                              ┌─────────┬──────────┬──────────────┐          │
                              │ Prisma  │ Prisma   │ Qdrant       │          │
                              │ (orders │ (billing │ (policy      │          │
                              │ catalog)│  refunds)│  vector DB)  │          │
                              └─────────┴──────────┴──────────────┘          │
                                                                             ▼
                                                                   loop back to Evaluator
                                                                   if constraints fail
```

---

## Prerequisites

| Tool     | Version  | Notes |
|----------|----------|-------|
| Node.js  | ≥ 20     | comes with Laragon |
| MySQL    | 5.7 / 8  | bundled with Laragon (`root` / empty password) |
| Docker   | any recent | needed for Qdrant (`docker-compose.yml` provided) |
| Chat API key | live key | per-request from UI (OpenAI / Gemini / Anthropic) |
| `OPENAI_API_KEY` | live key | **server `.env` only** — used for policy embeddings (RAG), not for chat when using Gemini/Claude |

> If you do not have Docker, use [Qdrant Cloud](https://cloud.qdrant.io) free tier and set `QDRANT_URL` + `QDRANT_API_KEY` in `.env`.

---

## Setup — step by step

### 1. Create the MySQL database

Open Laragon's **HeidiSQL** or any MySQL client and run:

```sql
CREATE DATABASE ecma_llm CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### 2. Start Qdrant

From `server/`:

```powershell
docker compose up -d
```

This starts Qdrant on `http://127.0.0.1:6333`.

### 3. Install dependencies

```powershell
cd server
npm install
```

### 4. Configure environment

```powershell
copy .env.example .env
```

Open `.env` and:
- Confirm `DATABASE_URL` matches your Laragon MySQL credentials.
- Set **`OPENAI_API_KEY`** for **policy RAG** (fixed `text-embedding-3-small` for ingest + Qdrant query).
- Optional: **`DEMO_USER_ID`** — TheLook `users.id` used when the app still references `demo-user` (default `1`).
- Configure Qdrant (`QDRANT_URL`, `QDRANT_COLLECTION`, etc.).
- **Chat** provider keys are still sent from the UI per session (`platform` + `model` + `apiKey`).

### TheLook dataset (`/dataset`)

Place the exported CSVs at the repo root under `dataset/` (e.g. `thelook_ecommerce.users.csv`, `thelook_ecommerce.orders.csv`, …). The Prisma schema matches **TheLook eCommerce** tables: `users`, `products`, `orders`, `order_items`, `inventory_items`, `distribution_centers`, optional `shop_events`.

- **Import MySQL data:** `npm run import:dataset` (streaming batches; large files supported).
- **Optional analytics events** (very large / slow): `npm run import:dataset -- --events`
- Re-run import any time to **truncate and reload** TheLook tables (persona + conversations are **not** deleted).

### 5. Bootstrap schema + seed + policy index

A single command handles everything:

```powershell
npm run bootstrap
```

Equivalent to:

```powershell
npm run prisma:generate   # Prisma client
npm run prisma:push       # create/update MySQL tables (TheLook schema)
npm run seed              # persona only
npm run import:dataset    # load CSVs from ./dataset into MySQL
npm run ingest            # policy markdown -> Qdrant (OpenAI embeddings)
```

### 6. Start the dev server

```powershell
npm run dev
```

You should see:

```
ECMA-LLM server listening on http://localhost:3001
  UI:       http://localhost:3001/
  Health:   http://localhost:3001/api/health
  Chat:     POST http://localhost:3001/api/chat
  Stream:   POST http://localhost:3001/api/chat/stream
```

Open `http://localhost:3001/` — the original ECMA-LLM UI now runs against the real backend. Agent dots animate live via SSE.

---

## Sanity checks

### Health endpoint

```powershell
curl http://localhost:3001/api/health
```

Expected: `status: healthy` when MySQL + Qdrant + **`openai_rag`** (if you need policy search) are green. Chat keys are not validated here.

### One-shot JSON call

```powershell
curl -X POST http://localhost:3001/api/chat -H "Content-Type: application/json" -d "{\"query\":\"Where is my order ORD-4821?\",\"platform\":\"openai\",\"model\":\"gpt-4o\",\"apiKey\":\"YOUR_CHAT_KEY\"}"
```

### Streaming SSE (what the browser uses)

```powershell
curl -N -X POST http://localhost:3001/api/chat/stream -H "Content-Type: application/json" -d "{\"query\":\"Can I return a product after 35 days?\",\"platform\":\"openai\",\"model\":\"gpt-4o\",\"apiKey\":\"YOUR_CHAT_KEY\"}"
```

You will see one `data: {...}` line per agent step, ending with a `final` event.

---

## Architecture: chat vs RAG (embeddings)

### Chat (dynamic — UI / API request body)

For every request (`/api/chat` or `/api/chat/stream`) the client sends:

- `platform`: `openai` | `gemini` | `anthropic`
- `model`: chat model id (dropdown)
- `apiKey`: **chat** provider key (session storage in the browser; cleared on reload)

JSON agents call `src/llm/jsonCall.ts`:

- **OpenAI GPT‑5.x / o‑series**: **Responses API** (`src/llm/openaiResponses.ts`) — `max_output_tokens`, no `temperature` / `top_p`, JSON prompts must mention “json”.
- **Other chat paths**: LangChain (`src/llm/modelFactory.ts`).

### RAG (fixed — server `.env` only)

- **Embedding model:** always OpenAI **`text-embedding-3-small`** (`src/llm/embeddings.ts`).
- **API key:** always **`process.env.OPENAI_API_KEY`** (not the UI chat key).
- **Ingestion:** `npm run ingest` embeds chunks with the same model and upserts to **`QDRANT_COLLECTION`** (default `policy_chunks`).
- **Query-time:** `searchPolicy()` embeds the user query with the same model/key and searches that collection.
- **Never** mix embedding models or user-provided embedding keys for policy retrieval — mismatch breaks semantic search.

> You can chat with Gemini or Claude while RAG still uses the server OpenAI embedding key, as long as `OPENAI_API_KEY` is set and the collection was ingested with the same embedding model.

---

## File map (only the important bits)

```
server/
├── prisma/
│   ├── schema.prisma           MySQL schema (orders, billing, catalog, persona, turns, agent logs)
│   └── seed.ts                 Seeds the same demo data that lived in the static HTML
├── src/
│   ├── index.ts                Express bootstrap
│   ├── config/env.ts           Zod-validated env
│   ├── db/
│   │   ├── prisma.ts           Prisma client
│   │   └── qdrant.ts           Qdrant client + ensurePolicyCollection()
│   ├── llm/
│   │   ├── modelFactory.ts     Chat model factory (provider-ready)
│   │   ├── embeddings.ts       Fixed OpenAI policy embeddings (text-embedding-3-small)
│   │   ├── openaiResponses.ts  OpenAI Responses API helper (GPT‑5.x / o‑series)
│   │   └── jsonCall.ts         Single-shot JSON-mode LLM call helper
│   ├── tools/
│   │   ├── orderLookup.ts      Prisma -> TheLook orders + line items
│   │   ├── billingLookup.ts    Prisma -> Billing (synthesized at import)
│   │   ├── catalogSearch.ts    Prisma -> TheLook products
│   │   └── policyVectorSearch.ts  Qdrant -> top-K policy chunks
│   ├── agents/
│   │   ├── controller.ts       Intent + entity extraction
│   │   ├── retriever.ts        Routes to tools based on intent
│   │   ├── generator.ts        Drafts a reply using only retrieved facts
│   │   ├── persona.ts          Applies ShopMax brand voice
│   │   ├── evaluator.ts        Factual + policy compliance check
│   │   └── refiner.ts          Final polish + closing line
│   ├── graph/
│   │   ├── state.ts            GraphState type + initialState()
│   │   └── pipeline.ts         LangGraph wiring + conditional refinement loop
│   ├── api/
│   │   ├── chat.ts             POST /api/chat + /api/chat/stream
│   │   └── health.ts           /api/health
│   ├── ingestion/
│   │   ├── policies/*.md       source of truth for policy text
│   │   └── indexPolicies.ts    chunk -> embed -> upsert to Qdrant
│   └── utils/logger.ts         Winston logger
└── public/
    └── index.html              Original UI, JS updated to use SSE
```

---

## Research-contribution hooks (thesis)

Every thesis gap in your paper has a concrete runtime touch-point:

| Gap                             | Where it lives                                   |
|---------------------------------|--------------------------------------------------|
| Deterministic control           | `graph/pipeline.ts` (LangGraph conditional edges) |
| Persona separation              | `PersonaSpec` table + `agents/persona.ts`        |
| Constraint evaluation           | `agents/evaluator.ts` (+ score logged to `turns.evaluation`) |
| Closed-loop refinement          | `routeAfterRefiner` edge; `MAX_REFINEMENT_LOOPS` env |
| Grounded retrieval (structured) | `tools/orderLookup.ts`, `billingLookup.ts`, `catalogSearch.ts` |
| Grounded retrieval (semantic)   | `tools/policyVectorSearch.ts` (Qdrant cosine)    |
| Auditability                    | `AgentLog`, `Turn`, `Conversation` tables        |

---

## Adding another LLM provider later

In `src/llm/modelFactory.ts`, extend the factory:

```ts
if (opts.provider === 'groq') {
  return new ChatGroq({ apiKey, model: opts.model || 'llama-3.3-70b' });
}
```

All agents already read `opts.apiKey` / `opts.model` from `state.runtime`, so no agent code changes are needed.

---

## Troubleshooting

- **`Cannot find module '@prisma/client'`** — run `npm run prisma:generate`.
- **`ECONNREFUSED 127.0.0.1:6333`** — Qdrant container is not up; run `docker compose up -d`.
- **`Access denied for user 'root'`** — update `DATABASE_URL` in `.env` with the correct MySQL password.
- **Invalid API key** — either set `OPENAI_API_KEY` in `.env` or type one into the UI's password field.
- **Policy answers feel generic** — re-run `npm run ingest` after editing any `src/ingestion/policies/*.md`.
