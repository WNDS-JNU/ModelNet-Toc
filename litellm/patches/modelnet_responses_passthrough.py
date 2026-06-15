from pathlib import Path


def discover_targets() -> list[Path]:
    candidates = [Path("/app/litellm/responses/utils.py")]
    candidates.extend(Path("/usr/lib").glob("python*/site-packages/litellm/responses/utils.py"))
    candidates.extend(Path("/usr/local/lib").glob("python*/site-packages/litellm/responses/utils.py"))
    seen: set[Path] = set()
    targets: list[Path] = []
    for candidate in candidates:
        if candidate.exists() and candidate not in seen:
            seen.add(candidate)
            targets.append(candidate)
    return targets


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


def patch_target(target: Path) -> bool:
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


def main() -> None:
    targets = discover_targets()
    if not targets:
        raise SystemExit("Could not find LiteLLM Responses utils.py to patch")
    patched_any = False
    for target in targets:
        patched = patch_target(target)
        patched_any = patched_any or patched
        if patched:
            print(f"Patched {target} for ModelNet Responses passthrough")
        else:
            print(f"{target} already contains ModelNet Responses passthrough patch")
    if not patched_any:
        print("All LiteLLM Responses utils.py targets already contained ModelNet patch")


if __name__ == "__main__":
    main()
