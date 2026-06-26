from __future__ import annotations

import json
import re
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


CONTEXT_LIMIT_PATTERN = re.compile(
    r"maximum context length is (?P<limit>\d+) tokens.*?"
    r"requested (?P<requested>\d+) output tokens.*?"
    r"prompt contains (?P<lower_bound>at least )?(?P<input>\d+) input tokens",
    re.IGNORECASE | re.DOTALL,
)


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


def join_message_content(*parts: str) -> str:
    return "\n\n".join(part.strip() for part in parts if part and part.strip())


def candidate_requires_user_assistant_only_messages(candidate: Any) -> bool:
    if getattr(candidate, "backend_type", "") not in OPENAI_CHAT_BACKENDS:
        return False
    metadata = getattr(candidate, "metadata", {}) or {}
    if not isinstance(metadata, dict):
        metadata = {}
    names = [
        getattr(candidate, "model_id", ""),
        getattr(candidate, "backend_model", ""),
        metadata.get("model_family", ""),
        metadata.get("family", ""),
        metadata.get("base_model", ""),
    ]
    return any("gemma" in str(name).lower() for name in names if name is not None)


def chat_content_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict):
                text = part.get("text")
                if text is None:
                    text = part.get("content")
                if text is not None:
                    parts.append(str(text))
            elif part is not None:
                parts.append(str(part))
        return "\n".join(part for part in parts if part)
    return str(content)


def append_alternating_message(messages: list[dict[str, str]], role: str, content: str) -> None:
    normalized_role = "assistant" if role == "assistant" else "user"
    text = content.strip()
    if not text:
        return
    if not messages and normalized_role == "assistant":
        normalized_role = "user"
        text = join_message_content("Assistant context:", text)
    if messages and messages[-1].get("role") == normalized_role:
        messages[-1]["content"] = join_message_content(str(messages[-1].get("content") or ""), text)
        return
    messages.append({"role": normalized_role, "content": text})


def normalize_user_assistant_messages(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    pending_system: list[str] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "user").strip().lower()
        content = chat_content_text(message.get("content")).strip()
        if not content:
            continue
        if role in {"system", "developer"}:
            if out and out[-1].get("role") == "user":
                out[-1]["content"] = join_message_content(str(out[-1].get("content") or ""), content)
            else:
                pending_system.append(content)
            continue

        normalized_role = "assistant" if role == "assistant" else "user"
        if pending_system:
            if normalized_role == "assistant" and out and out[-1].get("role") == "user":
                out[-1]["content"] = join_message_content(
                    str(out[-1].get("content") or ""),
                    *pending_system,
                )
            else:
                content = join_message_content(*pending_system, content)
            pending_system = []
        append_alternating_message(out, normalized_role, content)

    if pending_system:
        append_alternating_message(out, "user", join_message_content(*pending_system))
    return out or [{"role": "user", "content": "Continue."}]


def prepare_chat_body(candidate: Any, body: dict[str, Any]) -> dict[str, Any]:
    if candidate.backend_type == "ollama":
        return openai_chat_to_ollama(candidate, body)

    prepared = dict(body)
    prepared["model"] = candidate.backend_model
    if candidate_requires_user_assistant_only_messages(candidate):
        prepared["messages"] = normalize_user_assistant_messages(list(prepared.get("messages") or []))
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


def context_limit_retry_max_tokens(error_text: str, current_max_tokens: Any) -> int | None:
    match = CONTEXT_LIMIT_PATTERN.search(error_text or "")
    if not match:
        return None
    try:
        context_limit = int(match.group("limit"))
        input_tokens = int(match.group("input"))
        current = int(current_max_tokens)
    except (TypeError, ValueError):
        return None
    if input_tokens >= context_limit:
        return None
    lower_bound = bool(match.group("lower_bound"))
    safety_margin = 512 if lower_bound else 128
    retry_max_tokens = context_limit - input_tokens - safety_margin
    if retry_max_tokens <= 0:
        retry_max_tokens = context_limit - input_tokens - 1
    if lower_bound:
        # vLLM reports only the minimum tokenized prefix needed to prove overflow.
        # Back off aggressively because the real prompt may be much longer.
        retry_max_tokens = min(retry_max_tokens, max(256, current // 2))
    if retry_max_tokens <= 0 or retry_max_tokens >= current:
        return None
    return max(1, retry_max_tokens)


def response_error_detail(response: httpx.Response, limit: int = 800) -> str:
    try:
        text = response.text
    except Exception:  # noqa: BLE001 - best-effort diagnostic text
        text = ""
    return (text or "").replace("\n", "\\n")[:limit]


def raise_status_with_body(response: httpx.Response) -> None:
    if response.status_code < 400:
        return
    detail = response_error_detail(response)
    reason = response.reason_phrase or "Error"
    message = f"{response.status_code} {reason} for {response.request.url}"
    if detail:
        message += f": {detail}"
    raise httpx.HTTPStatusError(message, request=response.request, response=response)


async def post_openai_chat_with_context_retry(
    candidate: Any,
    body: dict[str, Any],
    *,
    http_client: httpx.AsyncClient,
    headers: dict[str, str],
) -> tuple[httpx.Response, dict[str, Any]]:
    request_body = dict(body)
    retry_metadata: dict[str, Any] = {}
    for _attempt in range(12):
        response = await http_client.post(chat_url(candidate), json=request_body, headers=headers)
        if response.status_code < 400:
            return response, retry_metadata
        retry_max_tokens = context_limit_retry_max_tokens(
            response_error_detail(response, limit=2000),
            request_body.get("max_tokens"),
        )
        if retry_max_tokens is None:
            raise_status_with_body(response)
        retry_metadata = {
            "reason": "context_length",
            "original_max_tokens": request_body.get("max_tokens"),
            "retry_max_tokens": retry_max_tokens,
            "backend_error": response_error_detail(response, limit=500),
        }
        request_body["max_tokens"] = retry_max_tokens
    raise_status_with_body(response)
    return response, retry_metadata


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
        metadata = {"usage": ollama_usage(payload)} if isinstance(payload, dict) else {}
        if isinstance(payload, dict) and payload.get("done_reason"):
            metadata["finish_reason"] = str(payload.get("done_reason") or "")
        return {
            "text": str(message.get("content") or "") if isinstance(message, dict) else "",
            "metadata": metadata,
        }

    if candidate.backend_type in OPENAI_CHAT_BACKENDS:
        body = prepare_chat_body(
            candidate,
            {
                "messages": messages,
                "stream": False,
                **params,
            },
        )
        response, retry_metadata = await post_openai_chat_with_context_retry(
            candidate,
            body,
            http_client=http_client,
            headers=headers,
        )
        payload = response.json()
        choice = ((payload.get("choices") or [{}])[0] if isinstance(payload, dict) else {})
        message = choice.get("message") if isinstance(choice, dict) else {}
        metadata = {"usage": payload.get("usage")} if isinstance(payload, dict) else {}
        if isinstance(message, dict):
            reasoning = message.get("reasoning_content") or message.get("reasoning")
            finish_reason = choice.get("finish_reason") if isinstance(choice, dict) else None
            if finish_reason:
                metadata["finish_reason"] = str(finish_reason)
            if reasoning:
                metadata["reasoning_content"] = str(reasoning)
            if retry_metadata:
                metadata["max_tokens_retry"] = retry_metadata
            content = message.get("content", "")
        else:
            content = ""
        return {
            "text": str(content or ""),
            "metadata": metadata,
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
    metadata: dict[str, Any] = {}
    if isinstance(payload, dict):
        if payload.get("stopped_limit"):
            metadata["finish_reason"] = "length"
        elif payload.get("stopped_eos") or payload.get("stopped_word") or payload.get("stop"):
            metadata["finish_reason"] = "stop"
        if payload.get("tokens_predicted") is not None:
            metadata["tokens_predicted"] = payload.get("tokens_predicted")
    return {"text": text, "metadata": metadata}


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
