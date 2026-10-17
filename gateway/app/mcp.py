"""Remote MCP server (Streamable HTTP, stateless) at POST /mcp.

Every request gets one JSON response; there is no SSE stream or session, so
nothing long-lived has to survive the Cloudflare proxy. Generation outlasts a
request, so tools return a job id and `get_job` collects the result.
"""

from __future__ import annotations

import base64
import json
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response

from app.auth import require_caller
from app.comfy import ASPECT_RATIOS, MAX_REFERENCE_IMAGES, Comfy, GatewayError

PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]
DEFAULT_WAIT = 45
MAX_INLINE_IMAGES = 3

INSTRUCTIONS = (
    "Image generation on the owner's own GPU PC through ComfyUI.\n"
    "Quick path: generate_image and edit_image run the built-in Qwen-Image 2.1 workflows. "
    "They start a job and wait briefly; if the result is not ready they return a job_id with "
    "status 'queued' or 'running' -- then call get_job until status is 'done' (it shows the "
    "image) or 'failed'. Jobs run one at a time. Write prompts in natural language, in English "
    "or Chinese for best results; in edit prompts refer to the reference images as <image1>, "
    "<image2>, ...\n"
    "Workflow path: any ComfyUI workflow can be built, changed, saved and run. Workflows are "
    "API-format JSON: {node_id: {class_type, inputs}}, where an input is a plain value or a "
    "link [source_node_id, output_index]. Typical order: list_workflows / get_workflow to start "
    "from something that works, list_models and node_info to see what this server has, "
    "edit_workflow to change it, validate_workflow, run_workflow, then save_workflow once it "
    "produces a good image. Only models listed by list_models exist on the PC; a workflow for "
    "another model family needs that model installed first (tell the user which files)."
)


def _submitted_content(comfy: Comfy, started: dict[str, Any], wait: float) -> list[dict]:
    """Once queued, never lose the receipt because status/preview failed.

    A history/queue race, restart or network error cannot prove the job was
    not submitted. Keep its ID so clients can reconcile instead of resubmitting.
    """
    try:
        job = started | comfy.wait(started["job_id"], wait)
    except Exception as error:
        detail = error.message if isinstance(error, GatewayError) else type(error).__name__
        return [_text(started | {"status": "unknown", "status_error": detail,
                               "next": "Submission succeeded. Query this job_id; do not resubmit."})]
    return _job_content(comfy, job)

_WAIT = {
    "type": "integer",
    "minimum": 0,
    "maximum": 50,
    "description": f"Seconds to wait for the result before returning (default {DEFAULT_WAIT}).",
}
_WORKFLOW = {
    "type": "object",
    "description": "API-format workflow: {node_id: {class_type, inputs}}. Give this or name.",
}
_COMMON = {
    "negative_prompt": {"type": "string"},
    "steps": {"type": "integer", "minimum": 1, "maximum": 50, "description": "Default 25."},
    "seed": {"type": "integer", "description": "Fixed seed for a repeatable result."},
    "wait_seconds": _WAIT,
}


def _tool(name: str, description: str, properties: dict, required: list[str]) -> dict[str, Any]:
    return {
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": False,
        },
    }


TOOLS: list[dict[str, Any]] = [
    _tool(
        "generate_image",
        "Text-to-image with Qwen-Image 2.1. Returns a job; call get_job if it is not done yet.",
        {
            "prompt": {"type": "string"},
            "aspect_ratio": {"type": "string", "enum": list(ASPECT_RATIOS), "default": "1:1"},
            "width": {"type": "integer", "description": "Overrides aspect_ratio (256-2048)."},
            "height": {"type": "integer", "description": "Overrides aspect_ratio (256-2048)."},
            **_COMMON,
        },
        ["prompt"],
    ),
    _tool(
        "edit_image",
        "Edit or recompose reference images with Qwen-Image 2.1 following the prompt. "
        "Returns a job; call get_job if it is not done yet.",
        {
            "prompt": {"type": "string", "description": "What to change and what to keep."},
            "images": {
                "type": "array",
                "minItems": 1,
                "maxItems": MAX_REFERENCE_IMAGES,
                "items": {"type": "string"},
                "description": "Each entry is an https image URL, 'job:<job_id>' for the output "
                "of an earlier job, or the name of an uploaded input image.",
            },
            "resolution": {
                "type": "integer",
                "description": "References are resized to about this many pixels squared, "
                "keeping aspect ratio (default 1024). 0 keeps the original size (slow if large).",
            },
            **_COMMON,
        },
        ["prompt", "images"],
    ),
    _tool(
        "inpaint_image",
        "Change only one part of a picture (Qwen-Image 2.1 + LanPaint). The masked part is "
        "regenerated following the prompt; everything outside the mask, transparency included, "
        "is kept exactly. Use this instead of edit_image when the rest of the picture must not "
        "change. The mask must cover the WHOLE old object plus the area the new one needs: "
        "anything of the old object left outside the mask stays in the picture (to turn low "
        "shoes into boots, include the ankles and lower shins, not just the shoes). When "
        "unsure, make the area larger. Slow (about 3 minutes): it returns a job; call get_job "
        "until it is done.",
        {
            "prompt": {
                "type": "string",
                "description": "What the masked part should become. The picture is <image1>; "
                "references are <image2>, <image3>.",
            },
            "image": {
                "type": "string",
                "description": "The picture to change: an https URL, 'job:<job_id>', or the name "
                "of an uploaded input image. PNG with transparency is supported.",
            },
            "mask": {
                "type": "string",
                "description": "Mask image, same forms as image: white = change, black = keep. "
                "It is resized to the picture. Give this or regions.",
            },
            "regions": {
                "type": "array",
                "description": "Instead of a mask image: areas to change, in the picture's pixels "
                "(origin top left).",
                "items": {
                    "type": "object",
                    "properties": {
                        "x": {"type": "number"},
                        "y": {"type": "number"},
                        "width": {"type": "number"},
                        "height": {"type": "number"},
                        "shape": {"type": "string", "enum": ["box", "ellipse"]},
                    },
                    "required": ["x", "y", "width", "height"],
                },
            },
            "grow": {
                "type": "integer",
                "description": "Pixels to widen the area by (default 24 for regions, 0 for a "
                "mask image).",
            },
            "references": {
                "type": "array",
                "maxItems": MAX_REFERENCE_IMAGES - 1,
                "items": {"type": "string"},
                "description": "Optional pictures to borrow material or design from.",
            },
            "negative_prompt": {"type": "string"},
            "steps": {"type": "integer", "description": "Default 20."},
            "thinking_steps": {
                "type": "integer",
                "description": "LanPaint iterations per step, 1-10 (default 5). More = better "
                "fit to the surroundings, slower.",
            },
            "seed": {"type": "integer"},
            "wait_seconds": {"type": "number"},
        },
        ["prompt", "image"],
    ),
    _tool(
        "get_job",
        "Status of a job and, once done, the resulting image.",
        {
            "job_id": {"type": "string"},
            "wait_seconds": _WAIT,
            "show_image": {"type": "boolean", "default": True},
        },
        ["job_id"],
    ),
    _tool(
        "list_workflows",
        "Saved workflows (name, description), plus workflows that exist only in ComfyUI's own "
        "canvas list (get_workflow converts those).",
        {},
        [],
    ),
    _tool(
        "get_workflow",
        "A saved workflow as API-format JSON, with its description.",
        {"name": {"type": "string"}},
        ["name"],
    ),
    _tool(
        "save_workflow",
        "Save a workflow under a name. Existing names require overwrite=true. It is also written to "
        "ComfyUI's workflow list so the owner can open it on the canvas. Validation errors "
        "block the save unless force is true.",
        {
            "name": {"type": "string", "description": "Letters, digits, space, . _ -"},
            "workflow": _WORKFLOW,
            "description": {
                "type": "string",
                "description": "What it does, which model it uses, and which node inputs are "
                "meant to be changed per run (e.g. '4.prompt', '6.seed').",
            },
            "force": {"type": "boolean", "default": False},
            "overwrite": {"type": "boolean", "default": False},
        },
        ["name", "workflow"],
    ),
    _tool(
        "delete_workflow",
        "Remove a workflow from the library.",
        {"name": {"type": "string"}},
        ["name"],
    ),
    _tool(
        "edit_workflow",
        "Apply edit operations to a workflow and return the new JSON with a validation report. "
        "Nothing is saved unless save_as is given. Operations, applied in order: "
        "{op:'set_input', node_id, input_name, value} | "
        "{op:'add_node', class_type, inputs?, node_id?, title?} | "
        "{op:'remove_node', node_id} | "
        "{op:'connect', from_node, from_output? (index or name, default 0), to_node, to_input} | "
        "{op:'insert_between', class_type, input_name, output?, inputs?, to_node, to_input} "
        "(puts a new node on the existing link into to_node.to_input).",
        {
            "name": {"type": "string", "description": "Saved workflow to start from."},
            "workflow": _WORKFLOW,
            "operations": {"type": "array", "items": {"type": "object"}, "minItems": 1},
            "save_as": {"type": "string", "description": "Save the result under this name."},
            "description": {"type": "string", "description": "Description to store with save_as."},
        },
        ["operations"],
    ),
    _tool(
        "validate_workflow",
        "Check a workflow against this server without running it: unknown node types, missing "
        "required inputs, bad links, model files that are not installed.",
        {"name": {"type": "string"}, "workflow": _WORKFLOW},
        [],
    ),
    _tool(
        "run_workflow",
        "Run a saved workflow (name) or a workflow JSON. Returns a job; call get_job if it is "
        "not done yet.",
        {
            "name": {"type": "string"},
            "workflow": _WORKFLOW,
            "inputs": {
                "type": "object",
                "description": "Per-run overrides as {'<node_id>.<input_name>': value}, e.g. "
                "{'4.prompt': 'a red fox', '6.seed': -1}. A seed of -1 is randomized. For a "
                "LoadImage node's image, an https URL or 'job:<job_id>' is fetched first.",
            },
            "wait_seconds": _WAIT,
        },
        [],
    ),
    _tool(
        "list_models",
        "Model files installed on the PC, by folder (diffusion_models, text_encoders, vae, "
        "loras, checkpoints, ...). These are the only values model-loader nodes accept.",
        {"folder": {"type": "string", "description": "Limit to one folder."}},
        [],
    ),
    _tool(
        "node_info",
        "Look up ComfyUI node types on this server. With query: search by name or category. "
        "With node_types: full inputs (type, default, options) and outputs of up to 20 types.",
        {
            "query": {"type": "string", "description": "Words to search, e.g. 'lora loader'."},
            "node_types": {"type": "array", "items": {"type": "string"}, "maxItems": 20},
        },
        [],
    ),
    _tool(
        "import_image",
        "Copy an image into ComfyUI's input folder and return the name to use in a LoadImage "
        "node. The source is an https URL or 'job:<job_id>'.",
        {"image": {"type": "string"}},
        ["image"],
    ),
    _tool("comfy_status", "GPU memory, queue length and loaded model names.", {}, []),
    _tool("free_vram", "Unload the models from GPU memory (they reload on the next job).", {}, []),
]
TOOL_NAMES = {t["name"] for t in TOOLS}
WORKFLOW_TOOLS = {
    "list_workflows",
    "get_workflow",
    "save_workflow",
    "delete_workflow",
    "edit_workflow",
    "validate_workflow",
    "list_models",
    "node_info",
    "import_image",
}


def _text(value: Any) -> dict[str, Any]:
    return {"type": "text", "text": json.dumps(value, ensure_ascii=False)}


def _job_content(comfy: Comfy, job: dict[str, Any], show_image: bool = True) -> list[dict]:
    files = job.get("_files", [])
    job = {key: value for key, value in job.items() if key != "_files"}
    if job["status"] in ("queued", "running"):
        job["next"] = "call get_job with this job_id"
    content = [_text(job)]
    if job["status"] == "done" and show_image:
        for index in range(min(len(files), MAX_INLINE_IMAGES)):
            try:
                data, transparent = comfy.preview(job["job_id"], index)
            except Exception as error:
                detail = error.message if isinstance(error, GatewayError) else type(error).__name__
                content[0] = _text(job | {"preview_error": detail})
                break
            content.append(
                {"type": "image", "data": base64.b64encode(data).decode(), "mimeType": "image/jpeg"}
            )
            if transparent:
                content[0] = _text(
                    job
                    | {
                        "transparency": "kept. The preview shows transparent areas as white; "
                        "the full-size PNG has the real transparent background."
                    }
                )
    return content


def _graph(comfy: Comfy, args: dict[str, Any]) -> dict[str, Any]:
    if args.get("workflow"):
        return comfy.workflows.check_graph(args["workflow"])
    if args.get("name"):
        return comfy.workflows.check_graph(comfy.workflows.get(str(args["name"]))["workflow"])
    raise GatewayError(400, "give either name (a saved workflow) or workflow (JSON)")


def _workflow_tool(comfy: Comfy, name: str, args: dict[str, Any]) -> Any:
    workflows = comfy.workflows
    if name == "list_workflows":
        return workflows.list()
    if name == "get_workflow":
        return workflows.get(str(args["name"]))
    if name == "delete_workflow":
        return workflows.delete(str(args["name"]))
    if name == "list_models":
        return workflows.models(args.get("folder"))
    if name == "node_info":
        if args.get("node_types"):
            return workflows.node_info([str(t) for t in args["node_types"]])
        if args.get("query"):
            return workflows.search_nodes(str(args["query"]))
        raise GatewayError(400, "give query or node_types")
    if name == "import_image":
        return {"name": comfy.resolve_image(str(args["image"]))}
    if name == "validate_workflow":
        return workflows.validate(_graph(comfy, args))
    if name == "save_workflow":
        graph = workflows.check_graph(args["workflow"])
        report = workflows.validate(graph)
        if report["errors"] and not args.get("force"):
            return {"saved": False, **report}
        saved = workflows.save(str(args["name"]), graph, str(args.get("description") or ""), overwrite=args.get("overwrite") is True)
        return saved | report
    if name == "edit_workflow":
        base = _graph(comfy, args)
        result = workflows.edit(base, list(args["operations"]))
        result |= workflows.validate(result["workflow"])
        if args.get("save_as"):
            description = str(args.get("description") or "")
            if not description and args.get("name"):
                description = workflows.get(str(args["name"])).get("description", "")
            result["save"] = workflows.save(str(args["save_as"]), result["workflow"], description)
        return result
    raise GatewayError(400, f"unknown tool: {name}")


def call_tool(comfy: Comfy, name: str, args: dict[str, Any]) -> list[dict[str, Any]]:
    wait = float(args.get("wait_seconds", DEFAULT_WAIT))
    if name in ("generate_image", "edit_image", "inpaint_image"):
        start = {"generate_image": comfy.generate, "edit_image": comfy.edit}.get(name, comfy.inpaint)
        started = start(args)
        return _submitted_content(comfy, started, wait)
    if name == "get_job":
        job = comfy.wait(str(args["job_id"]), wait)
        return _job_content(comfy, job, bool(args.get("show_image", True)))
    if name == "run_workflow":
        started = comfy.run_workflow(_graph(comfy, args), args.get("inputs"))
        return _submitted_content(comfy, started, wait)
    if name in WORKFLOW_TOOLS:
        return [_text(_workflow_tool(comfy, name, args))]
    if name == "comfy_status":
        return [_text(comfy.status())]
    if name == "free_vram":
        return [_text(comfy.free())]
    raise GatewayError(400, f"unknown tool: {name}")


router = APIRouter()


def _handle(comfy: Comfy, body: Any) -> Response:
    if not isinstance(body, dict):
        error = {"code": -32600, "message": "expected a single JSON-RPC object"}
        return JSONResponse(status_code=400, content={"jsonrpc": "2.0", "id": None, "error": error})
    rpc_id = body.get("id")
    method = body.get("method", "")
    params = body.get("params") or {}

    def ok(result: Any) -> Response:
        return JSONResponse({"jsonrpc": "2.0", "id": rpc_id, "result": result})

    def err(code: int, message: str) -> Response:
        error = {"code": code, "message": message}
        return JSONResponse({"jsonrpc": "2.0", "id": rpc_id, "error": error})

    if "id" not in body:  # notification or client response: acknowledge, no body
        return Response(status_code=202)
    if method == "initialize":
        wanted = params.get("protocolVersion")
        return ok(
            {
                "protocolVersion": wanted if wanted in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0],
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "comfy", "version": "0.6.0"},
                "instructions": INSTRUCTIONS,
            }
        )
    if method == "ping":
        return ok({})
    if method == "tools/list":
        return ok({"tools": TOOLS})
    if method == "tools/call":
        name = params.get("name", "")
        if name not in TOOL_NAMES:
            return err(-32602, f"unknown tool: {name}")
        try:
            return ok({"content": call_tool(comfy, name, params.get("arguments") or {})})
        except GatewayError as e:
            message = e.message
        except KeyError as e:
            message = f"missing argument: {e.args[0]}"
        except (TypeError, ValueError) as e:
            message = f"invalid arguments: {e}"
        except Exception as e:  # noqa: BLE001 - surface to the model, keep serving
            message = f"tool failed: {type(e).__name__}: {e}"
        return ok({"content": [{"type": "text", "text": message}], "isError": True})
    return err(-32601, f"method not found: {method}")


@router.post("/mcp")
async def mcp_endpoint(request: Request, caller: str = Depends(require_caller)):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = None
    return await run_in_threadpool(_handle, request.app.state.comfy, body)


@router.api_route("/mcp", methods=["GET", "DELETE"])
def mcp_no_stream():
    # No server-initiated stream and no sessions (allowed by the spec).
    return Response(status_code=405, headers={"Allow": "POST"})
