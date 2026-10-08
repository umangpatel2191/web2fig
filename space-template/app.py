"""
Web2Fig helper on a Hugging Face *Gradio* Space.

The Space's public address is the helper's API, which the Web2Fig Figma plugin calls. Inside, `server.mjs` (a Node
server) does the work on a private port, and this file is a thin front door:

  * everything except /ui is forwarded as-is to the Node helper (/health, /capture, ...);
  * /ui is a tiny Gradio page with one @spaces.GPU function. It is never used for real work. Accounts that can only
    create *ZeroGPU* Spaces need such a function, otherwise the Space refuses to start ("No @spaces.GPU function").

Node and Chrome are fetched on first start if the machine does not already have them.
"""
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request

import gradio as gr
import httpx
import spaces
import uvicorn
from fastapi import FastAPI, Request
from starlette.background import BackgroundTask
from starlette.responses import StreamingResponse

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC_PORT = int(os.environ.get("PORT") or os.environ.get("GRADIO_SERVER_PORT") or "7860")
NODE_PORT = 5810
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


def run_node_forever():
    node = ensure_node()
    log(f"using Node at {node}")
    env = dict(os.environ)
    env.update(
        {
            "WEB2FIG_PUBLIC": "1",
            "PORT": str(NODE_PORT),
            "WEB2FIG_CACHE": os.path.join("/tmp", "web2fig-chrome"),
            "HOME": os.environ.get("HOME", "/tmp"),
        }
    )
    while True:  # restart the helper if it ever exits
        code = subprocess.call([node, "server.mjs"], cwd=HERE, env=env)
        log(f"helper exited with code {code}; restarting in 3s")
        time.sleep(3)


# ---- the ZeroGPU placeholder (never used for real work) ----
@spaces.GPU
def gpu_placeholder(text: str) -> str:
    return text


demo = gr.Interface(fn=gpu_placeholder, inputs="text", outputs="text", title="Web2Fig helper", api_name=False)

app = FastAPI()
app = gr.mount_gradio_app(app, demo, path="/ui")  # mounted first so the catch-all below does not shadow it

client = httpx.AsyncClient(base_url=f"http://127.0.0.1:{NODE_PORT}", timeout=None)
HOP = {"connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authenticate", "proxy-authorization"}


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"])
async def forward(path: str, request: Request):
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP and k.lower() != "host"}
    if "x-forwarded-for" not in {k.lower() for k in headers} and request.client:
        headers["x-forwarded-for"] = request.client.host
    try:
        upstream = await client.send(
            client.build_request(request.method, "/" + path, params=request.query_params, headers=headers, content=request.stream()),
            stream=True,
        )
    except httpx.ConnectError:
        return StreamingResponse(iter([b'{"ok":false,"error":"The helper is still starting. Try again in a few seconds."}']), status_code=503, media_type="application/json")
    out = {k: v for k, v in upstream.headers.items() if k.lower() not in HOP}
    return StreamingResponse(upstream.aiter_raw(), status_code=upstream.status_code, headers=out, background=BackgroundTask(upstream.aclose))


if __name__ == "__main__":
    threading.Thread(target=run_node_forever, daemon=True).start()
    uvicorn.run(app, host="0.0.0.0", port=PUBLIC_PORT, log_level="warning")
