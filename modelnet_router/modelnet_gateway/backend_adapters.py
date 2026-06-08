from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from typing import Any, AsyncIterator

import httpx

from modelnet_gateway.plugins import BACKEND_ADAPTERS


LLAMA_CPP_ALLOWED_BODY_KEYS = {
    "cache_prompt",
    "frequency_penalty",
    "grammar",
    "json_schema",
    "logit_bias",
    "max_tokens",
    "messages",
    "min_p",
    "mirostat",
    "mirostat_eta",
    "mirostat_tau",
    "model",
    "n",
    "presence_penalty",
    "repeat_penalty",
    "response_format",
    "seed",
    "stop",
    "stream",
    "temperature",
    "top_k",
    "top_p",
    "typical_p",
}

OPENAI_CHAT_BACKENDS = {"vllm_chat", "openai_compatible"}
CHAT_BACKENDS = {"vllm_chat", "llama_cpp", "openai_compatible", "ollama"}
ENDPOINT_HEALTH_BACKENDS = {"llama_cpp", "openai_compatible", "ollama"}


@dataclass(frozen=True)
class BackendChatResponse:
    content: bytes
    media_type: str
    status_code: int
    headers: dict[str, str]


def backend_adapter_info(backend_type: str) -> dict[str, Any]:
    return dict(BACKEND_ADAPTERS.get(backend_type, {}))


def endpoint_health_urls(candidate: Any) -> list[str]:
    root_url = candidate.root_url.rstrip("/")
    api_base = candidate.api_base.rstrip("/")
    if candidate.backend_type == "ollama":
        return [root_url + "/api/tags", root_url + "/api/version"]
    if candidate.backend_type in {"llama_cpp", "openai_compatible"}:
        return [root_url + "/health", api_base + "/models"]
    return []


def prepare_chat_body(candidate: Any, body: dict[str, Any]) -> dict[str, Any]:
    if candidate.backend_type == "ollama":
        return openai_chat_to_ollama(candidate, body)

    prepared = dict(body)
    prepared["model"] = candidate.backend_model
    if candidate.backend_type == "llama_cpp":
        prepared = {
            key: value
            for key, value in prepared.items()
            if key in LLAMA_CPP_ALLOWED_BODY_KEYS or key.startswith("mirostat")
        }
        prepared["model"] = candidate.backend_model
    return prepared


def chat_url(candidate: Any) -> str:
    if candidate.backend_type == "ollama":
        return candidate.root_url.rstrip("/") + "/api/chat"
    return candidate.api_base.rstrip("/") + "/chat/completions"


def response_should_cooldown(status_code: int) -> bool:
    return status_code >= 500 or status_code in {408, 409, 425, 429}


async def chat_response(
    candidate: Any,
    body: dict[str, Any],
    *,
    http_client: httpx.AsyncClient,
    headers: dict[str, str],
) -> BackendChatResponse:
    prepared = prepare_chat_body(candidate, body)
    response = await http_client.post(chat_url(candidate), json=prepared, headers=headers)
    if candidate.backend_type == "ollama" and response.status_code < 400:
        content = json.dumps(
            ollama_chat_to_openai(candidate, response.json()),
            ensure_ascii=False,
        ).encode("utf-8")
        return BackendChatResponse(
            content=content,
            media_type="application/json",
            status_code=200,
            headers={},
        )
    return BackendChatResponse(
        content=response.content,
        media_type=response.headers.get("content-type", "application/json"),
        status_code=response.status_code,
        headers=dict(response.headers),
    )


async def stream_chat(
    candidate: Any,
    body: dict[str, Any],
    *,
    http_client: httpx.AsyncClient,
    headers: dict[str, str],
) -> AsyncIterator[bytes]:
    prepared = prepare_chat_body(candidate, body)
    async with http_client.stream("POST", chat_url(candidate), json=prepared, headers=headers) as response:
        if response.status_code >= 400:
            detail = (await response.aread()).decode("utf-8", errors="replace")[:500]
            raise httpx.HTTPStatusError(
                f"{response.status_code} {response.reason_phrase} for {chat_url(candidate)}: {detail}",
                request=response.request,
                response=response,
            )
        if candidate.backend_type == "ollama":
            async for chunk in stream_ollama_as_openai(candidate, response):
                yield chunk
            return
        async for chunk in response.aiter_bytes():
            yield chunk


async def generate_text(
    candidate: Any,
    source: Any,
    *,
    params: dict[str, Any],
    messages: list[dict[str, Any]],
    prompt: str,
    http_client: httpx.AsyncClient,
    headers: dict[str, str],
) -> dict[str, Any]:
    if candidate.backend_type == "ollama":
        body = openai_chat_to_ollama(
            candidate,
            {
                "messages": messages,
                "stream": False,
                **params,
            },
        )
        response = await http_client.post(chat_url(candidate), json=body, headers=headers)
        response.raise_for_status()
        payload = response.json()
        message = payload.get("message") if isinstance(payload, dict) else {}
        return {
            "text": str(message.get("content") or "") if isinstance(message, dict) else "",
            "metadata": {"usage": ollama_usage(payload)} if isinstance(payload, dict) else {},
        }

    if candidate.backend_type in OPENAI_CHAT_BACKENDS:
        body = {
            "model": candidate.backend_model,
            "messages": messages,
            "stream": False,
            **params,
        }
        response = await http_client.post(chat_url(candidate), json=body, headers=headers)
        response.raise_for_status()
        payload = response.json()
        choice = ((payload.get("choices") or [{}])[0] if isinstance(payload, dict) else {})
        message = choice.get("message") if isinstance(choice, dict) else {}
        return {
            "text": message.get("content", "") if isinstance(message, dict) else "",
            "metadata": {"usage": payload.get("usage")} if isinstance(payload, dict) else {},
        }

    body = {
        "prompt": prompt,
        "stream": False,
        **params,
    }
    response = await http_client.post(
        candidate.root_url.rstrip("/") + "/completion",
        json=body,
        headers=headers,
    )
    response.raise_for_status()
    payload = response.json()
    text = ""
    if isinstance(payload, dict):
        text = str(payload.get("content") or payload.get("text") or "")
    return {"text": text, "metadata": {}}


def openai_chat_to_ollama(candidate: Any, body: dict[str, Any]) -> dict[str, Any]:
    options: dict[str, Any] = {}
    option_map = {
        "temperature": "temperature",
        "top_p": "top_p",
        "top_k": "top_k",
        "seed": "seed",
    }
    for openai_key, ollama_key in option_map.items():
        if body.get(openai_key) is not None:
            options[ollama_key] = body[openai_key]
    max_tokens = body.get("max_tokens") or body.get("max_completion_tokens")
    if max_tokens is not None:
        options["num_predict"] = max_tokens
    if body.get("stop") is not None:
        options["stop"] = body["stop"]

    payload: dict[str, Any] = {
        "model": candidate.backend_model,
        "messages": normalize_ollama_messages(list(body.get("messages") or [])),
        "stream": bool(body.get("stream")),
    }
    if options:
        payload["options"] = options
    response_format = body.get("response_format")
    if isinstance(response_format, dict) and response_format.get("type") == "json_object":
        payload["format"] = "json"
    if body.get("format") is not None:
        payload["format"] = body["format"]
    return payload


def normalize_ollama_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "user")
        content = message.get("content")
        images: list[str] = []
        if isinstance(content, list):
            parts: list[str] = []
            for part in content:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "text":
                    parts.append(str(part.get("text") or ""))
                elif part.get("type") == "image_url":
                    image_url = part.get("image_url")
                    if isinstance(image_url, dict):
                        url = str(image_url.get("url") or "")
                        if url.startswith("data:image/") and "," in url:
                            images.append(url.split(",", 1)[1])
            content = "\n".join(part for part in parts if part)
        payload = {"role": role, "content": str(content or "")}
        if images:
            payload["images"] = images
        out.append(payload)
    return out


def ollama_chat_to_openai(candidate: Any, payload: dict[str, Any]) -> dict[str, Any]:
    message = payload.get("message") if isinstance(payload, dict) else {}
    content = message.get("content", "") if isinstance(message, dict) else ""
    return {
        "id": "chatcmpl-" + uuid.uuid4().hex,
        "object": "chat.completion",
        "created": int(time.time()),
        "model": candidate.model_id,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop" if payload.get("done", True) else None,
            }
        ],
        "usage": ollama_usage(payload),
    }


def ollama_usage(payload: dict[str, Any]) -> dict[str, int]:
    usage: dict[str, int] = {}
    if "prompt_eval_count" in payload:
        usage["prompt_tokens"] = int(payload.get("prompt_eval_count") or 0)
    if "eval_count" in payload:
        usage["completion_tokens"] = int(payload.get("eval_count") or 0)
    if usage:
        usage["total_tokens"] = usage.get("prompt_tokens", 0) + usage.get("completion_tokens", 0)
    return usage


async def stream_ollama_as_openai(candidate: Any, response: httpx.Response) -> AsyncIterator[bytes]:
    stream_id = "chatcmpl-" + uuid.uuid4().hex
    created = int(time.time())
    async for line in response.aiter_lines():
        if not line.strip():
            continue
        payload = json.loads(line)
        message = payload.get("message") if isinstance(payload, dict) else {}
        delta = message.get("content", "") if isinstance(message, dict) else ""
        if delta:
            yield openai_stream_chunk(
                stream_id,
                created,
                candidate.model_id,
                {"content": delta},
                finish_reason=None,
            )
        if payload.get("done"):
            yield openai_stream_chunk(
                stream_id,
                created,
                candidate.model_id,
                {},
                finish_reason="stop",
                usage=ollama_usage(payload),
            )
            yield b"data: [DONE]\n\n"


def openai_stream_chunk(
    stream_id: str,
    created: int,
    model: str,
    delta: dict[str, Any],
    *,
    finish_reason: str | None,
    usage: dict[str, Any] | None = None,
) -> bytes:
    payload: dict[str, Any] = {
        "id": stream_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": delta,
                "finish_reason": finish_reason,
            }
        ],
    }
    if usage:
        payload["usage"] = usage
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")
