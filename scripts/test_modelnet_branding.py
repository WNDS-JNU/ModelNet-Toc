from __future__ import annotations

import re
import subprocess
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
APP_ROOT = REPO_ROOT / "modelnet-app"

TEXT_SUFFIXES = {
    ".cjs",
    ".env",
    ".html",
    ".js",
    ".json",
    ".md",
    ".mdx",
    ".mjs",
    ".sh",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
}

IGNORED_PARTS = {
    ".git",
    ".next",
    "__snapshots__",
    "__tests__",
    "benchmarks",
    "build",
    "changelog",
    "coverage",
    "dist",
    "e2e",
    "node_modules",
    "release",
    "reports",
    "superpowers",
    "tests",
}

HISTORICAL_DOC_RE = re.compile(r"(?:snapshot|report|repair)-\d{4}-\d{2}-\d{2}", re.I)
BRAND_RE = re.compile(r"(?<![A-Za-z0-9_])(?:LobeHub|LobeChat|Lobe AI)(?![A-Za-z0-9_])")
LOBE_PRODUCT_RE = re.compile(r"(?<![A-Za-z0-9_-])Lobe(?![A-Za-z0-9_-]|[ \u00a0](?:UI|i18n|Theme|Icons|TTS|SD|Midjourney))")
LOBE_SURFACE_PREFIXES = (
    "modelnet-app/locales/",
    "modelnet-app/apps/desktop/resources/",
    "modelnet-app/e2e/",
    "modelnet-app/packages/builtin-agents/",
    "modelnet-app/packages/builtin-tool-lobe-agent/",
    "modelnet-app/packages/locales/",
    "modelnet-app/src/app/",
    "modelnet-app/src/components/",
    "modelnet-app/src/features/",
    "modelnet-app/src/libs/better-auth/email-templates/",
    "modelnet-app/src/routes/",
)
DEPLOYMENT_RE = re.compile(r"lobehub-toc|(?<![@./])lobehub/(?!lobehub)", re.I)

# These are upstream identity, API compatibility, or migration references rather than
# ModelNet product copy. Keep every exemption narrow enough to review in test output.
ALLOWED_LINE_PATTERNS = tuple(
    re.compile(pattern)
    for pattern in (
        r'"author"\s*:\s*"LobeHub(?:\s|<|\")',
        r"\bauthor\s*:\s*['\"]LobeHub(?:\s|<|['\"])",
        r"\b(?:ChatErrorType|ModelProvider|PlatformType|SkillStoreTab)\.LobeHub\b",
        r"\b(?:BRANDING_NAME|ORG_NAME)\s*!==\s*['\"]LobeHub['\"]",
        r"^\s*LobeHub\s*=\s*['\"]lobehub['\"]",
        r"\b(?:const|export default)\s+LobeHub\b",
        r"\bLobeHub Cloud\b",
        r"\bname\s*:\s*['\"]LobeHub['\"]",
        r"SkillList/LobeHub",
        r"(?:return )?<LobeHub\b",
        r"\bLobeHub\.Morden\b",
        r"\bauthor\s*===\s*['\"]LobeHub['\"]",
        r"\b(?:LobeHub|LobeChat)(?:Database|Plugin|Provider|Props|Const|Identifier|List|Model|Skill|Topic|Group|Context)",
        r"\bhandleLobeHubModelDeprecatedError\b",
        r"\bisLobeHubModelAvailable\b",
        r"\bLobeHubModelDeprecatedErrorData\b",
        r"\bLobeHubModelPricing(?:Options|Context)\b",
        r"https?://[^\s\"')]*lobehub",
        r"@lobehub(?:/|\.)",
        r"@lobechat/",
        r"LOBE(?:HUB)?_[A-Z0-9_]+",
    )
)


def is_historical_or_generated(path: Path) -> bool:
    relative = path.relative_to(REPO_ROOT)
    if any(part in IGNORED_PARTS for part in relative.parts):
        return True
    if relative.name.startswith("CHANGELOG") or relative.name == "LICENSE":
        return True
    if ".test." in relative.name or ".spec." in relative.name:
        return True
    return bool(HISTORICAL_DOC_RE.search(relative.as_posix()))


def iter_branding_files() -> list[Path]:
    roots = (
        ".env.example",
        ".env.modelnet.example",
        "README.md",
        "docker-compose.yml",
        "docker-compose.dev.yml",
        "docker-compose.router-direct-dev.yml",
        "docs/",
        "scripts/",
        "modelnet-app/",
    )
    tracked = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=REPO_ROOT,
    ).decode().split("\0")
    files: list[Path] = []
    for relative_name in tracked:
        if not relative_name or not relative_name.startswith(roots):
            continue
        path = REPO_ROOT / relative_name
        if not path.is_file() or is_historical_or_generated(path):
            continue
        if path.suffix.lower() not in TEXT_SUFFIXES and not path.name.startswith(".env"):
            continue
        files.append(path)
    return sorted(set(files))


def line_is_allowed(line: str) -> bool:
    return any(pattern.search(line) for pattern in ALLOWED_LINE_PATTERNS)


class ModelNetBrandingTest(unittest.TestCase):
    def test_production_compose_routes_modelnet_directly_without_litellm(self) -> None:
        compose = (REPO_ROOT / "docker-compose.yml").read_text(encoding="utf-8")

        self.assertIn("MODELNET_PROXY_URL: http://modelnet-router:8000/v1", compose)
        self.assertIn("MODELNET_API_KEY: ${MODELNET_BACKEND_API_KEY:-none}", compose)
        self.assertIn("OPENAI_PROXY_URL: http://modelnet-router:8000/v1", compose)
        self.assertIn("OPENAI_API_KEY: ${MODELNET_BACKEND_API_KEY:-none}", compose)
        self.assertNotIn("\n  litellm:\n", compose)

    def test_dev_compose_routes_directly_without_litellm_assets(self) -> None:
        compose = (REPO_ROOT / "docker-compose.dev.yml").read_text(encoding="utf-8")
        registry_overlay = (REPO_ROOT / "docker-compose.registry-dev.yml").read_text(encoding="utf-8")

        self.assertIn("MODELNET_PROXY_URL: http://modelnet-router:8000/v1", compose)
        self.assertIn("OPENAI_PROXY_URL: http://modelnet-router:8000/v1", compose)
        self.assertNotIn("\n  litellm:\n", compose)
        self.assertNotIn("DEV_LITELLM", compose)
        self.assertNotIn("MODELNET_LITELLM", compose)
        self.assertNotIn("litellm", registry_overlay.lower())

    def test_reload_script_uses_router_direct_services(self) -> None:
        script = (REPO_ROOT / "scripts/reload_modelnet.sh").read_text(encoding="utf-8")

        self.assertIn("docker compose ps modelnet-router modelnet-app toc-lb", script)
        self.assertNotIn("sync_modelnet_litellm.py", script)
        self.assertNotRegex(script, r"docker compose[^\n]*\blitellm\b")
        self.assertNotRegex(script, r"docker compose ps[^\n]*\blobe\b")

    def test_active_product_surfaces_do_not_use_lobe_brand_names(self) -> None:
        offenders: list[str] = []
        for path in iter_branding_files():
            for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if BRAND_RE.search(line) and not line_is_allowed(line):
                    offenders.append(
                        f"{path.relative_to(REPO_ROOT)}:{line_number}: {line.strip()}"
                    )

        self.assertEqual([], offenders[:200], f"{len(offenders)} unapproved brand references")

    def test_user_facing_surfaces_do_not_use_standalone_lobe_product_name(self) -> None:
        offenders: list[str] = []
        for path in iter_branding_files():
            relative = path.relative_to(REPO_ROOT).as_posix()
            if not relative.startswith(LOBE_SURFACE_PREFIXES):
                continue
            for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if LOBE_PRODUCT_RE.search(line):
                    offenders.append(f"{relative}:{line_number}: {line.strip()}")

        self.assertEqual([], offenders[:200], f"{len(offenders)} standalone Lobe product references")

    def test_project_owned_deployment_names_use_modelnet(self) -> None:
        offenders: list[str] = []
        deployment_files = [
            REPO_ROOT / ".env.example",
            REPO_ROOT / "README.md",
            REPO_ROOT / "docker-compose.yml",
            REPO_ROOT / "docker-compose.dev.yml",
            REPO_ROOT / "docker-compose.router-direct-dev.yml",
        ]
        for path in deployment_files:
            for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if DEPLOYMENT_RE.search(line) and not line_is_allowed(line):
                    offenders.append(
                        f"{path.relative_to(REPO_ROOT)}:{line_number}: {line.strip()}"
                    )

        self.assertEqual([], offenders, "project-owned deployment names must use ModelNet")


if __name__ == "__main__":
    unittest.main()
