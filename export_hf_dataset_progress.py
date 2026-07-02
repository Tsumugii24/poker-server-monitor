#!/usr/bin/env python3
"""Export Hugging Face solver dataset progress to a Markdown file."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_OUTPUT = PROJECT_ROOT / "hf_dataset_progress.md"
DEFAULT_NAMESPACE = "Tsumugii"
DEFAULT_TOTAL_ROWS = 1755
SOLVER_DATASET_PATTERN = re.compile(r"^(?:3ia|sia|soa|gto)-", re.IGNORECASE)


def main() -> int:
    env_file = PROJECT_ROOT / ".env"
    env = load_env_file(env_file)

    parser = argparse.ArgumentParser(
        description="Write Hugging Face solver dataset progress to hf_dataset_progress.md."
    )
    parser.add_argument(
        "--namespace",
        default=env_value(env, "HF_DEFAULT_NAMESPACE", DEFAULT_NAMESPACE),
        help=f"Hugging Face namespace/user to query. Default: {DEFAULT_NAMESPACE}",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"Markdown output path. Default: {DEFAULT_OUTPUT}",
    )
    parser.add_argument(
        "--total-rows",
        type=int,
        default=DEFAULT_TOTAL_ROWS,
        help=f"Expected rows per complete solver dataset. Default: {DEFAULT_TOTAL_ROWS}",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=5,
        help="Concurrent dataset size checks. Default: 5",
    )
    parser.add_argument(
        "--proxy",
        default=env_value(env, "SERVER_MONITOR_HF_PROXY_URL", ""),
        help="Optional proxy URL for Hugging Face requests.",
    )
    args = parser.parse_args()

    token = env_value(env, "HF_TOKEN", "")
    if not token:
        print("HF_TOKEN is required in .env or environment variables.", file=sys.stderr)
        return 1

    namespace = args.namespace.strip() or DEFAULT_NAMESPACE
    total_rows = max(1, args.total_rows)
    opener = build_opener(args.proxy.strip())

    datasets = list_datasets(namespace, token, opener)
    solver_datasets = [
        dataset
        for dataset in datasets
        if SOLVER_DATASET_PATTERN.match(strip_namespace(dataset["id"], namespace))
    ]
    solver_datasets.sort(key=lambda dataset: strip_namespace(dataset["id"], namespace).lower())

    workers = max(1, args.workers)
    rows = fetch_dataset_rows(solver_datasets, token, opener, workers)
    checked_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    markdown = render_markdown(namespace, checked_at, rows, total_rows)

    output_path = args.output
    if not output_path.is_absolute():
        output_path = PROJECT_ROOT / output_path
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(markdown, encoding="utf-8")

    complete = sum(1 for item in rows if item["rows"] >= total_rows)
    print(f"Wrote {output_path}")
    print(f"Solver datasets: {len(rows)}")
    print(f"Complete: {complete}/{len(rows)}")
    return 0


def load_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}

    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", key):
            continue
        values[key] = parse_env_value(value.strip())
    return values


def parse_env_value(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        value = value[1:-1]
    return value


def env_value(env: dict[str, str], key: str, default: str) -> str:
    return os.environ.get(key, env.get(key, default)).strip()


def build_opener(proxy_url: str) -> urllib.request.OpenerDirector:
    if proxy_url:
        return urllib.request.build_opener(
            urllib.request.ProxyHandler({
                "http": proxy_url,
                "https": proxy_url,
            })
        )
    return urllib.request.build_opener()


def list_datasets(namespace: str, token: str, opener: urllib.request.OpenerDirector) -> list[dict[str, Any]]:
    params = urllib.parse.urlencode({
        "author": namespace,
        "full": "true",
        "limit": "1000",
        "sort": "lastModified",
        "direction": "-1",
    })
    data = request_json(f"https://huggingface.co/api/datasets?{params}", token, opener)
    if not isinstance(data, list):
        raise RuntimeError("Unexpected Hugging Face dataset list response.")

    prefix = f"{namespace}/"
    return [
        {
            "id": str(item.get("id", "")),
            "lastModified": item.get("lastModified") or item.get("last_modified") or "-",
        }
        for item in data
        if isinstance(item, dict) and str(item.get("id", "")).startswith(prefix)
    ]


def fetch_dataset_rows(
    datasets: list[dict[str, Any]],
    token: str,
    opener: urllib.request.OpenerDirector,
    workers: int,
) -> list[dict[str, Any]]:
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [
            executor.submit(fetch_one_dataset_row, dataset, token, opener)
            for dataset in datasets
        ]
        return [future.result() for future in futures]


def fetch_one_dataset_row(
    dataset: dict[str, Any],
    token: str,
    opener: urllib.request.OpenerDirector,
) -> dict[str, Any]:
    repo_id = str(dataset["id"])
    url = "https://datasets-server.huggingface.co/size?dataset=" + urllib.parse.quote(repo_id, safe="")
    rows = 0
    try:
        rows = extract_rows(request_json(url, token, opener))
    except urllib.error.HTTPError as error:
        if error.code != 404:
            rows = 0
    except Exception:
        rows = 0

    namespace, _, name = repo_id.partition("/")
    return {
        "name": name if name else repo_id,
        "namespace": namespace,
        "rows": rows,
        "lastModified": str(dataset.get("lastModified") or "-"),
    }


def request_json(url: str, token: str, opener: urllib.request.OpenerDirector) -> Any:
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": "poker-server-monitor-hf-progress/1.0",
        },
    )
    with opener.open(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def extract_rows(data: Any) -> int:
    for path in (("size", "dataset", "num_rows"), ("dataset", "num_rows")):
        value = nested_value(data, path)
        if isinstance(value, (int, float)):
            return max(0, round(value))

    splits = nested_value(data, ("size", "splits"))
    if not isinstance(splits, list) and isinstance(data, dict):
        splits = data.get("splits")
    if isinstance(splits, list):
        total = 0
        found = False
        for split in splits:
            if isinstance(split, dict) and isinstance(split.get("num_rows"), (int, float)):
                total += round(split["num_rows"])
                found = True
        if found:
            return max(0, total)

    return 0


def nested_value(data: Any, path: tuple[str, ...]) -> Any:
    current = data
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def strip_namespace(repo_id: str, namespace: str) -> str:
    prefix = f"{namespace}/"
    return repo_id[len(prefix):] if repo_id.startswith(prefix) else repo_id


def render_markdown(
    namespace: str,
    checked_at: str,
    rows: list[dict[str, Any]],
    total_rows: int,
) -> str:
    complete = sum(1 for item in rows if item["rows"] >= total_rows)
    lines = [
        "# Hugging Face Dataset Progress",
        "",
        f"Checked at: {checked_at}",
        f"Namespace: {namespace}",
        f"Solver datasets: {len(rows)}",
        f"Complete: {complete}/{len(rows)}",
        "",
        "| Dataset | Progress | Percent | Last Modified |",
        "|---|---:|---:|---|",
    ]
    for item in rows:
        row_count = int(item["rows"])
        percent = min(100.0, max(0.0, row_count / total_rows * 100))
        lines.append(
            f"| {item['name']} | {row_count}/{total_rows} | {percent:.1f}% | {item['lastModified']} |"
        )
    lines.append("")
    return "\n".join(lines)


if __name__ == "__main__":
    raise SystemExit(main())
