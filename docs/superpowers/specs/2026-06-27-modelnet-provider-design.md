# ModelNet Provider Design

## Goal

Expose ModelNet-supplied models in TOC/Lobe as a first-class model provider named `ModelNet`, rather than as models inside the `OpenAI` provider.

## Design

ModelNet remains OpenAI-compatible at the HTTP layer, but its provider identity becomes `modelnet` throughout the application. The new provider uses the existing ModelNet Router/LiteLLM chain in development and production, so backend routing behavior stays unchanged while the UI, server config, and runtime distinguish ModelNet from OpenAI.

## Components

- `model-bank` defines `ModelProvider.ModelNet`, a ModelNet provider card, and a small built-in model list for `modelnet` and `modelnet-auto`.
- `model-runtime` adds `LobeModelNetAI`, an OpenAI-compatible runtime with provider id `modelnet` and default base URL `http://modelnet-router:8000/v1`.
- Server LLM config reads `ENABLED_MODELNET`, `MODELNET_API_KEY`, and `MODELNET_PROXY_URL`.
- `scripts/sync_modelnet_lobehub.py` writes `MODELNET_API_KEY`, `MODELNET_PROXY_URL`, and `MODELNET_MODEL_LIST` into `.env.modelnet`.
- ModelNet helper logic accepts `modelnet` as the primary provider while retaining `openai` and `lobehub` compatibility for existing sessions.

## Data Flow

The capability registry still produces concrete model ids and display names. The Lobe sync script writes those ids into `MODELNET_MODEL_LIST`. Lobe server config reads the list and exposes an enabled built-in provider `modelnet`. Chat calls with provider `modelnet` initialize `LobeModelNetAI`, which calls the configured ModelNet OpenAI-compatible endpoint.

## Testing

Use TDD for the generator and provider/runtime registration:

- Python unit tests verify `.env.modelnet` content uses `MODELNET_*` keys and preserves aggregate/auto plus concrete models.
- TypeScript unit tests verify `ModelProvider.ModelNet`, provider card registration, runtime map registration, and chat ModelNet gates under provider `modelnet`.
- Existing ModelNet helper tests are updated so parallel/serial controls attach to `modelnet`.

## Out Of Scope

This change does not alter router candidate selection, LiteLLM model generation, Kubernetes backend discovery, or public Aliyun/Tailscale routing.
