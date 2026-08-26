#!/usr/bin/env python3
"""Reapply ModelNet product copy after importing a LobeHub update."""

from __future__ import annotations

import re
from pathlib import Path

from test_modelnet_branding import (
    BRAND_RE,
    LOBE_PRODUCT_RE,
    LOBE_SURFACE_PREFIXES,
    REPO_ROOT,
    iter_branding_files,
    line_is_allowed,
)


CLI_COMMAND_RE = re.compile(
    r"\blh(?=\s+(?:acceptance|agent|bot|config|connect|doc|eval|file|gen|kb|login|memory|message|model|plugin|provider|search|skill|task|topic|update|verify)\b)"
)


def rebrand_file(path: Path) -> bool:
    relative = path.relative_to(REPO_ROOT).as_posix()
    original = path.read_text(encoding="utf-8")
    rewritten: list[str] = []

    for line in original.splitlines(keepends=True):
        if relative.startswith(("modelnet-app/locales/", "modelnet-app/packages/locales/")):
            line = line.replace("LobeHub Cloud", "ModelNet Cloud")
        if relative == "modelnet-app/src/features/Home/welcomeText.ts":
            line = line.replace(
                "https://github.com/lobehub/lobehub/issues/",
                "https://github.com/WNDS-JNU/ModelNet-Toc/issues/",
            )
        if relative.startswith("modelnet-app/src/"):
            line = line.replace("lobehub-channels-", "modelnet-channels-")
        if relative.startswith("modelnet-app/packages/builtin-skills/src/"):
            line = CLI_COMMAND_RE.sub("modelnet", line)
            line = line.replace("https://app.lobehub.com/", "https://123.56.135.150/")
        if BRAND_RE.search(line) and not line_is_allowed(line):
            line = BRAND_RE.sub("ModelNet", line)
        if relative.startswith(LOBE_SURFACE_PREFIXES) and LOBE_PRODUCT_RE.search(line):
            line = LOBE_PRODUCT_RE.sub("ModelNet", line)
        rewritten.append(line)

    updated = "".join(rewritten)
    if updated == original:
        return False

    path.write_text(updated, encoding="utf-8")
    return True


def main() -> None:
    script_path = Path(__file__).resolve()
    changed = [
        path.relative_to(REPO_ROOT).as_posix()
        for path in iter_branding_files()
        if path.resolve() != script_path and rebrand_file(path)
    ]
    print(f"Rebranded {len(changed)} files for ModelNet")


if __name__ == "__main__":
    main()
