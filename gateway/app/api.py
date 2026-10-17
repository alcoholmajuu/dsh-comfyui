"""REST API for scripts and agents that do not speak MCP. Same auth as /mcp."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, Query, Request
from fastapi.responses import Response

from app.auth import require_caller
from app.comfy import MAX_INPUT_BYTES, Comfy, GatewayError

router = APIRouter(prefix="/api", dependencies=[Depends(require_caller)])


def _comfy(request: Request) -> Comfy:
    return request.app.state.comfy


def _public(job: dict[str, Any]) -> dict[str, Any]:
    job.pop("_files", None)
    if job.get("status") == "done":
        job["image_urls"] = [
            f"/api/jobs/{job['job_id']}/image?index={i}" for i in range(job.get("images", 0))
        ]
    return job


@router.get("/status")
def status(comfy: Comfy = Depends(_comfy)):
    return comfy.status()


@router.post("/free")
def free(comfy: Comfy = Depends(_comfy)):
    return comfy.free()


@router.post("/generate", status_code=202)
def generate(args: dict[str, Any] = Body(...), comfy: Comfy = Depends(_comfy)):
    return comfy.generate(args)


@router.post("/edit", status_code=202)
def edit(args: dict[str, Any] = Body(...), comfy: Comfy = Depends(_comfy)):
    return comfy.edit(args)


@router.post("/inpaint", status_code=202)
def inpaint(args: dict[str, Any] = Body(...), comfy: Comfy = Depends(_comfy)):
    return comfy.inpaint(args)


@router.post("/inputs", status_code=201)
async def upload_input(request: Request, comfy: Comfy = Depends(_comfy)):
    """Raw image bytes in the body; the returned name goes into `images`."""
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > MAX_INPUT_BYTES:
            raise GatewayError(413, "image is larger than 30 MB")
    return {"name": comfy.upload(bytes(data), "upload")}


@router.get("/jobs/{job_id}")
def job(job_id: str, wait: float = Query(0, ge=0, le=50), comfy: Comfy = Depends(_comfy)):
    return _public(comfy.wait(job_id, wait))


@router.get("/jobs/{job_id}/image")
def job_image(
    job_id: str, index: int = 0, preview: bool = False, comfy: Comfy = Depends(_comfy)
):
    if preview:
        return Response(comfy.preview(job_id, index)[0], media_type="image/jpeg")
    data, filename = comfy.output_image(job_id, index)
    headers = {"Content-Disposition": f'inline; filename="{filename}"'}
    return Response(data, media_type="image/png", headers=headers)


# --- workflows -------------------------------------------------------------


@router.get("/models")
def models(folder: str | None = None, comfy: Comfy = Depends(_comfy)):
    return comfy.workflows.models(folder)


@router.get("/nodes")
def nodes(q: str = "", types: str = "", comfy: Comfy = Depends(_comfy)):
    """?q=words searches; ?types=A,B returns full definitions."""
    if types:
        return comfy.workflows.node_info([t for t in types.split(",") if t])
    return comfy.workflows.search_nodes(q)


@router.get("/workflows")
def workflow_list(comfy: Comfy = Depends(_comfy)):
    return comfy.workflows.list()


@router.get("/workflows/{name}")
def workflow_get(name: str, comfy: Comfy = Depends(_comfy)):
    return comfy.workflows.get(name)


@router.put("/workflows/{name}")
def workflow_put(name: str, body: dict[str, Any] = Body(...), comfy: Comfy = Depends(_comfy)):
    """Body: {"workflow": {...}, "description": "...", "force": false}."""
    graph = comfy.workflows.check_graph(body.get("workflow"))
    report = comfy.workflows.validate(graph)
    if report["errors"] and not body.get("force"):
        raise GatewayError(422, "; ".join(report["errors"]))
    return comfy.workflows.save(name, graph, str(body.get("description") or ""), overwrite=body.get("overwrite") is True) | report


@router.delete("/workflows/{name}")
def workflow_delete(name: str, comfy: Comfy = Depends(_comfy)):
    return comfy.workflows.delete(name)


@router.post("/workflows/validate")
def workflow_validate(body: dict[str, Any] = Body(...), comfy: Comfy = Depends(_comfy)):
    return comfy.workflows.validate(comfy.workflows.check_graph(body.get("workflow")))


@router.post("/workflows/edit")
def workflow_edit(body: dict[str, Any] = Body(...), comfy: Comfy = Depends(_comfy)):
    """Body: {"workflow": {...} | "name": "...", "operations": [...]}."""
    source = body.get("workflow") or comfy.workflows.get(str(body.get("name")))["workflow"]
    result = comfy.workflows.edit(comfy.workflows.check_graph(source), list(body["operations"]))
    return result | comfy.workflows.validate(result["workflow"])


@router.post("/run", status_code=202)
def run(body: dict[str, Any] = Body(...), comfy: Comfy = Depends(_comfy)):
    """Body: {"name": "..."} or {"workflow": {...}}, plus optional "inputs"."""
    source = body.get("workflow") or comfy.workflows.get(str(body.get("name")))["workflow"]
    return comfy.run_workflow(comfy.workflows.check_graph(source), body.get("inputs"))
