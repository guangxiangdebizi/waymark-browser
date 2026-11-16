"""Install, start and stop the Waymark desktop app (an Electron + Node project)."""
from __future__ import annotations

import io
import json
import os
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import __version__
from .client import Client

REPO = "guangxiangdebizi/waymark-browser"
IS_WINDOWS = os.name == "nt"


def home() -> Path:
    return Path(os.environ.get("WAYMARK_HOME") or Path.home() / ".waymark")


def state_file() -> Path:
    return home() / "app.json"


def log_file() -> Path:
    return home() / "logs" / "app.log"


def is_app_dir(path: Path) -> bool:
    try:
        return json.loads((path / "package.json").read_text(encoding="utf-8-sig")).get("name") == "waymark-browser"
    except (OSError, ValueError):
        return False


def find_app_dir(explicit: str | None = None) -> Path | None:
    candidates = [explicit, os.environ.get("WAYMARK_APP_DIR"), str(home() / "app"), os.getcwd()]
    for candidate in candidates:
        if candidate and is_app_dir(Path(candidate).expanduser()):
            return Path(candidate).expanduser().resolve()
    return None


def tool(name: str) -> str | None:
    return shutil.which(name + ".cmd") if IS_WINDOWS and shutil.which(name + ".cmd") else shutil.which(name)


def node_version() -> tuple[int, ...] | None:
    node = tool("node")
    if not node:
        return None
    try:
        out = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=20).stdout.strip().lstrip("v")
        return tuple(int(part) for part in out.split(".")[:3])
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def has_ddddocr(python: str = sys.executable) -> bool:
    try:
        return subprocess.run([python, "-c", "import ddddocr"], capture_output=True, timeout=60).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def run(command: list[str], cwd: Path, env: dict | None = None) -> None:
    print("$ " + " ".join(command), flush=True)
    result = subprocess.run(command, cwd=cwd, env=env)
    if result.returncode:
        raise SystemExit(f"Command failed with exit code {result.returncode}: {' '.join(command)}")


# ---------------------------------------------------------------- setup
def download(ref: str) -> bytes:
    urls = [f"https://codeload.github.com/{REPO}/tar.gz/{ref}"]
    last = None
    for url in urls:
        try:
            with urllib.request.urlopen(url, timeout=120) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            last = error
    raise SystemExit(f"Could not download {REPO}@{ref}: {last}")


def safe_extract(archive: bytes, target: Path) -> None:
    """Extract a GitHub tarball, dropping its top-level folder and refusing paths outside target."""
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        root = target.resolve()
        for member in tar.getmembers():
            parts = Path(member.name).parts[1:]
            if not parts or member.issym() or member.islnk() or member.isdev():
                continue
            destination = (root / Path(*parts)).resolve()
            if root not in destination.parents and destination != root:
                raise SystemExit(f"Refusing to extract unsafe path: {member.name}")
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                destination.parent.mkdir(parents=True, exist_ok=True)
                source = tar.extractfile(member)
                destination.write_bytes(source.read() if source else b"")


def setup(app_dir: str | None, ref: str | None, skip_install: bool = False) -> Path:
    target = (Path(app_dir).expanduser() if app_dir else home() / "app").resolve()
    if target.exists() and (not target.is_dir() or
                            (any(target.iterdir()) and not is_app_dir(target)) or
                            (target / ".git").exists()):
        raise SystemExit(f"Refusing to replace {target}: choose an empty directory or a Waymark installation without .git.")
    ref = ref or f"v{__version__}"
    print(f"Downloading {REPO}@{ref} ...", flush=True)
    try:
        archive = download(ref)
    except SystemExit:
        if ref.startswith("v") and ref == f"v{__version__}":
            print(f"Tag {ref} not found; falling back to main.", flush=True)
            ref, archive = "main", download("main")
        else:
            raise
    target.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temp:
        staging = Path(temp) / "src"
        staging.mkdir()
        safe_extract(archive, staging)
        if not is_app_dir(staging):
            raise SystemExit("Downloaded archive is not a Waymark app checkout")
        # Replace code but keep user data (profile, audit ledger, settings) and node_modules.
        for item in target.iterdir():
            if item.name not in {"data", "node_modules", ".venv"}:
                shutil.rmtree(item) if item.is_dir() else item.unlink()
        for item in staging.iterdir():
            shutil.move(str(item), str(target / item.name))
    print(f"App source installed to {target}", flush=True)
    if skip_install:
        return target
    build(target)
    if not has_ddddocr():
        print('Local CAPTCHA OCR is optional. Enable it with: pip install "waymark-browser[ocr]"', flush=True)
    print("Done. Start the browser with: waymark start", flush=True)
    return target


def build(app_dir: Path) -> None:
    version = node_version()
    if not version:
        raise SystemExit("Node.js 22+ is required: https://nodejs.org/")
    if version < (22,):
        print(f"Warning: Node.js {'.'.join(map(str, version))} found; Waymark is tested on 22+.", flush=True)
    npm = tool("npm")
    if not npm:
        raise SystemExit("npm was not found next to Node.js")
    env = dict(os.environ)
    env.pop("NODE_ENV", None)
    run([npm, "ci", "--include=dev", "--no-audit", "--no-fund"], app_dir, env)
    run([npm, "run", "build"], app_dir, env)


# ---------------------------------------------------------------- start / stop
def read_state() -> dict:
    try:
        return json.loads(state_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def alive(pid: int | None) -> bool:
    if not pid:
        return False
    if IS_WINDOWS:
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
        return str(pid) in out
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def start(app_dir: str | None, port: int | None, foreground: bool, timeout: float, url: str | None) -> int:
    directory = find_app_dir(app_dir)
    if not directory:
        raise SystemExit("Waymark app not found. Install it with `waymark setup`, or pass --app-dir / set WAYMARK_APP_DIR.")
    client = Client(url or (f"http://127.0.0.1:{port}" if port else None), timeout=10)
    if client.health():
        print(f"Waymark is already running at {client.url}")
        return 0
    if not (directory / "dist" / "app" / "launcher.js").exists():
        build(directory)
    node = tool("node")
    if not node:
        raise SystemExit("Node.js 22+ is required: https://nodejs.org/")
    env = dict(os.environ)
    if port:
        env["WAYMARK_PORT"] = str(port)
    if "WAYMARK_PYTHON" not in env and has_ddddocr():
        env["WAYMARK_PYTHON"] = sys.executable
    if sys.platform.startswith("linux"):
        if not (env.get("DISPLAY") or env.get("WAYLAND_DISPLAY")):
            raise SystemExit("No display found. Waymark is a desktop app; on a headless server run: xvfb-run -a waymark start --foreground")
        if hasattr(os, "geteuid") and os.geteuid() == 0 and "--no-sandbox" not in env.get("WAYMARK_ELECTRON_ARGS", ""):
            env["WAYMARK_ELECTRON_ARGS"] = (env.get("WAYMARK_ELECTRON_ARGS", "") + " --no-sandbox").strip()
    command = [node, str(Path("dist") / "app" / "launcher.js")]
    if foreground:
        return subprocess.call(command, cwd=directory, env=env)
    log_file().parent.mkdir(parents=True, exist_ok=True)
    log = open(log_file(), "a", encoding="utf-8")
    kwargs: dict = {"cwd": directory, "env": env, "stdout": log, "stderr": subprocess.STDOUT, "stdin": subprocess.DEVNULL}
    if IS_WINDOWS:
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | 0x00000008  # DETACHED_PROCESS
    else:
        kwargs["start_new_session"] = True
    process = subprocess.Popen(command, **kwargs)
    state_file().parent.mkdir(parents=True, exist_ok=True)
    state_file().write_text(json.dumps({"pid": process.pid, "app_dir": str(directory), "url": client.url, "started": time.time()}), encoding="utf-8")
    deadline = time.time() + timeout
    while time.time() < deadline:
        if process.poll() is not None:
            raise SystemExit(f"Waymark exited during startup (code {process.returncode}). Log: {log_file()}")
        if client.health():
            print(f"Waymark is running. MCP endpoint: {client.url}/mcp")
            return 0
        time.sleep(1)
    raise SystemExit(f"Waymark did not become ready within {timeout:.0f}s. Log: {log_file()}")


def stop() -> int:
    state = read_state()
    pid = state.get("pid")
    if not alive(pid):
        print("No Waymark process started by this CLI is running.")
        state_file().unlink(missing_ok=True)
        return 0
    if IS_WINDOWS:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
    else:
        try:
            os.killpg(pid, signal.SIGTERM)
        except OSError:
            os.kill(pid, signal.SIGTERM)
        for _ in range(20):
            if not alive(pid):
                break
            time.sleep(0.25)
        else:
            try:
                os.killpg(pid, signal.SIGKILL)
            except OSError:
                pass
    state_file().unlink(missing_ok=True)
    print("Waymark stopped.")
    return 0


def doctor(app_dir: str | None, url: str | None) -> int:
    version = node_version()
    directory = find_app_dir(app_dir)
    client = Client(url, timeout=5)
    rows = [
        ("Python", f"{sys.version.split()[0]} ({sys.executable})", True),
        ("Node.js", ".".join(map(str, version)) if version else "missing - install Node.js 22+", bool(version) and version >= (22,)),
        ("npm", tool("npm") or "missing", bool(tool("npm"))),
        ("App directory", str(directory) if directory else "not installed - run `waymark setup`", bool(directory)),
        ("App built", "yes" if directory and (directory / "dist" / "app" / "launcher.js").exists() else "no", bool(directory and (directory / "dist" / "app" / "launcher.js").exists())),
        ("ddddocr (optional)", "installed" if has_ddddocr() else 'not installed - pip install "waymark-browser[ocr]"', True),
        ("Running", f"yes at {client.url}" if client.health() else "no", True),
    ]
    if sys.platform.startswith("linux"):
        display = os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")
        rows.append(("Display", display or "none - use xvfb-run on servers", bool(display)))
    width = max(len(name) for name, _, _ in rows)
    for name, value, ok in rows:
        print(f"{'OK ' if ok else '!! '} {name.ljust(width)}  {value}")
    return 0 if all(ok for _, _, ok in rows) else 1
