"""Where the vault is, resolved once for every remote-server module.

Order: `VAULT_PATH` env (the plugin passes it when it spawns the launcher; the
esbuild config uses the same name), then the first ancestor of this file that
looks like a vault (has `.obsidian/` and `00_System/AI/Claude/`), which covers
the installed layout `<vault>/.obsidian/plugins/vault-dashboard/remote-server/`
and any copy parked under `00_System/AI/Claude/tools/`. Running from a bare dev
clone needs the env var.
"""
import os
from pathlib import Path


def _find() -> Path:
    env = os.environ.get("VAULT_PATH") or os.environ.get("VAULT_ROOT")
    if env:
        p = Path(env).expanduser()
        if (p / "00_System/AI/Claude").is_dir():
            return p.resolve()
        raise SystemExit(f"VAULT_PATH={env} has no 00_System/AI/Claude")
    here = Path(__file__).resolve()
    for p in here.parents:
        if (p / ".obsidian").is_dir() and (p / "00_System/AI/Claude").is_dir():
            return p
    raise SystemExit("remote-server: set VAULT_PATH (not running inside a vault)")


VAULT = _find()
VAULT_NAME = VAULT.name
CLAUDE_DIR = VAULT / "00_System/AI/Claude"
TOOLS = CLAUDE_DIR / "tools"
DASHBOARD = TOOLS / "dashboard"
STATE = CLAUDE_DIR / "System Operations/state"
REGISTRY = CLAUDE_DIR / "System Operations/session-registry.json"
PLUGIN_DIR = VAULT / ".obsidian/plugins/vault-dashboard"
STATE_DIR = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "vault-remote"


def vault_rel(p) -> str | None:
    """Vault-relative path for an absolute path inside the vault, else None."""
    if not p:
        return None
    q = str(p).replace("\\", "/")
    root = str(VAULT).replace("\\", "/").rstrip("/") + "/"
    i = q.lower().find(root.lower())
    return q[i + len(root):] if i >= 0 else None


def launcher_rel() -> str:
    """The launcher's path relative to the vault, for hints shown to the operator."""
    try:
        return str(Path(__file__).resolve().parent.relative_to(VAULT)).replace("\\", "/") + "/launch.py"
    except ValueError:
        return str(Path(__file__).resolve().parent / "launch.py")
