"""
Web2Fig helper on a Hugging Face *Gradio* Space.

The Space's public address is the helper's API, which the Web2Fig Figma plugin calls. Inside, `server.mjs` (a Node
server) does the work on a private port, and this file is a thin front door:

  * /health, /capture and /jobs/* are forwarded as-is to the Node helper;
  * the Gradio page at / is a tiny placeholder with one @spaces.GPU function. It is never used for real work, but
    accounts that can only create *ZeroGPU* Spaces need one, otherwise the Space refuses to start.

Node and Chrome are fetched on first start if the machine does not already have them.
"""
import inspect
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
from fastapi import Request
from starlette.background import BackgroundTask
from starlette.responses import Response, StreamingResponse

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

client = httpx.AsyncClient(base_url=f"http://127.0.0.1:{NODE_PORT}", timeout=None)
HOP = {"connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authenticate", "proxy-authorization", "host"}
CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-web2fig",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
}


async def forward(request: Request):
    """Pass the request to the Node helper and stream its answer back."""
    if request.method == "OPTIONS":
        return Response(status_code=204, headers=CORS)
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP}
    if "x-forwarded-for" not in {k.lower() for k in headers} and request.client:
        headers["x-forwarded-for"] = request.client.host
    try:
        upstream = await client.send(
            client.build_request(request.method, request.url.path, params=request.query_params, headers=headers, content=request.stream()),
            stream=True,
        )
    except httpx.ConnectError:
        return Response(b'{"ok":false,"error":"The helper is still starting. Try again in a few seconds."}', status_code=503, media_type="application/json", headers=CORS)
    out = {k: v for k, v in upstream.headers.items() if k.lower() not in HOP and not k.lower().startswith("access-control-")}
    out.update(CORS)
    return StreamingResponse(upstream.aiter_raw(), status_code=upstream.status_code, headers=out, background=BackgroundTask(upstream.aclose))


if __name__ == "__main__":
    threading.Thread(target=run_node_forever, daemon=True).start()
    # The standard ZeroGPU launch (so the Space starts), plus our routes on Gradio's own server.
    wanted = dict(server_name="0.0.0.0", server_port=PUBLIC_PORT, prevent_thread_lock=True, ssr_mode=False, strict_cors=False)
    supported = inspect.signature(gr.Blocks.launch).parameters  # newer Gradio versions drop some options
    demo.launch(**{k: v for k, v in wanted.items() if k in supported})
    fastapi_app = demo.app
    for path in ("/health", "/capture", "/jobs/{rest:path}"):
        fastapi_app.add_api_route(path, forward, methods=["GET", "POST", "DELETE", "OPTIONS"], include_in_schema=False)
        fastapi_app.router.routes.insert(0, fastapi_app.router.routes.pop())  # ahead of Gradio's own routes
    log("ready")
    demo.block_thread()
