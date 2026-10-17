"""ComfyUI client and the two Qwen-Image 2.1 workflows (API format).

The built-in graphs use GGUF diffusion, QwenImage21Cache and the configured
text encoder. Model names and devices are configured through the environment.
A job id is ComfyUI's own prompt id, so the gateway keeps no state.
"""

from __future__ import annotations

import io
import ipaddress
import random
import socket
import time
import uuid
from typing import Any
from urllib.parse import urlparse

import httpx
from PIL import Image, ImageDraw, ImageFilter

from app.config import Settings
from app.errors import GatewayError
from app.workflows import Workflows

ASPECT_RATIOS = {
    "1:1": (1024, 1024),
    "4:3": (1184, 880),
    "3:4": (880, 1184),
    "3:2": (1248, 832),
    "2:3": (832, 1248),
    "16:9": (1360, 768),
    "9:16": (768, 1360),
    "21:9": (1568, 672),
}
MAX_SIDE = 2048
MAX_INPUT_BYTES = 30 * 1024 * 1024
MAX_REFERENCE_IMAGES = 3
PREVIEW_SIDE = 1536
ALPHA_FLOOR = 8  # inpaint: alpha below this (of 255) becomes fully transparent
REGION_GROW = 24  # inpaint: pixels added around `regions`
PREVIEW_MAX_BYTES = 900 * 1024


def _size(args: dict[str, Any]) -> tuple[int, int]:
    if args.get("width") or args.get("height"):
        width, height = int(args.get("width") or 1024), int(args.get("height") or 1024)
    else:
        ratio = str(args.get("aspect_ratio") or "1:1")
        if ratio not in ASPECT_RATIOS:
            raise GatewayError(400, f"aspect_ratio must be one of {', '.join(ASPECT_RATIOS)}")
        width, height = ASPECT_RATIOS[ratio]
    width, height = (max(256, min(MAX_SIDE, v)) // 16 * 16 for v in (width, height))
    return width, height


def _steps(args: dict[str, Any]) -> int:
    return max(1, min(50, int(args.get("steps") or 25)))


def _seed(args: dict[str, Any]) -> int:
    seed = args.get("seed")
    return int(seed) if seed is not None else random.randrange(2**48)


class Comfy:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.http = httpx.Client(base_url=settings.comfy_url, timeout=30)
        self.last_activity = time.monotonic()
        self.freed = True
        self.workflows = Workflows(self._call, settings.workflow_dir)

    # --- low level -------------------------------------------------------

    def _call(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        try:
            response = self.http.request(method, path, **kwargs)
        except httpx.HTTPError as e:
            raise GatewayError(
                503, f"ComfyUI is not reachable at {self.settings.comfy_url} ({type(e).__name__})"
            ) from None
        if response.status_code >= 400:
            raise GatewayError(502, f"ComfyUI {path} -> {response.status_code}: {response.text[:500]}")
        return response

    def _loaders(self) -> dict[str, Any]:
        s = self.settings
        return {
            "1": {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": s.unet}},
            "2": {
                "class_type": "CLIPLoader",
                "inputs": {
                    "clip_name": s.text_encoder,
                    "type": "qwen_image",
                    "device": s.encoder_device,
                },
            },
            "3": {"class_type": "VAELoader", "inputs": {"vae_name": s.vae}},
            "5": {
                "class_type": "QwenImage21Cache",
                "inputs": {"model": ["1", 0], "device": "cpu", "dtype": "default"},
            },
        }

    def _sampler(self, args: dict[str, Any], latent: list[Any], seed: int) -> dict[str, Any]:
        return {
            "6": {
                "class_type": "KSampler",
                "inputs": {
                    "model": ["5", 0],
                    "positive": ["4", 0],
                    "negative": ["4", 1],
                    "latent_image": latent,
                    "seed": seed,
                    "steps": _steps(args),
                    "cfg": 1,
                    "sampler_name": "euler",
                    "scheduler": "simple",
                    "denoise": 1,
                },
            },
            "7": {"class_type": "VAEDecode", "inputs": {"samples": ["6", 0], "vae": ["3", 0]}},
        }

    def _submit(self, graph: dict[str, Any], kind: str, seed: int, extra: dict) -> dict[str, Any]:
        graph["8"] = {
            "class_type": "SaveImage",
            "inputs": {"images": ["7", 0], "filename_prefix": f"gateway/{kind}"},
        }
        return self.enqueue(graph) | {"kind": kind, "seed": seed, **extra}

    def enqueue(self, graph: dict[str, Any]) -> dict[str, Any]:
        try:
            response = self.http.post("/prompt", json={"prompt": graph})
        except httpx.HTTPError as e:
            raise GatewayError(
                503, f"ComfyUI is not reachable at {self.settings.comfy_url} ({type(e).__name__})"
            ) from None
        body = response.json() if response.content else {}
        problems = [
            f"node {node_id} ({info.get('class_type')}): "
            + "; ".join(f"{e.get('message')} {e.get('details', '')}".strip() for e in info["errors"])
            for node_id, info in (body.get("node_errors") or {}).items()
        ]
        if response.status_code >= 400 or problems:
            message = (body.get("error") or {}).get("message", f"HTTP {response.status_code}")
            raise GatewayError(400, "ComfyUI rejected the workflow: " + " | ".join(problems or [message]))
        self.last_activity, self.freed = time.monotonic(), False
        return {"job_id": body["prompt_id"], "status": "queued"}

    def run_workflow(self, graph: dict[str, Any], inputs: dict[str, Any] | None) -> dict[str, Any]:
        """Queue an arbitrary API-format workflow. `inputs` overrides values
        as {"<node_id>.<input_name>": value}; image references given for a
        LoadImage node are fetched first, and a seed of -1 is randomized."""
        graph = {node_id: {**node, "inputs": dict(node["inputs"])} for node_id, node in graph.items()}
        for key, value in (inputs or {}).items():
            node_id, _, name = str(key).partition(".")
            if node_id not in graph or not name:
                raise GatewayError(400, f"inputs key {key!r} is not '<node_id>.<input_name>'")
            graph[node_id]["inputs"][name] = value
        seeds: dict[str, int] = {}
        for node_id, node in graph.items():
            for name, value in node["inputs"].items():
                if name in ("seed", "noise_seed") and value == -1:
                    node["inputs"][name] = seeds[f"{node_id}.{name}"] = random.randrange(2**48)
                elif (
                    node["class_type"] == "LoadImage"
                    and name == "image"
                    and isinstance(value, str)
                    and value.startswith(("https://", "job:"))
                ):
                    node["inputs"][name] = self.resolve_image(value)
        return self.enqueue(graph) | {"kind": "workflow", "seeds": seeds}

    # --- public operations ----------------------------------------------

    def generate(self, args: dict[str, Any]) -> dict[str, Any]:
        prompt = str(args.get("prompt") or "").strip()
        if not prompt:
            raise GatewayError(400, "prompt is required")
        width, height = _size(args)
        seed = _seed(args)
        graph = self._loaders() | self._sampler(args, ["9", 0], seed)
        graph["4"] = {
            "class_type": "TextEncodeQwenImage21",
            "inputs": {
                "clip": ["2", 0],
                "prompt": prompt,
                "negative_prompt": str(args.get("negative_prompt") or ""),
                "resolution": 1024,
            },
        }
        graph["9"] = {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": width, "height": height, "batch_size": 1},
        }
        return self._submit(graph, "generate", seed, {"width": width, "height": height})

    def edit(self, args: dict[str, Any]) -> dict[str, Any]:
        prompt = str(args.get("prompt") or "").strip()
        if not prompt:
            raise GatewayError(400, "prompt is required")
        refs = args.get("images") or []
        if isinstance(refs, str):
            refs = [refs]
        if not 1 <= len(refs) <= MAX_REFERENCE_IMAGES:
            raise GatewayError(400, f"images needs 1 to {MAX_REFERENCE_IMAGES} entries")
        names = [self.resolve_image(str(ref)) for ref in refs]
        resolution = max(0, min(MAX_SIDE, int(args.get("resolution", 1024)))) // 32 * 32
        seed = _seed(args)
        graph = self._loaders() | self._sampler(args, ["4", 2], seed)
        encode = {
            "clip": ["2", 0],
            "vae": ["3", 0],
            "prompt": prompt,
            "negative_prompt": str(args.get("negative_prompt") or ""),
            "resolution": resolution,
        }
        for i, name in enumerate(names, start=1):
            graph[str(9 + i)] = {"class_type": "LoadImage", "inputs": {"image": name}}
            encode[f"images.image_{i}"] = [str(9 + i), 0]
        graph["4"] = {"class_type": "TextEncodeQwenImage21", "inputs": encode}
        return self._submit(graph, "edit", seed, {"inputs": names, "resolution": resolution})

    def inpaint(self, args: dict[str, Any]) -> dict[str, Any]:
        """Masked edit with LanPaint: only the masked part of `image` is
        regenerated, and the rest (transparency included) is put back as it was."""
        prompt = str(args.get("prompt") or "").strip()
        if not prompt:
            raise GatewayError(400, "prompt is required")
        if not args.get("image"):
            raise GatewayError(400, "image is required")
        name = self.resolve_image(str(args["image"]))
        refs = args.get("references") or []
        if isinstance(refs, str):
            refs = [refs]
        if len(refs) > MAX_REFERENCE_IMAGES - 1:
            raise GatewayError(400, f"references takes at most {MAX_REFERENCE_IMAGES - 1} entries")
        ref_names = [self.resolve_image(str(ref)) for ref in refs]
        size = Image.open(io.BytesIO(self.input_image(name))).size
        mask, coverage = self._mask(args, size)
        mask_name = self.upload(mask, "mask.png")
        seed = _seed(args)
        steps = max(1, min(50, int(args.get("steps") or 20)))
        thinking = max(1, min(10, int(args.get("thinking_steps") or 5)))
        graph = self._loaders()
        graph["10"] = {"class_type": "LoadImage", "inputs": {"image": name}}
        graph["11"] = {
            "class_type": "JoinImageWithAlpha",
            "inputs": {"image": ["10", 0], "alpha": ["10", 1]},
        }
        graph["12"] = {
            "class_type": "LoadImageMask",
            "inputs": {"image": mask_name, "channel": "red"},
        }
        encode = {
            "clip": ["2", 0],
            "vae": ["3", 0],
            "prompt": prompt,
            "negative_prompt": str(args.get("negative_prompt") or ""),
            "resolution": 0,
            "images.image_1": ["11", 0],
        }
        for i, ref_name in enumerate(ref_names, start=2):
            graph[str(100 + i)] = {"class_type": "LoadImage", "inputs": {"image": ref_name}}
            encode[f"images.image_{i}"] = [str(100 + i), 0]
        graph["4"] = {"class_type": "TextEncodeQwenImage21", "inputs": encode}
        graph["20"] = {
            "class_type": "LanPaint_ImageEncode",
            "inputs": {"image": ["11", 0], "vae": ["3", 0], "mask": ["12", 0]},
        }
        graph["6"] = {
            "class_type": "LanPaint_KSampler",
            "inputs": {
                "model": ["5", 0],
                "positive": ["4", 0],
                "negative": ["4", 1],
                "latent_image": ["20", 0],
                "seed": seed,
                "steps": steps,
                "cfg": float(args.get("cfg") or 4.0),
                "sampler_name": "euler",
                "scheduler": "simple",
                "denoise": 1.0,
                "LanPaint_NumSteps": thinking,
                "LanPaint_PromptMode": "Image First",
                "LanPaint_Info": "",
                "Inpainting_mode": "🖼️ Image Inpainting",
            },
        }
        graph["30"] = {
            "class_type": "LanPaint_ImageDecode",
            "inputs": {
                "samples": ["6", 0],
                "vae": ["3", 0],
                "image": ["11", 0],
                "mask": ["12", 0],
                "blend_overlap": max(0, min(64, int(args.get("blend", 9)))),
            },
        }
        # The model returns "transparent" as a faint tint (alpha 1-2 of 255)
        # over arbitrary colours. Snap near-transparent pixels back to fully
        # transparent black; real edges and soft shadows are left alone.
        graph["31"] = {"class_type": "SplitImageWithAlpha", "inputs": {"image": ["30", 0]}}
        graph["32"] = {
            "class_type": "ThresholdMask",
            "inputs": {"mask": ["31", 1], "value": 1 - ALPHA_FLOOR / 255},
        }
        graph["33"] = {
            "class_type": "MaskComposite",
            "inputs": {
                "destination": ["31", 1],
                "source": ["32", 0],
                "x": 0,
                "y": 0,
                "operation": "add",
            },
        }
        graph["34"] = {
            "class_type": "EmptyImage",
            "inputs": {"width": size[0], "height": size[1], "batch_size": 1, "color": 0},
        }
        graph["35"] = {
            "class_type": "ImageCompositeMasked",
            "inputs": {
                "destination": ["31", 0],
                "source": ["34", 0],
                "x": 0,
                "y": 0,
                "resize_source": False,
                "mask": ["32", 0],
            },
        }
        graph["7"] = {
            "class_type": "JoinImageWithAlpha",
            "inputs": {"image": ["35", 0], "alpha": ["33", 0]},
        }
        extra = {
            "input": name,
            "mask": mask_name,
            "width": size[0],
            "height": size[1],
            "masked_percent": coverage,
        }
        return self._submit(graph, "inpaint", seed, extra)

    def _mask(self, args: dict[str, Any], size: tuple[int, int]) -> tuple[bytes, float]:
        """White = regenerate. From a mask image (resized to the picture) or
        from `regions`, boxes or ellipses in the picture's pixels."""
        if args.get("mask"):
            source = Image.open(io.BytesIO(self.input_image(self.resolve_image(str(args["mask"])))))
            mask = source.convert("L")
            if mask.size != size:
                mask = mask.resize(size, Image.Resampling.BILINEAR)
        elif args.get("regions"):
            regions = args["regions"]
            mask = Image.new("L", size, 0)
            draw = ImageDraw.Draw(mask)
            for region in [regions] if isinstance(regions, dict) else regions:
                try:
                    x, y = float(region["x"]), float(region["y"])
                    box = [x, y, x + float(region["width"]), y + float(region["height"])]
                except (KeyError, TypeError, ValueError):
                    raise GatewayError(400, "a region needs x, y, width and height") from None
                if region.get("shape") == "ellipse":
                    draw.ellipse(box, fill=255)
                else:
                    draw.rectangle(box, fill=255)
        else:
            raise GatewayError(400, "give mask (an image, white = change) or regions")
        # Regions are rough by nature and a tight one leaves the old object's
        # rim behind, so they get a margin; a mask image is taken as drawn.
        grow = int(args.get("grow", REGION_GROW if args.get("regions") and not args.get("mask") else 0))
        if grow > 0:
            mask = mask.filter(ImageFilter.MaxFilter(2 * min(grow, 128) + 1))
        coverage = round(100 * sum(mask.point(lambda v: 255 if v > 127 else 0).histogram()[255:]) / (size[0] * size[1]), 1)
        if coverage == 0:
            raise GatewayError(400, "the mask is empty: nothing would change")
        out = io.BytesIO()
        mask.convert("RGB").save(out, "PNG")
        return out.getvalue(), coverage

    def input_image(self, name: str) -> bytes:
        folder, _, base = name.replace("\\", "/").rpartition("/")
        params = {"filename": base, "subfolder": folder, "type": "input"}
        return self._call("GET", "/view", params=params).content

    def resolve_image(self, ref: str) -> str:
        """A reference is an https URL, `job:<job_id>` (that job's first
        output), or the name of an already uploaded input image."""
        if ref.startswith(("http://", "https://")):
            return self.upload(_download(ref), "url.png")
        if ref.startswith("job:"):
            data, _ = self.output_image(ref[4:].strip(), 0)
            return self.upload(data, "job.png")
        if "/" in ref or "\\" in ref or not ref:
            raise GatewayError(400, f"not an image reference: {ref!r}")
        return ref

    def upload(self, data: bytes, filename: str) -> str:
        if len(data) > MAX_INPUT_BYTES:
            raise GatewayError(413, "image is larger than 30 MB")
        try:
            image = Image.open(io.BytesIO(data))
            image.load()
        except Exception:
            raise GatewayError(400, "not a readable image") from None
        out = io.BytesIO()
        image.convert("RGBA" if "A" in image.getbands() else "RGB").save(out, "PNG")
        name = f"gw-{uuid.uuid4().hex[:12]}.png"
        files = {"image": (name, out.getvalue(), "image/png")}
        body = self._call("POST", "/upload/image", files=files, data={"overwrite": "true"}).json()
        return body["name"]

    def job(self, job_id: str) -> dict[str, Any]:
        if not job_id.replace("-", "").isalnum():
            raise GatewayError(400, "invalid job_id")
        history = self._call("GET", f"/history/{job_id}").json().get(job_id)
        if history:
            status = history.get("status", {})
            times = {m[0]: m[1].get("timestamp") for m in status.get("messages", [])}
            images = [
                image
                for node in history.get("outputs", {}).values()
                for image in node.get("images", [])
                if image.get("type") == "output"
            ]
            result: dict[str, Any] = {"job_id": job_id, "images": len(images)}
            if status.get("status_str") == "success":
                result["status"] = "done"
                if "execution_start" in times and "execution_success" in times:
                    took = (times["execution_success"] - times["execution_start"]) / 1000
                    result["seconds"] = round(took, 1)
            else:
                result["status"] = "failed"
                errors = [m[1] for m in status.get("messages", []) if m[0] == "execution_error"]
                if errors:
                    e = errors[0]
                    result["error"] = f"{e.get('node_type')}: {e.get('exception_message')}"[:800]
            result["_files"] = images
            return result
        queue = self._call("GET", "/queue").json()
        for item in queue.get("queue_running", []):
            if item[1] == job_id:
                return {"job_id": job_id, "status": "running"}
        pending = sorted(queue.get("queue_pending", []), key=lambda item: item[0])
        for position, item in enumerate(pending, start=1):
            if item[1] == job_id:
                return {"job_id": job_id, "status": "queued", "queue_position": position}
        raise GatewayError(404, "no such job (ComfyUI forgets jobs when it restarts)")

    def wait(self, job_id: str, seconds: float) -> dict[str, Any]:
        deadline = time.monotonic() + max(0.0, min(50.0, seconds))
        while True:
            job = self.job(job_id)
            if job["status"] in ("done", "failed") or time.monotonic() >= deadline:
                return job
            time.sleep(0.5)

    def output_image(self, job_id: str, index: int) -> tuple[bytes, str]:
        job = self.job(job_id)
        files = job.get("_files") or []
        if job["status"] != "done" or not 0 <= index < len(files):
            raise GatewayError(404, f"job has no finished image #{index} (status {job['status']})")
        f = files[index]
        params = {"filename": f["filename"], "subfolder": f.get("subfolder", ""), "type": "output"}
        return self._call("GET", "/view", params=params).content, f["filename"]

    def preview(self, job_id: str, index: int = 0) -> tuple[bytes, bool]:
        """A JPEG small enough to hand back inline to a chat client, and
        whether the picture has transparency (shown on white: JPEG has none,
        and the colours stored under transparent pixels are arbitrary)."""
        data, _ = self.output_image(job_id, index)
        image = Image.open(io.BytesIO(data))
        transparent = "A" in image.getbands() and image.getchannel("A").getextrema()[0] < 255
        if transparent:
            image = image.convert("RGBA")
            image = Image.alpha_composite(Image.new("RGBA", image.size, "white"), image)
        image = image.convert("RGB")
        image.thumbnail((PREVIEW_SIDE, PREVIEW_SIDE))
        for quality in (88, 80, 70, 60):
            out = io.BytesIO()
            image.save(out, "JPEG", quality=quality)
            if out.tell() <= PREVIEW_MAX_BYTES:
                break
        return out.getvalue(), transparent

    def status(self) -> dict[str, Any]:
        stats = self._call("GET", "/system_stats").json()
        queue = self._call("GET", "/queue").json()
        device = (stats.get("devices") or [{}])[0]
        gib = 2**30
        return {
            "comfyui_version": stats.get("system", {}).get("comfyui_version"),
            "gpu": device.get("name"),
            "vram_total_gb": round(device.get("vram_total", 0) / gib, 1),
            "vram_free_gb": round(device.get("vram_free", 0) / gib, 1),
            "running": len(queue.get("queue_running", [])),
            "queued": len(queue.get("queue_pending", [])),
            "models": {
                "diffusion": self.settings.unet,
                "text_encoder": f"{self.settings.text_encoder} ({self.settings.encoder_device})",
                "vae": self.settings.vae,
            },
        }

    def free(self) -> dict[str, Any]:
        self._call("POST", "/free", json={"unload_models": True, "free_memory": True})
        self.freed = True
        return {"freed": True}

    def idle_tick(self) -> None:
        """Called once a minute: unload models after a quiet period so the
        GPU is free for whatever else the PC is used for."""
        limit = self.settings.idle_free_minutes * 60
        if limit <= 0:
            return
        try:
            queue = self.http.get("/queue").json()
        except Exception:  # noqa: BLE001 - ComfyUI down; nothing to free
            return
        if queue.get("queue_running") or queue.get("queue_pending"):
            self.last_activity, self.freed = time.monotonic(), False
        elif not self.freed and time.monotonic() - self.last_activity > limit:
            self.free()


def _download(url: str) -> bytes:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise GatewayError(400, "image URLs must be https")
    try:
        infos = socket.getaddrinfo(parsed.hostname, parsed.port or 443, proto=socket.IPPROTO_TCP)
    except OSError:
        raise GatewayError(400, f"cannot resolve {parsed.hostname}") from None
    if not infos:
        raise GatewayError(400, "image URL has no address")
    for info in infos:
        if not ipaddress.ip_address(info[4][0]).is_global:
            raise GatewayError(400, "image URL points to a non-public address")
    try:
        # Pin the TCP destination to the address we checked. Preserve the original
        # Host and TLS server name; disable environment proxies and redirects.
        target = httpx.URL(url)
        pinned = target.copy_with(host=infos[0][4][0])
        with httpx.Client(timeout=30, follow_redirects=False, trust_env=False) as client:
            request = client.build_request("GET", pinned, headers={"Host": target.netloc.decode("ascii")})
            request.extensions["sni_hostname"] = target.host
            response = client.send(request, stream=True)
            try:
                return _download_body(response)
            finally:
                response.close()
    except httpx.HTTPError as e:
        raise GatewayError(400, f"could not fetch the image URL ({type(e).__name__})") from None


def _download_body(response: httpx.Response) -> bytes:
    if response.status_code != 200:
        raise GatewayError(400, f"image URL returned {response.status_code}")
    data = bytearray()
    for chunk in response.iter_bytes():
        data += chunk
        if len(data) > MAX_INPUT_BYTES:
            raise GatewayError(413, "image is larger than 30 MB")
    return bytes(data)
