#!/usr/bin/env python3
"""Prove wrap_proto_session.py against the checked-in mini host fixture."""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import wrap_proto_session  # noqa: E402

FIXTURE = HERE / "fixtures" / "stock-host-mini.cjs"
RUNTIME = HERE / "opengrok-runtime.cjs"


def run(cmd, env=None, cwd=None):
    r = subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=cwd)
    if r.returncode != 0:
        sys.stderr.write(r.stdout + r.stderr)
        raise SystemExit(r.returncode)
    return r


def main():
    src = FIXTURE.read_text(encoding="utf-8")
    c = wrap_proto_session.census(src)
    assert c["function createProtoSession("] == 1, c
    assert c["already_wrapped"] is False, c

    wrapped = wrap_proto_session.wrap(src, str(RUNTIME))
    assert wrap_proto_session.MARKER in wrapped
    assert wrapped.count("function createProtoSession(") == 1
    assert wrapped.count("function createProtoSession_stock(") == 1
    again = wrap_proto_session.wrap(wrapped, str(RUNTIME))
    assert again == wrapped

    try:
        wrap_proto_session.wrap("function other(){}", str(RUNTIME))
        raise SystemExit("expected ValueError on missing factory")
    except ValueError:
        pass

    refuse = subprocess.run(
        [sys.executable, str(HERE / "apply-box-patch.py"), "--host", str(FIXTURE), "--dry-run"],
        capture_output=True, text=True,
    )
    if refuse.returncode == 0 or "install-stock-box.py" not in (refuse.stderr or ""):
        sys.stderr.write(refuse.stdout + refuse.stderr)
        raise SystemExit("apply-box-patch.py must refuse the stock fixture")

    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        host = td / "host.cjs"
        host.write_text(wrapped, encoding="utf-8")
        run(["node", "--check", str(host)])
        bindings = td / "model-bindings.json"
        bindings.write_text(json.dumps({
            "agents": {
                "*": {
                    "name": "fixture",
                    "modelId": "glm-5.3-flash",
                    "hopBaseUrl": "http://127.0.0.1:18790/v1",
                    "parameters": [{"id": "fast", "value": "true"}],
                }
            }
        }) + "\n", encoding="utf-8")
        env = os.environ.copy()
        env["OPENGROK_BINDINGS"] = str(bindings)
        probe = td / "probe.cjs"
        probe.write_text(
            "const m = require(%s);\n"
            "const s = m.ping();\n"
            "if (!s || s.opengrok !== true) {\n"
            "  console.error('expected opengrok session', s);\n"
            "  process.exit(1);\n"
            "}\n"
            "if (s.modelId !== 'glm-5.3-flash') {\n"
            "  console.error('modelId', s.modelId);\n"
            "  process.exit(1);\n"
            "}\n"
            "console.log('wrap-ok');\n" % json.dumps(str(host)),
            encoding="utf-8",
        )
        out = run(["node", str(probe)], env=env)
        if "wrap-ok" not in out.stdout:
            raise SystemExit("missing wrap-ok: " + out.stdout)

    print("wrap_proto_session: ok")


if __name__ == "__main__":
    main()
