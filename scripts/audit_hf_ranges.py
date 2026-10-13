#!/usr/bin/env python3
"""Read-only audit of solver Parquet root ranges at an immutable HF revision.

Requires pyarrow. Downloaded files are cached and checked against their LFS
SHA-256; neither the dataset nor the monitor database is modified.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import itertools
import json
import math
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from export_hf_dataset_progress import build_opener, env_value, load_env_file


RANKS = "AKQJT98765432"
SUITS = "cdhs"


def combo_key(hand: str) -> str:
    if not re.fullmatch(r"[AKQJT98765432][cdhs][AKQJT98765432][cdhs]", hand):
        raise ValueError(f"Invalid combo: {hand}")
    cards = (hand[:2], hand[2:])
    if cards[0] == cards[1]:
        raise ValueError(f"Repeated card in combo: {hand}")
    return "".join(sorted(cards))


def expand_range(text: str, board: str) -> dict[str, float]:
    if not re.fullmatch(r"(?:[AKQJT98765432][cdhs]){3}", board):
        raise ValueError(f"Invalid flop: {board}")
    blocked = {board[i:i + 2] for i in (0, 2, 4)}
    if len(blocked) != 3:
        raise ValueError(f"Repeated card in flop: {board}")
    result: dict[str, float] = {}
    seen = set()
    for token in text.split(","):
        token = token.strip()
        if not token:
            continue
        code, _, raw_weight = token.partition(":")
        if not re.fullmatch(r"([AKQJT98765432])\1|[AKQJT98765432]{2}[so]", code):
            raise ValueError(f"Invalid hand class: {code}")
        if code in seen:
            raise ValueError(f"Repeated hand class: {code}")
        seen.add(code)
        weight = float(raw_weight) if raw_weight else 1.0
        if not math.isfinite(weight) or not 0 <= weight <= 1:
            raise ValueError(f"Invalid weight: {token}")
        if code[0] == code[1]:
            if len(code) != 2:
                raise ValueError(f"Invalid pair: {code}")
            pairs = itertools.combinations((code[0] + s for s in SUITS), 2)
        else:
            pairs = ((code[0] + a, code[1] + b) for a in SUITS for b in SUITS
                     if (a == b) == (code[2] == "s"))
        for a, b in pairs:
            if a not in blocked and b not in blocked and weight > 0:
                key = combo_key(a + b)
                if key in result:
                    raise ValueError(f"Duplicate combo: {key}")
                result[key] = weight
    return result


def normalized_combos(value: object) -> dict[str, float]:
    if not isinstance(value, dict):
        raise ValueError("Missing root combo map")
    result = {}
    for hand, raw_weight in value.items():
        key = combo_key(hand)
        if key in result:
            raise ValueError(f"Duplicate exported combo: {key}")
        weight = float(raw_weight)
        if not math.isfinite(weight) or not 0 <= weight <= 1:
            raise ValueError(f"Invalid exported weight: {hand}={raw_weight}")
        if weight > 0:
            result[key] = weight
    return result


def differences(actual: dict[str, float], expected: dict[str, float]) -> dict:
    missing = sorted(expected.keys() - actual.keys())
    extra = sorted(actual.keys() - expected.keys())
    weights = sorted(k for k in actual.keys() & expected.keys()
                     if not math.isclose(actual[k], expected[k], rel_tol=0, abs_tol=1e-6))
    return {
        "matches": not (missing or extra or weights),
        "actual_combos": len(actual), "expected_combos": len(expected),
        "missing_count": len(missing), "extra_count": len(extra),
        "weight_mismatch_count": len(weights),
        "missing_examples": missing[:10], "extra_examples": extra[:10],
        "weight_examples": [{"combo": k, "actual": actual[k], "expected": expected[k]}
                            for k in weights[:10]],
    }


def classify(payload: dict, oop_text: str, ip_text: str, board: str) -> dict:
    # Only the root contains initial ranges. Descendant ranges contain reach
    # probabilities and must not be compared to the preflop configuration.
    ranges = payload.get("ranges", {})
    actual_oop = normalized_combos(ranges.get("oop_range"))
    actual_ip = normalized_combos(ranges.get("ip_range"))
    expected_oop = expand_range(oop_text, board)
    expected_ip = expand_range(ip_text, board)
    oop = differences(actual_oop, expected_oop)
    ip = differences(actual_ip, expected_ip)
    oop_is_ip = differences(actual_oop, expected_ip)["matches"]
    status = "valid" if oop["matches"] and ip["matches"] else (
        "oop_equals_ip" if oop_is_ip and ip["matches"] else "other_mismatch")
    return {"classification": status, "oop": oop, "ip": ip,
            "oop_matches_expected_ip": oop_is_ip}


def source_ranges(document: dict) -> tuple[str, str]:
    result = {}
    for player in ("A", "B"):
        position = document["player_positions"][player]
        if position not in ("OOP", "IP") or position in result:
            raise ValueError("The Range must explicitly define one OOP and one IP")
        actions = document[player]
        nonempty = [actions[k].strip() for k in ("raise", "call") if actions.get(k, "").strip()]
        if len(nonempty) != 1:
            raise ValueError("Audit requires exactly one populated action per player")
        result[position] = nonempty[0]
    return result["OOP"], result["IP"]


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    env = load_env_file(root / ".env")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--range", dest="range_path", type=Path, required=True)
    parser.add_argument("--boards", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--revision", help="Immutable 40-character commit SHA")
    parser.add_argument("--start-index", type=int, default=1, help="First board to audit (1-based)")
    parser.add_argument("--end-index", type=int, help="Last board to audit (inclusive)")
    parser.add_argument("--workers", type=int, default=12)
    parser.add_argument("--stdlib-http", action="store_true", help="Use fresh stdlib HTTP connections")
    args = parser.parse_args()
    import pyarrow.parquet as pq

    range_bytes = args.range_path.read_bytes()
    oop_text, ip_text = source_ranges(json.loads(range_bytes))
    boards_bytes = args.boards.read_bytes()
    boards = [x.strip() for x in boards_bytes.decode().splitlines() if x.strip()]
    if len({x.lower() for x in boards}) != len(boards):
        raise ValueError("Duplicate boards")
    indices = {b.lower(): i + 1 for i, b in enumerate(boards)}
    end_index = args.end_index or len(boards)
    if not 1 <= args.start_index <= end_index <= len(boards):
        raise ValueError("Audit board interval is out of bounds")
    selected_indices = set(range(args.start_index, end_index + 1))
    for b in boards:
        expand_range(oop_text, b)
        expand_range(ip_text, b)

    token = env_value(env, "HF_TOKEN", "")
    proxy = env_value(env, "SERVER_MONITOR_HF_PROXY_URL", "")
    headers = {"Authorization": "Bearer " + token} if token else {}
    local = threading.local()
    # Reuse TLS connections during large audits when httpx is installed
    # (it is also a dependency of huggingface_hub). Retain a stdlib fallback.
    try:
        import httpx
    except ImportError:
        httpx = None
    if args.stdlib_http:
        httpx = None
    clients = []

    def get(url: str) -> tuple[bytes, object]:
        if httpx and not hasattr(local, "client"):
            local.client = httpx.Client(proxy=proxy or None, follow_redirects=True, timeout=45)
            clients.append(local.client)
        elif not httpx and not hasattr(local, "opener"):
            local.opener = build_opener(proxy)
        for attempt in range(3):
            try:
                if httpx:
                    response = local.client.get(url, headers=headers)
                    if response.status_code >= 400:
                        raise RuntimeError(f"HF request failed: HTTP {response.status_code}")
                    return response.content, response.headers
                with local.opener.open(urllib.request.Request(url, headers=headers), timeout=45) as r:
                    return r.read(), r.headers
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(attempt + 1)
        raise AssertionError("unreachable")

    api = "https://huggingface.co/api/datasets/" + args.repo
    info = json.loads(get(api)[0])
    revision = args.revision or info["sha"]
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("An immutable commit SHA is required")
    tree = []
    url = f"{api}/tree/{revision}?recursive=true&limit=1000"
    while url:
        raw, response_headers = get(url)
        tree.extend(json.loads(raw))
        link = response_headers.get("Link", "")
        match = re.search(r'<([^>]+)>;\s*rel="next"', link)
        url = match[1] if match else None
    repo_files = [x for x in tree if x["type"] == "file" and x["path"].endswith(".parquet")]
    unknown_files = [x["path"] for x in repo_files if Path(x["path"]).stem.lower() not in indices]
    files = [x for x in repo_files if indices.get(Path(x["path"]).stem.lower()) in selected_indices]
    args.cache.mkdir(parents=True, exist_ok=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    print(f"Auditing {len(files)} files at {revision}", flush=True)

    def check(entry: dict) -> dict:
        path = entry["path"]
        board = Path(path).stem
        row = {"path": path, "board_index": indices.get(board.lower()),
               "size": entry["size"], "lfs_sha256": entry.get("lfs", {}).get("oid")}
        try:
            if not row["board_index"]:
                raise ValueError("File does not match the solver board list")
            if not row["lfs_sha256"]:
                raise ValueError("Missing LFS SHA-256")
            target = args.cache / (row["lfs_sha256"] + ".parquet")
            raw = target.read_bytes() if target.exists() else None
            if raw is None or hashlib.sha256(raw).hexdigest() != row["lfs_sha256"]:
                url = f"https://huggingface.co/datasets/{args.repo}/resolve/{revision}/" + urllib.parse.quote(path)
                raw = get(url)[0]
                if hashlib.sha256(raw).hexdigest() != row["lfs_sha256"] or len(raw) != entry["size"]:
                    raise ValueError("Downloaded file does not match its immutable LFS pointer")
                temporary = target.with_suffix(".tmp")
                temporary.write_bytes(raw)
                temporary.replace(target)
            table = pq.read_table(target, columns=["data"])
            if table.num_rows != 1:
                raise ValueError(f"Expected one solver result per file, found {table.num_rows}")
            payload = json.loads(table["data"][0].as_py())
            row.update(classify(payload, oop_text, ip_text, boards[row["board_index"] - 1]))
        except Exception as error:
            row.update(classification="unreadable", error=str(error))
        return row

    counts: Counter = Counter()
    results = []
    journal = args.output.with_suffix(".jsonl")
    with journal.open("w", encoding="utf-8") as log, concurrent.futures.ThreadPoolExecutor(
        max_workers=max(1, args.workers)
    ) as executor:
        pending = [executor.submit(check, f) for f in files]
        for future in concurrent.futures.as_completed(pending):
            row = future.result()
            results.append(row)
            counts[row["classification"]] += 1
            log.write(json.dumps(row) + "\n")
            log.flush()
            if len(results) % 50 == 0 or len(results) == len(files):
                print(f"{len(results)}/{len(files)}: {dict(counts)}", flush=True)
    for client in clients:
        client.close()
    results.sort(key=lambda x: (x["board_index"] or len(boards) + 1, x["path"]))
    present = {x["board_index"] for x in results if x["board_index"]}
    report = {
        "repo_id": args.repo, "revision": revision,
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "source_range_path": str(args.range_path.resolve()),
        "source_range_sha256": hashlib.sha256(range_bytes).hexdigest(),
        "boards_sha256": hashlib.sha256(boards_bytes).hexdigest(),
        "expected_oop": oop_text, "expected_ip": ip_text,
        "expected_boards": len(boards), "artifact_count": len(files),
        "repo_artifact_count": len(repo_files), "unknown_repo_artifacts": unknown_files,
        "audit_start_index": args.start_index, "audit_end_index": end_index,
        "counts": dict(counts),
        "missing_board_indices": sorted(selected_indices - present),
        "files": results,
    }
    temporary = args.output.with_suffix(".tmp")
    temporary.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    temporary.replace(args.output)
    print(f"Wrote {args.output}", flush=True)
    return 1 if counts["unreadable"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
