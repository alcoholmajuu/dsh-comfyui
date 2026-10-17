import json
import io
import tempfile
from pathlib import Path
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
import httpx
from PIL import Image
import unittest
from types import SimpleNamespace
from fastapi.testclient import TestClient
from app.main import create_app
from app.config import Settings
from app.comfy import GatewayError, Comfy, _download
from app.workflows import Workflows
from app.mcp import call_tool, TOOLS


class JobBackend:
    def __init__(self, phase):
        self.phase = phase
        self.submits = 0
        self.workflows = SimpleNamespace(check_graph=lambda graph: graph)

    def generate(self, args):
        if self.phase == "before":
            raise GatewayError(400, "prompt is required")
        self.submits += 1
        return {"job_id": "receipt-123", "status": "queued"}

    edit = generate
    inpaint = generate

    def run_workflow(self, graph, inputs):
        return self.generate({})

    def wait(self, job_id, wait):
        if self.phase == "status":
            raise GatewayError(404, "no such job")
        return {"job_id": job_id, "status": "done", "images": 1, "_files": [{}]}

    def job(self, job_id):
        return self.wait(job_id, 0)

    def preview(self, job_id, index):
        if self.phase == "preview":
            raise GatewayError(503, "preview unavailable")
        return b"preview-bytes", False


class GatewayTests(unittest.TestCase):
    def test_default_auth_denies_mcp_and_rest(self):
        app = create_app(Settings({}))
        with TestClient(app) as client:
            self.assertEqual(client.get("/healthz").status_code, 200)
            self.assertEqual(client.post("/mcp", json={"id": 1, "method": "tools/list"}).status_code, 503)
            self.assertEqual(client.get("/api/status").status_code, 503)

    def test_local_dev_mode_lists_protocol_without_gpu(self):
        app = create_app(Settings({"GW_DEV_NO_AUTH": "1"}))
        with TestClient(app) as client:
            response = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}).json()
            self.assertEqual(response["result"]["serverInfo"]["version"], "0.6.0")
            response = client.post("/mcp", json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}).json()
            self.assertEqual(len(response["result"]["tools"]), len(TOOLS))

    def test_submit_receipt_survives_status_failure_for_every_generation_path(self):
        for tool in ["generate_image", "edit_image", "inpaint_image", "run_workflow"]:
            with self.subTest(tool=tool):
                backend = JobBackend("status")
                content = call_tool(backend, tool, {"workflow": {"1": {"class_type": "X", "inputs": {}}}})
                data = json.loads(content[0]["text"])
                self.assertEqual(data["job_id"], "receipt-123")
                self.assertEqual(data["status"], "unknown")
                self.assertEqual(backend.submits, 1)
                self.assertIn("do not resubmit", data["next"])

    def test_preview_failure_keeps_completed_job(self):
        backend = JobBackend("preview")
        data = json.loads(call_tool(backend, "generate_image", {"prompt": "test"})[0]["text"])
        self.assertEqual(data["status"], "done")
        self.assertEqual(data["job_id"], "receipt-123")
        self.assertEqual(data["preview_error"], "preview unavailable")

    def test_pre_submit_failure_stays_an_error(self):
        backend = JobBackend("before")
        with self.assertRaises(GatewayError):
            call_tool(backend, "generate_image", {"prompt": ""})
        self.assertEqual(backend.submits, 0)

    def test_known_completed_job_still_returns_preview(self):
        backend = JobBackend("ok")
        content = call_tool(backend, "generate_image", {"prompt": "test"})
        self.assertEqual(json.loads(content[0]["text"])["status"], "done")
        self.assertEqual(content[1]["type"], "image")

    def test_get_job_preview_failure_keeps_receipt_and_done(self):
        content = call_tool(JobBackend("preview"), "get_job", {"job_id": "receipt-123", "show_image": True})
        data = json.loads(content[0]["text"])
        self.assertEqual((data["job_id"], data["status"]), ("receipt-123", "done"))
        self.assertEqual(data["preview_error"], "preview unavailable")

    def test_inpaint_references_do_not_overwrite_decode_or_create_cycle(self):
        image = io.BytesIO()
        Image.new("RGBA", (64, 64)).save(image, "PNG")
        backend = object.__new__(Comfy)
        backend.resolve_image = lambda name: name
        backend.input_image = lambda name: image.getvalue()
        backend._mask = lambda args, size: (b"mask", 50)
        backend.upload = lambda data, name: name
        backend._loaders = lambda: {"1": {}, "2": {}, "3": {}, "5": {}}
        backend._submit = lambda graph, *args: graph
        graph = backend.inpaint({"prompt": "edit", "image": "source.png", "references": ["a.png", "b.png"]})
        self.assertEqual(graph["30"]["class_type"], "LanPaint_ImageDecode")
        for index, name in [(2, "a.png"), (3, "b.png")]:
            ref_id = graph["4"]["inputs"][f"images.image_{index}"][0]
            self.assertEqual(graph[ref_id], {"class_type": "LoadImage", "inputs": {"image": name}})
        def visit(node, ancestors):
            self.assertNotIn(node, ancestors)
            for value in graph[node].get("inputs", {}).values():
                if isinstance(value, list) and len(value) == 2 and str(value[0]) in graph:
                    visit(str(value[0]), ancestors | {node})
        for node in graph:
            visit(node, set())

    def test_concurrent_new_saves_refuse_clobber_and_explicit_overwrite_works(self):
        with tempfile.TemporaryDirectory() as directory:
            def fail_canvas(*args, **kwargs):
                raise GatewayError(503, "canvas offline")
            library = Workflows(fail_canvas, Path(directory))
            def save(value):
                try:
                    return library.save("shared", {"value": value})
                except GatewayError as error:
                    return error.status
            with ThreadPoolExecutor(2) as pool:
                results = list(pool.map(save, [1, 2]))
            self.assertEqual(sum(isinstance(value, dict) for value in results), 1)
            self.assertIn(409, results)
            self.assertIn(library.get("shared")["workflow"]["value"], [1, 2])
            library.save("shared", {"value": 3}, overwrite=True)
            self.assertEqual(library.get("shared")["workflow"]["value"], 3)
            self.assertEqual(list(Path(directory).glob(".workflow-*")), [])

    def test_download_pins_checked_ip_and_preserves_tls_name_without_proxy(self):
        requests = []
        real_client = httpx.Client
        def handle(request):
            requests.append(request)
            return httpx.Response(200, content=b"image")
        def client(**kwargs):
            self.assertFalse(kwargs["trust_env"])
            self.assertFalse(kwargs["follow_redirects"])
            return real_client(transport=httpx.MockTransport(handle), **kwargs)
        addresses = [(2, 1, 6, "", ("93.184.216.34", 443))]
        with patch("app.comfy.socket.getaddrinfo", return_value=addresses) as dns, patch("app.comfy.httpx.Client", side_effect=client):
            self.assertEqual(_download("https://images.example.com/pic.png"), b"image")
        self.assertEqual(dns.call_count, 1)
        self.assertEqual(requests[0].url.host, "93.184.216.34")
        self.assertEqual(requests[0].headers["host"], "images.example.com")
        self.assertEqual(requests[0].extensions["sni_hostname"], "images.example.com")
        with patch("app.comfy.socket.getaddrinfo", return_value=[(2, 1, 6, "", ("127.0.0.1", 443))]):
            with self.assertRaises(GatewayError):
                _download("https://images.example.com/pic.png")


if __name__ == "__main__":
    unittest.main()
