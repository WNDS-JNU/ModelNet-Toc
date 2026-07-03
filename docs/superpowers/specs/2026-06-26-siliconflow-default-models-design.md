# SiliconFlow Default Models Design

## Goal

Add SiliconFlow free OpenAI-compatible chat models to the ModelNet default registry for the dev stack without committing a real API key or touching production containers.

## Decisions

- Treat the user's "track flow" wording as SiliconFlow, based on the prior provider research and the requested free API key context.
- Add default SiliconFlow models as `openai_compatible` registry entries, not request-scoped runtime candidates.
- Reference the real credential through `api_key_env: SILICONFLOW_API_KEY`; do not store the key in tracked files.
- Pass `SILICONFLOW_API_KEY` only through the dev compose services needed for Router and LiteLLM.
- Use the current SiliconFlow OpenAI-compatible endpoint root `https://api.siliconflow.cn`.
- Include only free chat-capable models from the current SiliconFlow pricing page:
  - `THUDM/GLM-Z1-9B-0414`
  - `tencent/Hunyuan-MT-7B`

## Architecture

The source registry producer owns the default model inventory, so it will append a small set of built-in external provider entries after Kubernetes discovery. The publisher will carry those entries into `capability-registry.yaml`; Router already supports `api_key_env`, while LiteLLM generation needs to preserve model-specific API key references. LobeHub model-list generation must include `openai_compatible` chat models so the new defaults are visible in TOC.

## Safety

Production containers must not be inspected, restarted, recreated, or otherwise touched. Runtime operations are limited to the dev compose stack with `docker-compose.dev.yml` and `docker-compose.registry-dev.yml`.

## Verification

- Unit tests cover default SiliconFlow entries and LiteLLM/LobeHub generated config behavior.
- Python compile checks cover modified scripts.
- Dev registry bundle is published under `/home/duxianghe/modelnet-runtime/registry-dev`.
- Dev-only container refresh is allowed for Router, LiteLLM, and Lobe if needed.
- If `SILICONFLOW_API_KEY` is absent, live SiliconFlow smoke is reported as not verifiable rather than faked.
