#!/usr/bin/env python3
"""Produce the ModelNet capability registry from Kubernetes routes.

This is the standalone replacement for the old Dify-owned K8s discovery
path. It discovers externally reachable OpenAI-compatible backends from
Kubernetes Ingress and NodePort Services, probes ``/v1/models``, and writes
``capability-registry.yaml`` as the source-of-truth consumed by dev bundles.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import ssl
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from operator import itemgetter
from pathlib import Path
from typing import Any, TypedDict
from urllib.error import HTTPError
from urllib.parse import quote, urlparse, urlunparse
from urllib.request import Request, urlopen

import yaml

import publish_modelnet_registry


DEFAULT_OUTPUT = Path("/home/duxianghe/modelnet-runtime/registry-source/capability-registry.yaml")
DEFAULT_STATUS_OUTPUT = Path("/home/duxianghe/modelnet-runtime/registry-source/status.json")


class RouteCandidate(TypedDict, total=False):
    namespace: str
    ingress: str
    host: str
    path: str
    base_url: str
    service_name: str
    service_port: str
    node_port: str
    service_type: str
    backend: str


class SkippedRoute(RouteCandidate, total=False):
    reason: str
    status_code: int
    error: str


class DiscoveryResult(TypedDict):
    generated_at: str
    models: list[dict[str, Any]]
    candidates: list[RouteCandidate]
    skipped: list[SkippedRoute]


@dataclass(frozen=True)
class K8sDiscoverySettings:
    namespaces: tuple[str, ...]
    kubeconfig_path: str | None = None
    nodeport_host: str | None = None
    probe_timeout_seconds: float = 10.0
    route_default_scheme: str = "https"
    default_backend: str = "vllm_chat"
    request_timeout_ms: int = 180000


@dataclass(frozen=True)
class KubernetesAuth:
    server: str
    token: str | None
    verify: bool | str | ssl.SSLContext


DEFAULT_EXTERNAL_MODELS: tuple[dict[str, Any], ...] = (
    {
        "id": "siliconflow-thudm-glm-z1-9b-0414",
        "backend": "openai_compatible",
        "model_name": "THUDM/GLM-Z1-9B-0414",
        "model_url": "https://api.siliconflow.cn",
        "api_key_env": "SILICONFLOW_API_KEY",
        "EOS": "<|endoftext|>",
        "type": "normal",
        "request_timeout_ms": 180000,
        "capabilities": ["chat", "text_generation"],
        "provider": "siliconflow",
        "cost_weight": "free",
    },
    {
        "id": "siliconflow-tencent-hunyuan-mt-7b",
        "backend": "openai_compatible",
        "model_name": "tencent/Hunyuan-MT-7B",
        "model_url": "https://api.siliconflow.cn",
        "api_key_env": "SILICONFLOW_API_KEY",
        "EOS": "<|eos|>",
        "type": "normal",
        "request_timeout_ms": 180000,
        "capabilities": ["chat", "text_generation"],
        "provider": "siliconflow",
        "cost_weight": "free",
    },
)


def default_external_models() -> list[dict[str, Any]]:
    return [dict(model) for model in DEFAULT_EXTERNAL_MODELS]


DEFAULT_EXTERNAL_MODEL_IDS = {str(model["id"]) for model in DEFAULT_EXTERNAL_MODELS}


class RegistrySourceError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def parse_namespaces(raw: str | list[str] | tuple[str, ...] | None) -> tuple[str, ...]:
    if raw is None:
        return ()
    values = raw.split(",") if isinstance(raw, str) else list(raw)
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        namespace = str(value).strip()
        if not namespace or namespace in seen:
            continue
        seen.add(namespace)
        out.append(namespace)
    return tuple(out)


def _ssl_context_from_ca_data(value: str) -> ssl.SSLContext:
    decoded = base64.b64decode(value).decode("utf-8")
    return ssl.create_default_context(cadata=decoded)


def _load_kubeconfig(path: str) -> KubernetesAuth:
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    current_context_name = raw.get("current-context")
    contexts = {
        item.get("name"): item.get("context", {})
        for item in raw.get("contexts", [])
        if isinstance(item, dict)
    }
    context = contexts.get(current_context_name)
    if not isinstance(context, dict):
        raise RegistrySourceError("kubeconfig current-context not found")

    cluster_name = context.get("cluster")
    user_name = context.get("user")
    clusters = {
        item.get("name"): item.get("cluster", {})
        for item in raw.get("clusters", [])
        if isinstance(item, dict)
    }
    users = {
        item.get("name"): item.get("user", {})
        for item in raw.get("users", [])
        if isinstance(item, dict)
    }
    cluster = clusters.get(cluster_name)
    user = users.get(user_name, {})
    if not isinstance(cluster, dict) or not cluster.get("server"):
        raise RegistrySourceError("kubeconfig cluster server not found")
    if not isinstance(user, dict):
        user = {}

    verify: bool | str | ssl.SSLContext = True
    if cluster.get("insecure-skip-tls-verify") is True:
        verify = False
    elif isinstance(cluster.get("certificate-authority"), str):
        verify = cluster["certificate-authority"]
    elif isinstance(cluster.get("certificate-authority-data"), str):
        verify = _ssl_context_from_ca_data(cluster["certificate-authority-data"])

    token: str | None = None
    if isinstance(user.get("token"), str):
        token = user["token"]
    elif isinstance(user.get("tokenFile"), str):
        token = Path(user["tokenFile"]).read_text(encoding="utf-8").strip()

    return KubernetesAuth(server=str(cluster["server"]).rstrip("/"), token=token, verify=verify)


def _load_in_cluster_auth() -> KubernetesAuth:
    host = os.getenv("KUBERNETES_SERVICE_HOST")
    port = os.getenv("KUBERNETES_SERVICE_PORT", "443")
    if not host:
        raise RegistrySourceError("KUBERNETES_SERVICE_HOST is not set")

    token_path = Path("/var/run/secrets/kubernetes.io/serviceaccount/token")
    ca_path = Path("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt")
    token = token_path.read_text(encoding="utf-8").strip() if token_path.exists() else None
    verify: bool | str = str(ca_path) if ca_path.exists() else True
    return KubernetesAuth(server=f"https://{host}:{port}", token=token, verify=verify)


class KubernetesDiscoveryClient:
    def __init__(self, settings: K8sDiscoverySettings):
        self._settings = settings
        if settings.kubeconfig_path:
            self._auth = _load_kubeconfig(settings.kubeconfig_path)
        else:
            self._auth = _load_in_cluster_auth()

    def _list_items(self, url: str) -> list[dict[str, Any]]:
        headers = {"Accept": "application/json"}
        if self._auth.token:
            headers["Authorization"] = f"Bearer {self._auth.token}"

        payload = http_get_json(
            url,
            headers=headers,
            timeout_seconds=self._settings.probe_timeout_seconds,
            verify=self._auth.verify,
        )
        items = payload.get("items", [])
        if not isinstance(items, list):
            return []
        return [item for item in items if isinstance(item, dict)]

    def list_ingresses(self, namespace: str) -> list[dict[str, Any]]:
        ns = quote(namespace, safe="")
        url = f"{self._auth.server}/apis/networking.k8s.io/v1/namespaces/{ns}/ingresses"
        return self._list_items(url)

    def list_services(self, namespace: str) -> list[dict[str, Any]]:
        ns = quote(namespace, safe="")
        url = f"{self._auth.server}/api/v1/namespaces/{ns}/services"
        return self._list_items(url)


def _route_scheme(host: str, tls_hosts: set[str], default_scheme: str) -> str:
    if host in tls_hosts or "*" in tls_hosts:
        return "https"
    scheme = default_scheme.strip().lower()
    return scheme if scheme in {"http", "https"} else "https"


def _build_base_url(scheme: str, host: str, path: str) -> str:
    clean_path = path if path.startswith("/") else f"/{path}"
    if clean_path != "/":
        clean_path = clean_path.rstrip("/")
    return urlunparse((scheme, host, "" if clean_path == "/" else clean_path, "", "", ""))


def _service_ref(path_item: dict[str, Any]) -> tuple[str, str]:
    backend = path_item.get("backend")
    if not isinstance(backend, dict):
        return "", ""
    service = backend.get("service")
    if not isinstance(service, dict):
        return "", ""
    name = service.get("name")
    port = service.get("port")
    port_value = ""
    if isinstance(port, dict):
        if port.get("number") is not None:
            port_value = str(port["number"])
        elif port.get("name") is not None:
            port_value = str(port["name"])
    return str(name or ""), port_value


def iter_ingress_routes(
    namespace: str,
    ingress: dict[str, Any],
    *,
    default_scheme: str,
) -> list[RouteCandidate]:
    metadata = ingress.get("metadata") if isinstance(ingress.get("metadata"), dict) else {}
    spec = ingress.get("spec") if isinstance(ingress.get("spec"), dict) else {}
    ingress_name = str(metadata.get("name") or "")

    tls_hosts: set[str] = set()
    tls_items = spec.get("tls")
    if isinstance(tls_items, list):
        for item in tls_items:
            if not isinstance(item, dict):
                continue
            hosts = item.get("hosts")
            if isinstance(hosts, list):
                tls_hosts.update(str(host) for host in hosts if host)

    routes: list[RouteCandidate] = []
    rules = spec.get("rules")
    if not isinstance(rules, list):
        return routes

    for rule in rules:
        if not isinstance(rule, dict):
            continue
        host = str(rule.get("host") or "").strip()
        http = rule.get("http")
        paths = http.get("paths") if isinstance(http, dict) else None
        if not host or not isinstance(paths, list):
            continue
        scheme = _route_scheme(host, tls_hosts, default_scheme)
        for path_item in paths:
            if not isinstance(path_item, dict):
                continue
            path = str(path_item.get("path") or "/")
            service_name, service_port = _service_ref(path_item)
            routes.append(
                RouteCandidate(
                    namespace=namespace,
                    ingress=ingress_name,
                    host=host,
                    path=path,
                    base_url=_build_base_url(scheme, host, path),
                    service_name=service_name,
                    service_port=service_port,
                )
            )
    return routes


def _metadata(item: dict[str, Any]) -> dict[str, Any]:
    metadata = item.get("metadata")
    return metadata if isinstance(metadata, dict) else {}


def _spec(item: dict[str, Any]) -> dict[str, Any]:
    spec = item.get("spec")
    return spec if isinstance(spec, dict) else {}


def _name(item: dict[str, Any]) -> str:
    return str(_metadata(item).get("name") or "")


def _service_type(service: dict[str, Any]) -> str:
    return str(_spec(service).get("type") or "")


def _nodeport_backend(namespace: str, default_backend: str) -> str:
    if namespace == "llama-cpp":
        return "llama_cpp"
    return default_backend


def _nodeport_base_url(raw_host: str, node_port: str) -> tuple[str, str]:
    host = raw_host.strip().rstrip("/")
    parsed = urlparse(host)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        scheme = parsed.scheme
        netloc = parsed.netloc
    else:
        scheme = "http"
        netloc = host
    return urlunparse((scheme, f"{netloc}:{node_port}", "", "", "", "")), netloc


def iter_nodeport_service_routes(
    namespace: str,
    service: dict[str, Any],
    *,
    nodeport_host: str,
    default_backend: str,
) -> list[RouteCandidate]:
    if _service_type(service) != "NodePort":
        return []

    service_name = _name(service)
    routes: list[RouteCandidate] = []
    for port in _spec(service).get("ports", []) or []:
        if not isinstance(port, dict) or port.get("nodePort") is None:
            continue
        node_port = str(port["nodePort"])
        service_port = str(port.get("port") or port.get("name") or "")
        base_url, host = _nodeport_base_url(nodeport_host, node_port)
        routes.append(
            RouteCandidate(
                namespace=namespace,
                host=host,
                path="/",
                base_url=base_url,
                service_name=service_name,
                service_port=service_port,
                node_port=node_port,
                service_type="NodePort",
                backend=_nodeport_backend(namespace, default_backend),
            )
        )
    return routes


def build_probe_url(raw: str) -> str | None:
    try:
        parsed = urlparse(raw)
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    path = parsed.path.rstrip("/")
    if not path:
        probe_path = "/v1/models"
    elif path.endswith("/v1/models"):
        probe_path = path
    elif path.endswith("/v1"):
        probe_path = f"{path}/models"
    else:
        probe_path = f"{path}/v1/models"
    return urlunparse((parsed.scheme, parsed.netloc, probe_path, "", "", ""))


def extract_first_model_id(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    data = payload.get("data")
    if isinstance(data, list) and data:
        first = data[0]
        if isinstance(first, dict) and isinstance(first.get("id"), str) and first["id"]:
            return first["id"]
    models = payload.get("models")
    if isinstance(models, list) and models:
        first = models[0]
        if isinstance(first, dict) and isinstance(first.get("name"), str) and first["name"]:
            return first["name"]
    return None


def ssl_context_from_verify(verify: bool | str | ssl.SSLContext) -> ssl.SSLContext | None:
    if isinstance(verify, ssl.SSLContext):
        return verify
    if verify is False:
        return ssl._create_unverified_context()  # noqa: SLF001
    if isinstance(verify, str):
        return ssl.create_default_context(cafile=verify)
    return None


def http_get_json(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    timeout_seconds: float,
    verify: bool | str | ssl.SSLContext = True,
) -> Any:
    request = Request(url, headers=headers or {}, method="GET")
    try:
        with urlopen(request, timeout=timeout_seconds, context=ssl_context_from_verify(verify)) as response:
            raw = response.read().decode("utf-8")
    except HTTPError as exc:
        raise RegistrySourceError(f"HTTP {exc.code} from {url}") from exc
    return json.loads(raw)


def probe_model_name(base_url: str, timeout_seconds: float) -> str:
    probe_url = build_probe_url(base_url)
    if probe_url is None:
        raise RegistrySourceError("base_url is not an http(s) URL")

    payload = http_get_json(probe_url, timeout_seconds=timeout_seconds)

    model_name = extract_first_model_id(payload)
    if not model_name:
        raise RegistrySourceError("no model id in /v1/models response")
    return model_name


def _slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "model"


def alias_for_route(route: RouteCandidate) -> str:
    path = route.get("path")
    if path and path != "/":
        identity = path
    else:
        identity = route.get("service_name") or route.get("host") or "model"
    return _slug(f"{route.get('namespace', '')}-{identity}")


def infer_model_metadata(model_name: str, route_path: str = "") -> dict[str, Any]:
    key = f"{model_name} {route_path}".lower()
    eos = "<|end_of_text|>"
    model_type = "normal"
    stop_think: str | None = None

    if "qwen" in key or "kimi" in key:
        eos = "<|im_end|>"
    if "glm" in key:
        eos = "<|endoftext|>"
    if "hunyuan" in key:
        eos = "<|eos|>"
    if "phi" in key or "gpt-oss" in key:
        eos = "<|end|>"
    if "mistral" in key or "ministral" in key:
        eos = "</s>"

    if "gpt-oss" in key:
        model_type = "think"
        stop_think = "final<|message|>"
    elif "deepseek-r1" in key or "deepseek_r1" in key or ("qwen3" in key and "instruct" not in key):
        model_type = "think"
        stop_think = "</think>"

    return {
        "EOS": eos,
        "type": model_type,
        "stop_think": stop_think,
    }


def build_model_entry(route: RouteCandidate, model_name: str, settings: K8sDiscoverySettings) -> dict[str, Any]:
    metadata = infer_model_metadata(model_name, route.get("path", ""))
    entry: dict[str, Any] = {
        "id": alias_for_route(route),
        "backend": route.get("backend") or settings.default_backend,
        "model_name": model_name,
        "model_url": route["base_url"],
        "EOS": metadata["EOS"],
        "type": metadata["type"],
        "request_timeout_ms": settings.request_timeout_ms,
    }
    if metadata["stop_think"]:
        entry["stop_think"] = metadata["stop_think"]
    return entry


def discover_model_registry(
    settings: K8sDiscoverySettings,
    *,
    client: Any | None = None,
    probe_func: Any | None = None,
) -> DiscoveryResult:
    generated_at = utc_now()
    candidates: list[RouteCandidate] = []
    skipped: list[SkippedRoute] = []
    models: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    seen_ids: set[str] = set()

    if not settings.namespaces:
        return DiscoveryResult(
            generated_at=generated_at,
            models=default_external_models(),
            candidates=[],
            skipped=[],
        )

    k8s = client or KubernetesDiscoveryClient(settings)
    probe = probe_func or probe_model_name

    def accept_route(route: RouteCandidate) -> None:
        base_url = route["base_url"]
        if base_url in seen_urls:
            return
        seen_urls.add(base_url)
        candidates.append(route)
        try:
            model_name = probe(base_url, settings.probe_timeout_seconds)
            entry = build_model_entry(route, model_name, settings)
        except Exception as exc:
            skipped.append(SkippedRoute(**route, reason="probe_failed", error=str(exc)))
            return

        alias = entry["id"]
        if alias in seen_ids:
            suffix = _slug(route.get("service_name") or route.get("host", "route"))
            entry["id"] = f"{alias}-{suffix}"
        seen_ids.add(entry["id"])
        models.append(entry)

    for namespace in settings.namespaces:
        try:
            ingresses = k8s.list_ingresses(namespace)
        except Exception as exc:
            skipped.append(SkippedRoute(namespace=namespace, reason="list_ingresses_failed", error=str(exc)))
            ingresses = []

        for ingress in ingresses:
            for route in iter_ingress_routes(
                namespace,
                ingress,
                default_scheme=settings.route_default_scheme,
            ):
                accept_route(route)

        try:
            services = k8s.list_services(namespace)
        except Exception as exc:
            skipped.append(SkippedRoute(namespace=namespace, reason="list_services_failed", error=str(exc)))
            services = []

        for service in services:
            if _service_type(service) != "NodePort":
                continue
            service_name = _name(service)
            if not settings.nodeport_host:
                skipped.append(
                    SkippedRoute(
                        namespace=namespace,
                        service_name=service_name,
                        service_type="NodePort",
                        reason="nodeport_host_missing",
                    )
                )
                continue
            routes = iter_nodeport_service_routes(
                namespace,
                service,
                nodeport_host=settings.nodeport_host,
                default_backend=settings.default_backend,
            )
            if not routes:
                skipped.append(
                    SkippedRoute(
                        namespace=namespace,
                        service_name=service_name,
                        service_type="NodePort",
                        reason="nodeport_missing",
                    )
                )
                continue
            for route in routes:
                accept_route(route)

    for entry in default_external_models():
        model_id = str(entry.get("id") or "").strip()
        if not model_id or model_id in seen_ids:
            continue
        seen_ids.add(model_id)
        models.append(entry)

    models.sort(key=itemgetter("id"))
    return DiscoveryResult(generated_at=generated_at, models=models, candidates=candidates, skipped=skipped)


def render_registry_yaml(models: list[dict[str, Any]], generated_at: str) -> str:
    body = publish_modelnet_registry.render_capability_registry(
        {"models": models},
        generated_at=generated_at,
        version=generated_at,
        source="kubernetes-discovery",
    )
    return (
        "# ModelNet capability registry - generated from Kubernetes discovery.\n"
        f"# Generated: {generated_at}\n"
        "# Source producer: scripts/modelnet_registry_source.py\n"
        f"{body}"
    )


def validate_registry_yaml(text: str) -> None:
    try:
        payload = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise RegistrySourceError(f"generated registry is not valid YAML: {exc}") from exc
    if not isinstance(payload, dict):
        raise RegistrySourceError("generated registry top-level value must be a mapping")
    models = payload.get("models")
    if not isinstance(models, list) or not models:
        raise RegistrySourceError("generated registry must contain a non-empty models list")
    schema_version = payload.get("schema_version")
    if schema_version is not None and schema_version != "modelnet.capabilities.v1":
        raise RegistrySourceError(f"generated capability registry has unexpected schema_version: {schema_version}")
    required = {"id", "backend", "model_name", "model_url"}
    for index, model in enumerate(models):
        if not isinstance(model, dict):
            raise RegistrySourceError(f"model entry {index} must be a mapping")
        missing = sorted(key for key in required if not str(model.get(key) or "").strip())
        if missing:
            raise RegistrySourceError(f"model entry {index} missing required fields: {', '.join(missing)}")


def read_registry_model_ids(path: Path) -> set[str]:
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception:
        return set()
    if not isinstance(raw, dict):
        return set()
    entries = raw.get("models")
    if not isinstance(entries, list):
        return set()

    model_ids: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        model_id = entry.get("id")
        if isinstance(model_id, str) and model_id:
            model_ids.add(model_id)
    return model_ids


def should_preserve_existing_registry(
    *,
    output: Path,
    models: list[dict[str, Any]],
    skipped: list[dict[str, Any]],
) -> tuple[bool, set[str], set[str]]:
    existing_ids = read_registry_model_ids(output)
    new_ids = {str(item.get("id") or "").strip() for item in models if str(item.get("id") or "").strip()}
    comparable_existing_ids = existing_ids - DEFAULT_EXTERNAL_MODEL_IDS
    comparable_new_ids = new_ids - DEFAULT_EXTERNAL_MODEL_IDS
    missing_existing_ids = comparable_existing_ids - comparable_new_ids
    should_preserve = bool(
        skipped
        and comparable_existing_ids
        and missing_existing_ids
        and len(comparable_new_ids) < len(comparable_existing_ids)
    )
    return should_preserve, existing_ids, missing_existing_ids


def write_registry_file(output: Path, models: list[dict[str, Any]], generated_at: str) -> None:
    text = render_registry_yaml(models, generated_at)
    validate_registry_yaml(text)
    output.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = output.with_name(f".{output.name}.tmp.{os.getpid()}")
    tmp_path.write_text(text, encoding="utf-8")
    try:
        validate_registry_yaml(tmp_path.read_text(encoding="utf-8"))
        tmp_path.replace(output)
    finally:
        if tmp_path.exists():
            tmp_path.unlink()


def write_status_file(status_output: Path | None, status: dict[str, Any]) -> None:
    if status_output is None:
        return
    status_output.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = status_output.with_name(f".{status_output.name}.tmp.{os.getpid()}")
    tmp_path.write_text(json.dumps(status, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    try:
        tmp_path.replace(status_output)
    finally:
        if tmp_path.exists():
            tmp_path.unlink()


def refresh_registry_source(
    *,
    settings: K8sDiscoverySettings,
    output: Path,
    status_output: Path | None = None,
    triggered_by: str = "manual",
    dry_run: bool = False,
    preserve_partial: bool = True,
    client: Any | None = None,
    probe_func: Any | None = None,
) -> dict[str, Any]:
    discovery = discover_model_registry(settings, client=client, probe_func=probe_func)
    models = discovery["models"]
    preserve_existing, existing_model_ids, missing_existing_aliases = should_preserve_existing_registry(
        output=output,
        models=models,
        skipped=discovery["skipped"],
    )
    if not preserve_partial:
        preserve_existing = False

    applied = False
    status_name = "success"
    message = ""

    if preserve_existing:
        status_name = "partial_failed"
        message = (
            "Discovery returned a smaller partial registry while routes were skipped; "
            "existing registry was left unchanged."
        )
    elif models:
        if not dry_run:
            write_registry_file(output, models, discovery["generated_at"])
        applied = not dry_run
        status_name = "dry_run" if dry_run else "success"
    else:
        status_name = "no_healthy_models"
        message = "No discovered route answered /v1/models; existing registry was left unchanged."

    status = {
        "status": status_name,
        "triggered_by": triggered_by,
        "updated_at": utc_now(),
        "generated_at": discovery["generated_at"],
        "applied": applied,
        "dry_run": dry_run,
        "message": message,
        "registry_path": str(output),
        "model_count": len(models),
        "candidate_count": len(discovery["candidates"]),
        "skipped_count": len(discovery["skipped"]),
        "preserved_existing_registry": preserve_existing,
        "existing_model_count": len(existing_model_ids),
        "missing_existing_aliases": sorted(missing_existing_aliases)[:50],
        "models": [
            {
                "id": item.get("id"),
                "backend": item.get("backend"),
                "model_name": item.get("model_name"),
            }
            for item in models
        ],
        "candidates": discovery["candidates"],
        "skipped": discovery["skipped"],
    }
    write_status_file(status_output, status)
    return status


def env_value(*names: str, default: str = "") -> str:
    for name in names:
        value = os.environ.get(name)
        if value is not None:
            return value
    return default


def positive_float(value: str) -> float:
    parsed = float(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


def non_negative_float(value: str) -> float:
    parsed = float(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be non-negative")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(env_value("MODELNET_REGISTRY_SOURCE_PATH", default=str(DEFAULT_OUTPUT))))
    parser.add_argument(
        "--status-output",
        type=Path,
        default=Path(env_value("MODELNET_REGISTRY_SOURCE_STATUS_PATH", default=str(DEFAULT_STATUS_OUTPUT))),
    )
    parser.add_argument(
        "--namespaces",
        default=env_value("MODELNET_K8S_NAMESPACES", "MODEL_NET_K8S_NAMESPACES", default="inference,llama-cpp"),
    )
    parser.add_argument(
        "--kubeconfig",
        default=env_value("MODELNET_K8S_KUBECONFIG_PATH", "MODEL_NET_K8S_KUBECONFIG_PATH", "KUBECONFIG"),
    )
    parser.add_argument(
        "--nodeport-host",
        default=env_value("MODELNET_K8S_NODEPORT_HOST", "MODEL_NET_K8S_DATA_NODEPORT_HOST"),
    )
    parser.add_argument(
        "--probe-timeout-seconds",
        type=positive_float,
        default=float(env_value("MODELNET_K8S_PROBE_TIMEOUT_SECONDS", "MODEL_NET_K8S_PROBE_TIMEOUT_SECONDS", default="10")),
    )
    parser.add_argument(
        "--route-default-scheme",
        choices=("http", "https"),
        default=env_value("MODELNET_K8S_ROUTE_DEFAULT_SCHEME", "MODEL_NET_K8S_ROUTE_DEFAULT_SCHEME", default="https"),
    )
    parser.add_argument(
        "--default-backend",
        default=env_value("MODELNET_K8S_DEFAULT_BACKEND", "MODEL_NET_K8S_DEFAULT_BACKEND", default="vllm_chat"),
    )
    parser.add_argument(
        "--request-timeout-ms",
        type=int,
        default=int(env_value("MODELNET_K8S_REQUEST_TIMEOUT_MS", "MODEL_NET_K8S_REQUEST_TIMEOUT_MS", default="180000")),
    )
    parser.add_argument("--triggered-by", default="manual")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-preserve-partial", action="store_true")
    parser.add_argument(
        "--interval-seconds",
        type=non_negative_float,
        default=float(env_value("MODELNET_REGISTRY_SOURCE_INTERVAL_SECONDS", default="0")),
        help="Run once by default. Set to a positive value to keep refreshing.",
    )
    return parser


def settings_from_args(args: argparse.Namespace) -> K8sDiscoverySettings:
    kubeconfig_path = str(args.kubeconfig or "").strip() or None
    nodeport_host = str(args.nodeport_host or "").strip() or None
    return K8sDiscoverySettings(
        namespaces=parse_namespaces(args.namespaces),
        kubeconfig_path=kubeconfig_path,
        nodeport_host=nodeport_host,
        probe_timeout_seconds=float(args.probe_timeout_seconds),
        route_default_scheme=str(args.route_default_scheme),
        default_backend=str(args.default_backend),
        request_timeout_ms=int(args.request_timeout_ms),
    )


def run_once(args: argparse.Namespace) -> dict[str, Any]:
    status = refresh_registry_source(
        settings=settings_from_args(args),
        output=args.output,
        status_output=args.status_output,
        triggered_by=args.triggered_by,
        dry_run=bool(args.dry_run),
        preserve_partial=not bool(args.no_preserve_partial),
    )
    print(json.dumps(status, ensure_ascii=False, sort_keys=True))
    return status


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.interval_seconds <= 0:
        status = run_once(args)
        return 0 if status["status"] in {"success", "dry_run", "partial_failed", "no_healthy_models"} else 1

    exit_code = 0
    while True:
        try:
            status = run_once(args)
            if status["status"] not in {"success", "dry_run", "partial_failed", "no_healthy_models"}:
                exit_code = 1
        except Exception as exc:  # noqa: BLE001
            exit_code = 1
            print(json.dumps({"status": "failed", "updated_at": utc_now(), "error": str(exc)}), file=sys.stderr)
        time.sleep(args.interval_seconds)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
