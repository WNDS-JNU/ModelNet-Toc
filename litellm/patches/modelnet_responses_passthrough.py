from pathlib import Path


def unique_existing(candidates: list[Path]) -> list[Path]:
    seen: set[Path] = set()
    targets: list[Path] = []
    for candidate in candidates:
        if candidate.exists() and candidate not in seen:
            seen.add(candidate)
            targets.append(candidate)
    return targets


def discover_response_targets() -> list[Path]:
    candidates = [Path("/app/litellm/responses/utils.py")]
    candidates.extend(Path("/usr/lib").glob("python*/site-packages/litellm/responses/utils.py"))
    candidates.extend(Path("/usr/local/lib").glob("python*/site-packages/litellm/responses/utils.py"))
    return unique_existing(candidates)


def discover_chat_targets() -> list[Path]:
    candidates = [Path("/app/litellm/llms/openai/openai.py")]
    candidates.extend(Path("/usr/lib").glob("python*/site-packages/litellm/llms/openai/openai.py"))
    candidates.extend(Path("/usr/local/lib").glob("python*/site-packages/litellm/llms/openai/openai.py"))
    return unique_existing(candidates)


upstream_param_filter = '''        valid_keys = get_type_hints(ResponsesAPIOptionalRequestParams).keys()
        custom_llm_provider = params.pop("custom_llm_provider", None)
        special_params = params.pop("kwargs", {})
'''

legacy_param_filter = '''        valid_keys = set(get_type_hints(ResponsesAPIOptionalRequestParams).keys())
        allowed_openai_params = params.get("allowed_openai_params") or []
        if isinstance(allowed_openai_params, str):
            allowed_openai_params = [allowed_openai_params]
        if isinstance(allowed_openai_params, (list, tuple, set)):
            valid_keys.update(str(param) for param in allowed_openai_params)
        custom_llm_provider = params.pop("custom_llm_provider", None)
        special_params = params.pop("kwargs", {})
'''

legacy_modelnet_param_filter = '''        valid_keys = set(get_type_hints(ResponsesAPIOptionalRequestParams).keys())
        custom_llm_provider = params.pop("custom_llm_provider", None)
        special_params = params.pop("kwargs", {})

        allowed_openai_params = params.get("allowed_openai_params") or []
        if isinstance(allowed_openai_params, str):
            allowed_openai_params = [allowed_openai_params]
        elif not isinstance(allowed_openai_params, (list, tuple, set)):
            allowed_openai_params = []
        allowed_param_keys = {str(param) for param in allowed_openai_params}
        if "modelnet" in params or (
            isinstance(special_params, dict) and "modelnet" in special_params
        ):
            allowed_param_keys.add("modelnet")
        valid_keys.update(allowed_param_keys)
'''

new_param_filter = '''        valid_keys = set(get_type_hints(ResponsesAPIOptionalRequestParams).keys())
        custom_llm_provider = params.pop("custom_llm_provider", None)
        special_params = params.pop("kwargs", {})
        modelnet_param = params.get("modelnet")
        if modelnet_param is None and isinstance(special_params, dict):
            modelnet_param = special_params.get("modelnet")

        allowed_openai_params = params.get("allowed_openai_params") or []
        if isinstance(allowed_openai_params, str):
            allowed_openai_params = [allowed_openai_params]
        elif not isinstance(allowed_openai_params, (list, tuple, set)):
            allowed_openai_params = []
        allowed_param_keys = {str(param) for param in allowed_openai_params}
        if "modelnet" in params or (
            isinstance(special_params, dict) and "modelnet" in special_params
        ):
            allowed_param_keys.add("modelnet")
        valid_keys.update(allowed_param_keys)
'''

upstream_non_default = '''        # decode previous_response_id if it's a litellm encoded id
'''

new_non_default = '''        if modelnet_param is not None:
            non_default_params["modelnet"] = modelnet_param

        # decode previous_response_id if it's a litellm encoded id
'''

upstream_allowed_params = '''        non_default_params = cast(Dict, response_api_optional_params)
        # Check for unsupported parameters
        ResponsesAPIRequestUtils._check_valid_arg(
'''

new_allowed_params = '''        non_default_params = cast(Dict, response_api_optional_params)
        if "modelnet" in non_default_params and (
            allowed_openai_params is None or "modelnet" not in allowed_openai_params
        ):
            allowed_openai_params = [*(allowed_openai_params or []), "modelnet"]
        # Check for unsupported parameters
        ResponsesAPIRequestUtils._check_valid_arg(
'''

chat_helper_anchor = '''    def _set_dynamic_params_on_client(
        self,
        client: Union[OpenAI, AsyncOpenAI],
        organization: Optional[str] = None,
        max_retries: Optional[int] = None,
    ):
'''

chat_helper = '''    @staticmethod
    def _move_modelnet_to_extra_body(data: dict) -> dict:
        modelnet_param = data.pop("modelnet", None)
        if modelnet_param is None:
            return data
        extra_body = data.get("extra_body")
        if isinstance(extra_body, dict):
            extra_body = dict(extra_body)
        else:
            extra_body = {}
        extra_body["modelnet"] = modelnet_param
        data["extra_body"] = extra_body
        return data

'''

async_request_anchor = '''        start_time = time.time()
        try:
            raw_response = (
                await openai_aclient.chat.completions.with_raw_response.create(
                    **data, timeout=timeout
                )
'''

async_request_patch = '''        start_time = time.time()
        data = self._move_modelnet_to_extra_body(data)
        try:
            raw_response = (
                await openai_aclient.chat.completions.with_raw_response.create(
                    **data, timeout=timeout
                )
'''

sync_request_anchor = '''        raw_response = None
        try:
            raw_response = openai_client.chat.completions.with_raw_response.create(
                **data, timeout=timeout
            )
'''

sync_request_patch = '''        raw_response = None
        data = self._move_modelnet_to_extra_body(data)
        try:
            raw_response = openai_client.chat.completions.with_raw_response.create(
                **data, timeout=timeout
            )
'''

sync_stream_anchor = '''        data["stream"] = True
        data.update(
            self.get_stream_options(stream_options=stream_options, api_base=api_base)
        )

        openai_client: OpenAI = self._get_openai_client(  # type: ignore
'''

sync_stream_patch = '''        data["stream"] = True
        data.update(
            self.get_stream_options(stream_options=stream_options, api_base=api_base)
        )
        data = self._move_modelnet_to_extra_body(data)

        openai_client: OpenAI = self._get_openai_client(  # type: ignore
'''

async_stream_anchor = '''        data["stream"] = True
        data.update(
            self.get_stream_options(stream_options=stream_options, api_base=api_base)
        )
        for _ in range(2):
'''

async_stream_patch = '''        data["stream"] = True
        data.update(
            self.get_stream_options(stream_options=stream_options, api_base=api_base)
        )
        data = self._move_modelnet_to_extra_body(data)
        for _ in range(2):
'''


def patch_response_target(target: Path) -> bool:
    text = target.read_text(encoding="utf-8")
    patched = False

    if upstream_param_filter in text:
        text = text.replace(upstream_param_filter, new_param_filter)
        patched = True
    elif legacy_param_filter in text:
        text = text.replace(legacy_param_filter, new_param_filter)
        patched = True
    elif legacy_modelnet_param_filter in text:
        text = text.replace(legacy_modelnet_param_filter, new_param_filter)
        patched = True
    elif 'modelnet_param = params.get("modelnet")' not in text:
        raise RuntimeError(f"Could not find LiteLLM Responses optional-param block in {target}")

    if upstream_non_default in text and 'non_default_params["modelnet"] = modelnet_param' not in text:
        text = text.replace(upstream_non_default, new_non_default)
        patched = True
    elif 'non_default_params["modelnet"] = modelnet_param' not in text:
        raise RuntimeError(f"Could not find LiteLLM Responses non-default block in {target}")

    if upstream_allowed_params in text:
        text = text.replace(upstream_allowed_params, new_allowed_params)
        patched = True
    elif 'allowed_openai_params = [*(allowed_openai_params or []), "modelnet"]' not in text:
        raise RuntimeError(f"Could not find LiteLLM Responses allowed-param block in {target}")

    if patched:
        target.write_text(text, encoding="utf-8")
    return patched


def patch_chat_target(target: Path) -> bool:
    text = target.read_text(encoding="utf-8")
    patched = False

    if "_move_modelnet_to_extra_body" not in text:
        if chat_helper_anchor not in text:
            raise RuntimeError(f"Could not find LiteLLM OpenAI chat helper anchor in {target}")
        text = text.replace(chat_helper_anchor, chat_helper + chat_helper_anchor, 1)
        patched = True

    if async_request_anchor in text:
        text = text.replace(async_request_anchor, async_request_patch, 1)
        patched = True
    elif "data = self._move_modelnet_to_extra_body(data)" not in text:
        raise RuntimeError(f"Could not find LiteLLM async chat request block in {target}")

    if sync_request_anchor in text:
        text = text.replace(sync_request_anchor, sync_request_patch, 1)
        patched = True
    elif text.count("data = self._move_modelnet_to_extra_body(data)") < 2:
        raise RuntimeError(f"Could not find LiteLLM sync chat request block in {target}")

    if sync_stream_anchor in text:
        text = text.replace(sync_stream_anchor, sync_stream_patch, 1)
        patched = True
    elif sync_stream_patch not in text:
        raise RuntimeError(f"Could not find LiteLLM sync streaming chat request block in {target}")

    if async_stream_anchor in text:
        text = text.replace(async_stream_anchor, async_stream_patch, 1)
        patched = True
    elif async_stream_patch not in text:
        raise RuntimeError(f"Could not find LiteLLM async streaming chat request block in {target}")

    if patched:
        target.write_text(text, encoding="utf-8")
    return patched


def main() -> None:
    response_targets = discover_response_targets()
    chat_targets = discover_chat_targets()
    if not response_targets:
        raise SystemExit("Could not find LiteLLM Responses utils.py to patch")
    if not chat_targets:
        raise SystemExit("Could not find LiteLLM OpenAI chat openai.py to patch")

    patched_any = False
    for target in response_targets:
        patched = patch_response_target(target)
        patched_any = patched_any or patched
        if patched:
            print(f"Patched {target} for ModelNet Responses passthrough")
        else:
            print(f"{target} already contains ModelNet Responses passthrough patch")

    for target in chat_targets:
        patched = patch_chat_target(target)
        patched_any = patched_any or patched
        if patched:
            print(f"Patched {target} for ModelNet Chat Completions passthrough")
        else:
            print(f"{target} already contains ModelNet Chat Completions passthrough patch")

    if not patched_any:
        print("All LiteLLM targets already contained ModelNet patch")


if __name__ == "__main__":
    main()
