#!/usr/bin/env python3
"""
RTX 2080 Ti (11 GiB, sm_75) VRAM Arbiter & Training Guard for T3 Workstation.

Coordinates exclusive GPU access between T3 background indexing / Ollama inference
and local PyTorch SFT/DPO training pipelines:
  1. Writes a TTL-bounded `vram-training-lease.json` into T3's stateDir so
     `SemanticIndexJobs` and `OllamaEmbeddings` immediately pause background work.
  2. Queries local Ollama `/api/ps` and unloads every resident model via `keep_alive: 0`.
  3. Applies CUDA allocator anti-fragmentation env vars (`expandable_segments:True`).
  4. Always releases the T3 lease and clears CUDA cache on exit (normal or exception).

Usage as a CLI wrapper:
    python scripts/vram-arbiter-guard.py --state-dir E:\\NewAutoUsage\\userdata -- python train.py

Usage as a Python context manager:
    from vram_arbiter_guard import exclusive_rtx2080ti_training_guard
    with exclusive_rtx2080ti_training_guard(owner="seoyoon-dpo"):
        ...
"""

from __future__ import annotations

import argparse
import gc
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.request
import uuid
from contextlib import contextmanager
from typing import Iterator

DEFAULT_STATE_DIR = r"E:\NewAutoUsage\userdata"
LEASE_FILENAME = "vram-training-lease.json"
DEFAULT_OLLAMA_BASE = "http://127.0.0.1:11434"
DEFAULT_TTL_SECONDS = 3600


def configure_cuda_env() -> None:
    """Prevent CUDA allocator fragmentation on 11 GiB Turing GPUs."""
    os.environ.setdefault(
        "PYTORCH_CUDA_ALLOC_CONF",
        "expandable_segments:True,max_split_size_mb:128",
    )
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


def evict_all_ollama_vram(ollama_base: str = DEFAULT_OLLAMA_BASE) -> list[str]:
    """Unload every currently loaded Ollama model using keep_alive=0."""
    evicted: list[str] = []
    try:
        with urllib.request.urlopen(f"{ollama_base.rstrip('/')}/api/ps", timeout=3) as resp:
            running = json.loads(resp.read().decode("utf-8")).get("models", [])
        for item in running:
            model_name = item.get("name") or item.get("model")
            if not model_name:
                continue
            payload = json.dumps({"model": model_name, "keep_alive": 0}).encode("utf-8")
            req = urllib.request.Request(
                f"{ollama_base.rstrip('/')}/api/generate",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=5) as unload_resp:
                unload_resp.read()
            evicted.append(model_name)
    except Exception as exc:
        print(f"[VRAM-Arbiter] Ollama ps/evict warning: {exc}", file=sys.stderr)
    return evicted


def acquire_t3_lease(
    state_dir: str = DEFAULT_STATE_DIR,
    owner: str = "local-training",
    reason: str = "exclusive GPU training",
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
) -> dict:
    """Atomically write T3's vram-training-lease.json so background indexing pauses."""
    now_ms = int(time.time() * 1000)
    lease = {
        "leaseId": str(uuid.uuid4()),
        "owner": owner,
        "reason": reason,
        "acquiredAtMs": now_ms,
        "expiresAtMs": now_ms + max(5, int(ttl_seconds)) * 1000,
    }
    root = pathlib.Path(state_dir)
    root.mkdir(parents=True, exist_ok=True)
    target = root / LEASE_FILENAME
    tmp = root / f"{LEASE_FILENAME}.{uuid.uuid4()}.tmp"
    tmp.write_text(json.dumps(lease, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(target)
    return lease


def release_t3_lease(state_dir: str = DEFAULT_STATE_DIR, lease_id: str | None = None) -> bool:
    """Remove T3's vram-training-lease.json if present (and matching lease_id when provided)."""
    target = pathlib.Path(state_dir) / LEASE_FILENAME
    if not target.exists():
        return False
    if lease_id:
        try:
            current = json.loads(target.read_text(encoding="utf-8"))
            if current.get("leaseId") != lease_id:
                return False
        except Exception:
            pass
    target.unlink(missing_ok=True)
    return True


def read_t3_lease(state_dir: str = DEFAULT_STATE_DIR) -> dict | None:
    target = pathlib.Path(state_dir) / LEASE_FILENAME
    if not target.exists():
        return None
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
        if int(data.get("expiresAtMs", 0)) <= int(time.time() * 1000):
            return None
        return data
    except Exception:
        return None


@contextmanager
def exclusive_rtx2080ti_training_guard(
    state_dir: str = DEFAULT_STATE_DIR,
    owner: str = "local-training",
    reason: str = "exclusive GPU training",
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
    ollama_base: str = DEFAULT_OLLAMA_BASE,
    skip_ollama_evict: bool = False,
) -> Iterator[dict]:
    """Pause T3 background indexing, evict Ollama VRAM, and clean up on exit."""
    configure_cuda_env()
    lease = acquire_t3_lease(
        state_dir=state_dir,
        owner=owner,
        reason=reason,
        ttl_seconds=ttl_seconds,
    )
    evicted = [] if skip_ollama_evict else evict_all_ollama_vram(ollama_base)
    print(
        f"[VRAM-Arbiter] Lease acquired ({lease['leaseId']}); evicted Ollama models: {evicted}",
        flush=True,
    )
    try:
        yield {"lease": lease, "evicted": evicted}
    finally:
        release_t3_lease(state_dir=state_dir, lease_id=lease["leaseId"])
        gc.collect()
        try:
            import torch  # type: ignore

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.ipc_collect()
        except Exception:
            pass
        print(f"[VRAM-Arbiter] Lease released ({lease['leaseId']}).", flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="T3 VRAM Arbiter & Training Guard")
    parser.add_argument("--state-dir", default=DEFAULT_STATE_DIR)
    parser.add_argument("--ollama-base", default=DEFAULT_OLLAMA_BASE)
    parser.add_argument("--owner", default="local-training-cli")
    parser.add_argument("--reason", default="exclusive GPU training")
    parser.add_argument("--ttl-seconds", type=int, default=DEFAULT_TTL_SECONDS)
    parser.add_argument("--skip-ollama-evict", action="store_true")
    parser.add_argument("--status", action="store_true", help="Print active lease JSON and exit")
    parser.add_argument("command", nargs=argparse.REMAINDER, help="Command after -- to wrap")
    args = parser.parse_args(argv)

    if args.status:
        print(json.dumps({"activeLease": read_t3_lease(args.state_dir)}, ensure_ascii=False))
        return 0

    cmd = list(args.command)
    if cmd and cmd[0] == "--":
        cmd = cmd[1:]
    if not cmd:
        parser.error("Provide a command to execute after `--`, or pass `--status`.")

    with exclusive_rtx2080ti_training_guard(
        state_dir=args.state_dir,
        owner=args.owner,
        reason=args.reason,
        ttl_seconds=args.ttl_seconds,
        ollama_base=args.ollama_base,
        skip_ollama_evict=args.skip_ollama_evict,
    ):
        completed = subprocess.run(cmd, check=False)
        return int(completed.returncode)


if __name__ == "__main__":
    raise SystemExit(main())
