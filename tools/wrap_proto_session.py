#!/usr/bin/env python3
"""Wrap stock `createProtoSession` so Grok Bot turns can hit a local OpenAI hop.

Stock `host-main.cjs` (issues #3, #5) has no OpenAI hop lane. The live factory
is `createProtoSession`. This transform is idempotent:

  1. Prepend a same-name wrapper that calls `opengrok-runtime.wrapSession`.
  2. Rename the original definition to `createProtoSession_stock`.

Fails closed unless there is exactly one `function createProtoSession(` definition.
"""
from __future__ import annotations

import json

MARKER = "/* opengrok-stock-wrap */"
DEF = "function createProtoSession("
STOCK_DEF = "function createProtoSession_stock("


def census(src: str) -> dict:
    return {
        "createProtoSession": src.count("createProtoSession"),
        "function createProtoSession(": src.count(DEF),
        "createOpenAiHopSession": src.count("createOpenAiHopSession"),
        "resolvedOpenaiBaseUrl": src.count("resolvedOpenaiBaseUrl"),
        "hopBaseUrl": src.count("hopBaseUrl"),
        "model-bindings": src.count("model-bindings"),
        "already_wrapped": MARKER in src,
        "bytes": len(src.encode("utf-8")),
    }


def wrap(src: str, runtime_path: str) -> str:
    if MARKER in src:
        return src
    defs = src.count(DEF)
    if defs != 1:
        raise ValueError(
            "need exactly 1 `%s` definition, found %d. "
            "This bundle is not the stock proto-session shape. "
            "Re-run with --census-only and file a capture."
            % (DEF, defs)
        )
    header = (
        MARKER + "\n"
        "var __opengrokRuntime = require(%s);\n"
        "function createProtoSession() {\n"
        "  return __opengrokRuntime.wrapSession(createProtoSession_stock, arguments);\n"
        "}\n"
    ) % json.dumps(runtime_path)
    return header + src.replace(DEF, STOCK_DEF, 1)
