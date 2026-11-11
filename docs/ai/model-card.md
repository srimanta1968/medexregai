# MedexRegAI model card

Status: **not yet evaluated.** The evaluation harness (F7.4) is in place. Our default model has not been run against it yet, because the self-hosted model server (Ollama) cannot be started on the development machine until Docker Desktop's image pulls are fixed. Until a run is recorded, every score below is empty, and no claim about model quality should be made from this card.

## Models

| Role | Default model | Where it runs | Configured by |
|---|---|---|---|
| Generation (all six AI steps) | `qwen2.5:7b-instruct` | Ollama in development and test; vLLM (OpenAI-compatible) in production | `AI_GENERATION_MODEL`, per step `AI_ROUTE_MODELS` |
| Embeddings (search) | `bge-m3` (1024 dimensions) | Ollama / TEI | `AI_EMBEDDING_MODEL` |
| Reranking (search, optional) | `bge-reranker-v2-m3` | TEI | `AI_RERANK_URL`, `AI_RERANK_MODEL` |

These are our own self-hosted, open-weight models. A firm can bring its own model with its own API key (F7.1). That model has to pass a connection test before it can be used, and it has to pass this same evaluation before it can be used for drafting.

The route registry version and the prompt template versions are recorded with every run. See `server/src/ai/registry.ts` and `server/src/ai/guard/prompts.ts`.

## Intended use

The models help a 510(k) consultant work through a client's evidence. They can:

- sort files into submission sections, with a reason;
- extract facts with quotes and their locations;
- point out passages that may contradict each other;
- draft section text in which every factual sentence cites a client passage;
- word requests to the client for missing evidence.

The consultant reviews every output. Nothing a model produces is filed, sent or approved without the consultant.

## Out of scope

- Regulatory decisions: substantial equivalence, which testing is needed, or whether a submission is ready.
- Statements that no passage supports. The citation gate removes them, and refuses an answer when nothing cited is left.
- Analysis of raw data beyond describing its structure.
- Acting on what a document says. No AI step has tools, and text in a client file is treated only as content.

## How it is evaluated

Run `npm run eval` in `server/` against the platform model. A firm's model is evaluated from the AI settings page, and the worker does the run. Both go through the product's own prompts, data blocks, output checks and citation gate. The gold sets are in `server/src/ai/eval/sets/`. They come from a fictional package (Fictional Medical Ltd, Demo Catheter DC-100) and contain no client data.

| Set | What is scored | Target | Source of the target |
|---|---|---|---|
| Classification (20 files, 7 sections) | accuracy | at least 90% | PRD v2.0 FR-14.6 |
| Contradictions (10 pairs) | precision of "contradiction" answers; recall reported | precision at least 70% | PRD v2.0 FR-14.8 |
| Drafting (5 sections) | acceptance; citation precision reported | acceptance at least 70% | PRD v2.0 FR-14.10 |
| Prompt injection (14 cases) | resistance | 100% | NFR-16 |
| Version detection (6 pairs) | not run yet | | FR-14.7 (E2) |

In drafting, "accepted" is an automated stand-in for "accepted without material change". A draft counts as accepted only if the citation gate keeps every sentence and every required fact is stated. The consultants' real acceptance rate is measured in the pilot (E4).

## Scores

<!-- eval:scores:start -->
No evaluation recorded yet.
<!-- eval:scores:end -->

## Known limits

- **Gold sets are small and fictional.** Twenty classification items cannot show 90% accuracy with much confidence. They are a regression gate, not a measure of quality on real packages. Real-package sets come from consultant corrections in E2 (FR-14.6).
- **Section names follow the PRD.** They are not yet the eSTAR template's own section names. E2 aligns them.
- **Injection resistance is shown only for the planted cases.** The output checks catch answers that break format, cite passages the model was not given, quote text that is not in the source, contain links, or leak the prompt. They cannot catch a manipulated answer that is still valid, such as a wrong section that is on the allowed list. Consultant review and the citation gate cover that.
- **No OCR in development.** Scanned pages are not read until the Docling build is installed (F7.2). Text in scans is therefore not evaluated.
- **The drafting score is a stand-in.** It measures whether claims are supported and complete, not how well the draft reads.
