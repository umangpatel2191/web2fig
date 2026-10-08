"""
Web2Fig helper on a Hugging Face *Gradio* Space.

A Gradio Space simply runs this file. It starts the Web2Fig helper (a Node server, `server.mjs`) on the port the Space
exposes, and keeps it running. There is no Gradio UI: the Space's public address is the helper's API, which the
Web2Fig Figma plugin calls. Open the address in a browser and you should see a green "Web2Fig helper is running".

Node and Chrome are fetched on first start if the machine does not already have them.
"""
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = os.environ.get("PORT") or os.environ.get("GRADIO_SERVER_PORT") or "7860"
NODE_VERSION = "20.18.0"
TOOLS = os.path.join("/tmp", "web2fig-tools")


def log(msg):
    print(f"[web2fig] {msg}", flush=True)


def node_ok(path):
    try:
        out = subprocess.check_output([path, "--version"], text=True, timeout=20).strip()
        return int(out.lstrip("v").split(".")[0]) >= 18
    except Exception:
        return False


def ensure_node():
    """Use the system Node when it is new enough, otherwise download the official build once."""
    found = shutil.which("node")
    if found and node_ok(found):
        return found
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine().lower(), "x64")
    name = f"node-v{NODE_VERSION}-linux-{arch}"
    target = os.path.join(TOOLS, name, "bin", "node")
    if os.path.exists(target) and node_ok(target):
        return target
    os.makedirs(TOOLS, exist_ok=True)
    url = f"https://nodejs.org/dist/v{NODE_VERSION}/{name}.tar.xz"
    archive = os.path.join(TOOLS, f"{name}.tar.xz")
    log(f"downloading Node {NODE_VERSION} …")
    urllib.request.urlretrieve(url, archive)
    with tarfile.open(archive, "r:xz") as tar:
        tar.extractall(TOOLS)
    os.remove(archive)
    return target


def main():
    node = ensure_node()
    log(f"using Node at {node}")
    env = dict(os.environ)
    env.update(
        {
            "WEB2FIG_PUBLIC": "1",
            "PORT": str(PORT),
            "WEB2FIG_CACHE": os.path.join("/tmp", "web2fig-chrome"),
            "HOME": os.environ.get("HOME", "/tmp"),
        }
    )
    while True:  # restart the server if it ever exits
        code = subprocess.call([node, "server.mjs"], cwd=HERE, env=env)
        log(f"server exited with code {code}; restarting in 3s")
        time.sleep(3)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
