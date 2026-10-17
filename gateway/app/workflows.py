"""Workflow authoring: inspect nodes and models, build, edit, validate, save
and convert ComfyUI workflows.

The library keeps workflows in API format (the form ComfyUI executes and the
form a model edits). Saving also writes a canvas (UI format) copy into
ComfyUI's own workflow list so the same workflow opens in the browser.

The tool surface, the edit operations and the widget rules of the two
converters follow comfyui-mcp (https://github.com/artokun/comfyui-mcp, MIT,
Copyright (c) 2026 Arthur R. Longbottom) -- see NOTICE.
"""

from __future__ import annotations

import copy
import json
import os
import tempfile
import re
import time
from pathlib import Path
from typing import Any, Callable

from app.errors import GatewayError

Graph = dict[str, dict[str, Any]]

SCALAR_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"}
CONTROL_MODES = {"fixed", "increment", "decrement", "randomize"}
SEED_NAMES = {"seed", "noise_seed", "rand_seed"}
VIRTUAL_NODES = {"Note", "MarkdownNote", "Reroute", "PrimitiveNode"}
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$")
OBJECT_INFO_TTL = 60
COMBO_PREVIEW = 40
NON_MODEL_FOLDERS = {"custom_nodes", "configs"}


# --- node definitions ----------------------------------------------------


def _spec(definition: dict, name: str) -> list | None:
    inputs = definition.get("input", {})
    spec = inputs.get("required", {}).get(name)
    if spec is None:
        spec = inputs.get("optional", {}).get(name)
    return spec if isinstance(spec, list) and spec else None


def _config(spec: list) -> dict:
    return spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}


def _ordered_inputs(definition: dict) -> list[str]:
    order = definition.get("input_order")
    source = order if order else definition.get("input", {})
    return [*(source.get("required") or []), *(source.get("optional") or [])]


def _combo_options(spec: list) -> list | None:
    if isinstance(spec[0], list):
        return spec[0]
    options = _config(spec).get("options")
    return options if isinstance(options, list) else None


def _is_widget(spec: list) -> bool:
    """True when the input is a value typed into the node, not a wire."""
    config = _config(spec)
    if config.get("forceInput") or config.get("defaultInput"):
        return False
    if _combo_options(spec) is not None:
        return True
    kind = spec[0]
    if not isinstance(kind, str):
        return False
    return all(part.strip() in SCALAR_TYPES for part in kind.split(","))


def _has_control(name: str, spec: list) -> bool:
    if _config(spec).get("control_after_generate") is True:
        return True
    return spec[0] == "INT" and name in SEED_NAMES


def _is_link(value: Any) -> bool:
    return (
        isinstance(value, list)
        and len(value) == 2
        and isinstance(value[0], (str, int))
        and not isinstance(value[0], bool)
        and isinstance(value[1], int)
        and not isinstance(value[1], bool)
    )


def _type_name(spec: list) -> str:
    return "COMBO" if isinstance(spec[0], list) else str(spec[0])


def _types_match(output: str, wanted: str) -> bool:
    if "*" in (output, wanted):
        return True
    return bool(set(output.split(",")) & set(wanted.split(",")))


class Workflows:
    def __init__(self, call: Callable[..., Any], directory: Path) -> None:
        self._call = call  # Comfy._call
        self.directory = directory
        self._info: dict[str, dict] = {}
        self._info_at = 0.0

    def node_defs(self, refresh: bool = False) -> dict[str, dict]:
        if refresh or not self._info or time.monotonic() - self._info_at > OBJECT_INFO_TTL:
            self._info = self._call("GET", "/object_info", timeout=60).json()
            self._info_at = time.monotonic()
        return self._info

    # --- discovery --------------------------------------------------------

    def models(self, folder: str | None = None) -> dict[str, Any]:
        """Model files the ComfyUI server can load, by folder."""
        if folder:
            return {folder: self._call("GET", f"/models/{folder}").json()}
        found: dict[str, Any] = {}
        for name in self._call("GET", "/models").json():
            if name in NON_MODEL_FOLDERS:
                continue
            files = self._call("GET", f"/models/{name}").json()
            if files:
                found[name] = files
        return found

    def search_nodes(self, query: str, limit: int = 30) -> list[dict[str, str]]:
        words = query.lower().split()
        hits = []
        for name, d in self.node_defs().items():
            haystack = f"{name} {d.get('display_name', '')} {d.get('category', '')}".lower()
            if all(w in haystack for w in words):
                hits.append(
                    {
                        "node_type": name,
                        "display_name": d.get("display_name", ""),
                        "category": d.get("category", ""),
                    }
                )
        hits.sort(key=lambda h: (len(h["node_type"]), h["node_type"]))
        return hits[: max(1, min(100, limit))]

    def node_info(self, node_types: list[str]) -> dict[str, Any]:
        defs = self.node_defs()
        out: dict[str, Any] = {}
        for name in node_types[:20]:
            d = defs.get(name)
            if d is None:
                out[name] = {"error": "no such node type on this server"}
                continue
            inputs = {}
            for input_name in _ordered_inputs(d):
                spec = _spec(d, input_name)
                if spec is None:
                    continue
                config = _config(spec)
                entry: dict[str, Any] = {
                    "type": _type_name(spec),
                    "required": input_name in d["input"].get("required", {}),
                    "kind": "value" if _is_widget(spec) else "link",
                }
                options = _combo_options(spec)
                if options is not None:
                    entry["options"] = options[:COMBO_PREVIEW]
                    if len(options) > COMBO_PREVIEW:
                        entry["options_total"] = len(options)
                for key in ("default", "min", "max", "step", "tooltip"):
                    if key in config:
                        entry[key] = config[key]
                if isinstance(config.get("template"), dict):  # autogrow group
                    names = config["template"].get("names") or []
                    entry["note"] = (
                        f"growing group of link inputs: use '{input_name}.{names[0]}', "
                        f"'{input_name}.{names[1] if len(names) > 1 else names[0]}', ..."
                        if names
                        else "growing group of link inputs"
                    )
                inputs[input_name] = entry
            out[name] = {
                "display_name": d.get("display_name", ""),
                "category": d.get("category", ""),
                "description": (d.get("description") or "")[:400],
                "output_node": bool(d.get("output_node")),
                "inputs": inputs,
                "outputs": [
                    {"index": i, "name": n, "type": t}
                    for i, (n, t) in enumerate(
                        zip(d.get("output_name") or d.get("output", []), d.get("output", []))
                    )
                ],
            }
        return out

    # --- validation -------------------------------------------------------

    def check_graph(self, workflow: Any) -> Graph:
        if isinstance(workflow, str):
            try:
                workflow = json.loads(workflow)
            except ValueError:
                raise GatewayError(400, "workflow is not valid JSON") from None
        if isinstance(workflow, dict) and isinstance(workflow.get("nodes"), list):
            return self.from_ui(workflow)
        if not isinstance(workflow, dict) or not workflow:
            raise GatewayError(400, "workflow must be an object of node_id -> node")
        for node_id, node in workflow.items():
            if not isinstance(node, dict) or not isinstance(node.get("class_type"), str):
                raise GatewayError(400, f"node {node_id!r} needs a class_type")
            node.setdefault("inputs", {})
            if not isinstance(node["inputs"], dict):
                raise GatewayError(400, f"node {node_id!r}: inputs must be an object")
        return workflow

    def validate(self, workflow: Graph) -> dict[str, list[str]]:
        defs = self.node_defs()
        errors: list[str] = []
        warnings: list[str] = []
        has_output = False
        for node_id, node in workflow.items():
            label = f"node {node_id} ({node['class_type']})"
            d = defs.get(node["class_type"])
            if d is None:
                errors.append(f"{label}: this node type is not installed on the server")
                continue
            has_output = has_output or bool(d.get("output_node"))
            for name, spec in d["input"].get("required", {}).items():
                dynamic = isinstance(spec, list) and str(spec[0]).startswith("COMFY_")
                if name not in node["inputs"] and not dynamic:
                    errors.append(f"{label}: required input '{name}' is missing")
            for name, value in node["inputs"].items():
                spec = _spec(d, name)
                if spec is None and "." not in name:
                    warnings.append(f"{label}: unknown input '{name}'")
                if _is_link(value):
                    source = workflow.get(str(value[0]))
                    if source is None:
                        errors.append(f"{label}: '{name}' links to missing node {value[0]}")
                        continue
                    outputs = defs.get(source["class_type"], {}).get("output")
                    if outputs is None:
                        continue
                    if not 0 <= value[1] < len(outputs):
                        errors.append(
                            f"{label}: '{name}' uses output {value[1]} of node {value[0]}, "
                            f"which has {len(outputs)} output(s)"
                        )
                    elif spec and not _types_match(str(outputs[value[1]]), _type_name(spec)):
                        if _type_name(spec) not in SCALAR_TYPES:
                            errors.append(
                                f"{label}: '{name}' expects {_type_name(spec)} but node "
                                f"{value[0]} output {value[1]} is {outputs[value[1]]}"
                            )
                elif spec is not None:
                    options = _combo_options(spec)
                    if options and not isinstance(value, list) and value not in options:
                        shown = ", ".join(map(str, options[:8]))
                        errors.append(
                            f"{label}: '{name}' = {value!r} is not an available option "
                            f"(have: {shown}{', ...' if len(options) > 8 else ''})"
                        )
                    elif not _is_widget(spec) and options is None:
                        errors.append(f"{label}: '{name}' must be a link [node_id, output_index]")
        if not has_output and not errors:
            errors.append("no output node (for example SaveImage), so nothing would run")
        return {"errors": errors, "warnings": warnings}

    # --- editing ----------------------------------------------------------

    def _output_index(self, workflow: Graph, node_id: str, output: Any) -> int:
        if isinstance(output, int) and not isinstance(output, bool):
            return output
        d = self.node_defs().get(workflow[node_id]["class_type"], {})
        names = list(d.get("output_name") or []) + list(d.get("output") or [])
        if output is None:
            return 0
        if str(output) in names:
            return names.index(str(output)) % max(1, len(d.get("output") or [1]))
        raise GatewayError(400, f"node {node_id} has no output {output!r}")

    def edit(self, workflow: Graph, operations: list[dict[str, Any]]) -> dict[str, Any]:
        """set_input, add_node, remove_node, connect, insert_between."""
        graph = copy.deepcopy(workflow)
        added: list[str] = []
        notes: list[str] = []

        def need(node_id: Any) -> str:
            if str(node_id) not in graph:
                raise GatewayError(400, f"no node {node_id!r} in the workflow")
            return str(node_id)

        def new_id(wanted: Any = None) -> str:
            if wanted is not None:
                if str(wanted) in graph:
                    raise GatewayError(400, f"node id {wanted!r} is already used")
                return str(wanted)
            return str(max([int(k) for k in graph if str(k).isdigit()] or [0]) + 1)

        for number, op in enumerate(operations, start=1):
            kind = op.get("op")
            try:
                if kind == "set_input":
                    node_id = need(op["node_id"])
                    graph[node_id]["inputs"][str(op["input_name"])] = op["value"]
                elif kind == "add_node":
                    node_id = new_id(op.get("node_id"))
                    graph[node_id] = {
                        "class_type": str(op["class_type"]),
                        "inputs": dict(op.get("inputs") or {}),
                    }
                    if op.get("title"):
                        graph[node_id]["_meta"] = {"title": str(op["title"])}
                    added.append(node_id)
                elif kind == "remove_node":
                    node_id = need(op["node_id"])
                    del graph[node_id]
                    for other_id, other in graph.items():
                        for name in [
                            n for n, v in other["inputs"].items() if _is_link(v) and str(v[0]) == node_id
                        ]:
                            del other["inputs"][name]
                            notes.append(f"node {other_id}: input '{name}' is now unconnected")
                elif kind == "connect":
                    source, target = need(op["from_node"]), need(op["to_node"])
                    index = self._output_index(graph, source, op.get("from_output"))
                    graph[target]["inputs"][str(op["to_input"])] = [source, index]
                elif kind == "insert_between":
                    target = need(op["to_node"])
                    to_input = str(op["to_input"])
                    current = graph[target]["inputs"].get(to_input)
                    if not _is_link(current):
                        raise GatewayError(400, f"node {target} input '{to_input}' is not linked")
                    node_id = new_id(op.get("node_id"))
                    inputs = dict(op.get("inputs") or {})
                    inputs[str(op["input_name"])] = current
                    graph[node_id] = {"class_type": str(op["class_type"]), "inputs": inputs}
                    index = self._output_index(graph, node_id, op.get("output"))
                    graph[target]["inputs"][to_input] = [node_id, index]
                    added.append(node_id)
                else:
                    raise GatewayError(
                        400,
                        "op must be set_input, add_node, remove_node, connect or insert_between",
                    )
            except KeyError as e:
                raise GatewayError(400, f"operation {number} ({kind}): missing '{e.args[0]}'") from None
            except GatewayError as e:
                raise GatewayError(e.status, f"operation {number} ({kind}): {e.message}") from None
        return {"workflow": graph, "added_node_ids": added, "notes": notes}

    # --- converters -------------------------------------------------------

    def from_ui(self, ui: dict[str, Any]) -> Graph:
        """Canvas (UI) format -> API format. Handles plain graphs with
        reroutes, primitives, muted and bypassed nodes; not subgraphs."""
        defs = self.node_defs()
        nodes = {n["id"]: n for n in ui.get("nodes", [])}
        links: dict[int, tuple[Any, int]] = {}
        for link in ui.get("links", []):
            if isinstance(link, dict):
                links[link["id"]] = (link["origin_id"], link["origin_slot"])
            else:
                links[link[0]] = (link[1], link[2])
        unknown = sorted(
            {n["type"] for n in nodes.values() if n["type"] not in defs and n["type"] not in VIRTUAL_NODES}
        )
        if unknown:
            hint = " (subgraphs are not supported; unpack them in ComfyUI first)" if (
                ui.get("definitions", {}).get("subgraphs")
            ) else ""
            raise GatewayError(400, f"cannot convert: unknown node types {unknown}{hint}")

        def resolve(link_id: Any, depth: int = 0) -> Any:
            """Follow a link back to a real output or a primitive's value."""
            if link_id is None or link_id not in links or depth > 50:
                return None
            origin_id, slot = links[link_id]
            origin = nodes.get(origin_id)
            if origin is None or origin.get("mode") == 2:
                return None
            if origin["type"] == "Reroute":
                return resolve((origin.get("inputs") or [{}])[0].get("link"), depth + 1)
            if origin["type"] == "PrimitiveNode":
                values = origin.get("widgets_values") or [None]
                return {"value": values[0]}
            if origin.get("mode") == 4:  # bypassed: pass the same-typed input through
                wanted = (origin.get("outputs") or [{}] * (slot + 1))[slot].get("type")
                for candidate in origin.get("inputs") or []:
                    if candidate.get("type") == wanted and candidate.get("link") is not None:
                        return resolve(candidate["link"], depth + 1)
                return None
            return [str(origin_id), slot]

        graph: Graph = {}
        for node in nodes.values():
            if node["type"] in VIRTUAL_NODES or node.get("mode") in (2, 4):
                continue
            d = defs[node["type"]]
            inputs: dict[str, Any] = {}
            values = node.get("widgets_values") or []
            if isinstance(values, dict):
                inputs.update({k: v for k, v in values.items() if _spec(d, k)})
            else:
                index = 0
                for name in _ordered_inputs(d):
                    spec = _spec(d, name)
                    if spec is None or not _is_widget(spec) or index >= len(values):
                        continue
                    inputs[name] = values[index]
                    index += 1
                    if _has_control(name, spec) and index < len(values) and values[index] in CONTROL_MODES:
                        index += 1
                    if _config(spec).get("image_upload") and index < len(values) and values[index] == "image":
                        index += 1
            for slot in node.get("inputs") or []:
                source = resolve(slot.get("link"))
                if isinstance(source, dict):
                    inputs[slot["name"]] = source["value"]
                elif source is not None:
                    inputs[slot["name"]] = source
            graph[str(node["id"])] = {"class_type": node["type"], "inputs": inputs}
            if node.get("title"):
                graph[str(node["id"])]["_meta"] = {"title": node["title"]}
        return graph

    def to_ui(self, workflow: Graph) -> dict[str, Any]:
        """API format -> canvas (UI) format with a simple left-to-right layout."""
        defs = self.node_defs()
        ids = {key: (int(key) if str(key).isdigit() else None) for key in workflow}
        taken = max([v for v in ids.values() if v is not None] or [0])
        for key in workflow:
            if ids[key] is None:
                taken += 1
                ids[key] = taken

        depth: dict[str, int] = {}

        def level(key: str, seen: tuple[str, ...] = ()) -> int:
            if key in depth:
                return depth[key]
            sources = [
                str(v[0])
                for v in workflow[key]["inputs"].values()
                if _is_link(v) and str(v[0]) in workflow and str(v[0]) not in seen
            ]
            depth[key] = 1 + max((level(s, seen + (key,)) for s in sources), default=-1)
            return depth[key]

        ui_nodes: dict[str, dict[str, Any]] = {}
        column_y: dict[int, int] = {}
        for order, key in enumerate(sorted(workflow, key=lambda k: (level(k), ids[k]))):
            node = workflow[key]
            d = defs.get(node["class_type"], {"input": {}, "output": []})
            names = _ordered_inputs(d)
            names += [n for n in node["inputs"] if n not in names]
            sockets: list[dict[str, Any]] = []
            widgets: list[Any] = []
            for name in names:
                spec = _spec(d, name)
                value = node["inputs"].get(name)
                if spec is not None and _is_widget(spec):
                    if _is_link(value):
                        sockets.append(
                            {"name": name, "type": _type_name(spec), "link": None, "widget": {"name": name}}
                        )
                        value = None
                    if value is None:
                        options = _combo_options(spec)
                        value = _config(spec).get("default", options[0] if options else None)
                    widgets.append(value)
                    if _has_control(name, spec):
                        widgets.append("fixed")
                    if _config(spec).get("image_upload"):
                        widgets.append("image")
                elif spec is not None and not str(spec[0]).startswith("COMFY_"):
                    sockets.append({"name": name, "type": _type_name(spec), "link": None})
                elif _is_link(value):  # member of a growing input group
                    sockets.append({"name": name, "type": "*", "link": None})
            rows = max(len(sockets), len(d.get("output", []))) + len(widgets)
            long_text = sum(1 for w in widgets if isinstance(w, str) and len(w) > 60)
            height = 60 + rows * 26 + long_text * 90
            x = level(key) * 420
            y = column_y.get(level(key), 0)
            column_y[level(key)] = y + height + 60
            ui_nodes[key] = {
                "id": ids[key],
                "type": node["class_type"],
                "pos": [x, y],
                "size": [340, height],
                "flags": {},
                "order": order,
                "mode": 0,
                "inputs": sockets,
                "outputs": [
                    {"name": n, "type": t, "links": [], "slot_index": i}
                    for i, (n, t) in enumerate(
                        zip(d.get("output_name") or d.get("output", []), d.get("output", []))
                    )
                ],
                "properties": {"Node name for S&R": node["class_type"]},
                "widgets_values": widgets,
            }
            title = (node.get("_meta") or {}).get("title")
            if title:
                ui_nodes[key]["title"] = title

        ui_links: list[list[Any]] = []
        for key, node in workflow.items():
            for slot_index, socket in enumerate(ui_nodes[key]["inputs"]):
                value = node["inputs"].get(socket["name"])
                if not _is_link(value) or str(value[0]) not in ui_nodes:
                    continue
                outputs = ui_nodes[str(value[0])]["outputs"]
                if not 0 <= value[1] < len(outputs):
                    continue
                link_id = len(ui_links) + 1
                kind = outputs[value[1]]["type"]
                socket["link"] = link_id
                if socket["type"] == "*":
                    socket["type"] = kind
                outputs[value[1]]["links"].append(link_id)
                ui_links.append([link_id, ids[str(value[0])], value[1], ids[key], slot_index, kind])
        return {
            "last_node_id": taken,
            "last_link_id": len(ui_links),
            "nodes": list(ui_nodes.values()),
            "links": ui_links,
            "groups": [],
            "config": {},
            "extra": {},
            "version": 0.4,
        }

    # --- library ----------------------------------------------------------

    def _path(self, name: str) -> Path:
        name = name.removesuffix(".json").strip()
        if not NAME_RE.match(name) or ".." in name:
            raise GatewayError(400, "workflow names use letters, digits, space, '.', '_' and '-'")
        return self.directory / f"{name}.json"

    def _canvas_names(self) -> list[str]:
        try:
            listing = self._call("GET", "/userdata", params={"dir": "workflows"}).json()
        except GatewayError:
            return []
        names = [x if isinstance(x, str) else x.get("path", "") for x in listing]
        return sorted(n.removesuffix(".json") for n in names if n.endswith(".json"))

    def list(self) -> dict[str, Any]:
        saved = []
        for path in sorted(self.directory.glob("*.json")):
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except ValueError:
                continue
            saved.append(
                {
                    "name": path.stem,
                    "description": record.get("description", ""),
                    "nodes": len(record.get("workflow", {})),
                    "updated": record.get("updated", ""),
                }
            )
        mine = {s["name"] for s in saved}
        return {
            "workflows": saved,
            "comfyui_canvas_only": [n for n in self._canvas_names() if n not in mine],
        }

    def get(self, name: str) -> dict[str, Any]:
        """A saved workflow; one that exists only in ComfyUI's canvas list is
        converted on the fly."""
        path = self._path(name)
        if path.exists():
            record = json.loads(path.read_text(encoding="utf-8"))
            return {"name": path.stem, "source": "library", **record}
        try:
            ui = self._call("GET", f"/userdata/workflows%2F{path.stem}.json").json()
        except GatewayError:
            raise GatewayError(404, f"no workflow named {path.stem!r}") from None
        graph = ui if "nodes" not in ui else self.from_ui(ui)
        return {
            "name": path.stem,
            "source": "comfyui canvas (converted)",
            "description": "",
            "workflow": graph,
        }

    def save(self, name: str, workflow: Graph, description: str = "", *, overwrite: bool = False) -> dict[str, Any]:
        path = self._path(name)
        self.directory.mkdir(parents=True, exist_ok=True)
        replaced = path.exists()
        record = {
            "description": description.strip(),
            "updated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "workflow": workflow,
        }
        # Write a complete sibling first. link() atomically refuses an existing
        # name, including when two Gateway workers save concurrently.
        fd, temporary = tempfile.mkstemp(prefix=".workflow-", dir=self.directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                output.write(json.dumps(record, ensure_ascii=False, indent=2))
                output.flush()
                os.fsync(output.fileno())
            if overwrite:
                os.replace(temporary, path)
            else:
                try:
                    os.link(temporary, path)
                except FileExistsError:
                    raise GatewayError(409, "workflow already exists; choose another name or explicitly overwrite") from None
        finally:
            Path(temporary).unlink(missing_ok=True)
        result: dict[str, Any] = {"saved": path.stem, "replaced": replaced}
        try:
            self._call(
                "POST",
                f"/userdata/workflows%2F{path.stem}.json",
                params={"overwrite": "true" if overwrite else "false"},
                content=json.dumps(self.to_ui(workflow), ensure_ascii=False).encode(),
                headers={"Content-Type": "application/json"},
            )
            result["canvas_copy"] = True
        except Exception as e:  # noqa: BLE001 - the library copy is what matters
            result["canvas_copy"] = False
            result["canvas_note"] = f"not written to ComfyUI's workflow list: {e}"
        return result

    def delete(self, name: str) -> dict[str, Any]:
        path = self._path(name)
        if not path.exists():
            raise GatewayError(404, f"no workflow named {path.stem!r} in the library")
        path.unlink()
        return {"deleted": path.stem, "note": "the copy in ComfyUI's workflow list is kept"}
