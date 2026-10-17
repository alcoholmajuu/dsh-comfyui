# Prior art and changes introduced in v0.3

Reviewed on 2026-10-18. The review covered the source files below, in addition to public GitHub READMEs.
No other plugin was installed or executed, and no code was copied from these plugins.
Design ideas were independently implemented for this plugin's MCP/OAuth architecture.

| Reference | Source reviewed | Decision and implementation |
| --- | --- | --- |
| [fandc520/dsh-comfyui](https://github.com/fandc520/dsh-comfyui) (MIT) | `src/params.ts`, `src/queue.ts`, `src/client/panel.tsx`; commit `3440ad6787f5de4b76925a7f3766388d96786380` | Frequently used parameter extraction, manual selection, and history reuse informed quick adjustments, pinned inputs, and restoration of execution-time graphs. Workflow filtering was also added. |
| [zeroa234/dsh-comfyui](https://github.com/zeroa234/dsh-comfyui) (BSD-3-Clause) | `lib/lib/scan.js`, `lib/lib/engine.js`; commit `05c5690ce77aecc026210715739e1fca23d3a13d` | Node-ID/input-name targeting and pre-execution checks informed the design. Existing MCP validation of nodes, links, and choices was retained; INT/FLOAT/BOOLEAN/STRING and numeric-range checks were added to the panel API. |
| [nana7mi0721/dsh-comfyui-agent](https://github.com/nana7mi0721/dsh-comfyui-agent) (MIT) | `README.md`, `lib/graph.js`, `lib/tools.js`; commit `2f12ad14b35a74bc4508354c5e6dad520a216c9d` | Subgraph expansion and special widget conversion are useful references but require complete node definitions and raw canvas structures. A second client-side converter was deferred to preserve the existing MCP responsibility boundary. Preserving explicit values such as seed=0 was also reviewed. |

`wbin0001/dsh-comfyui-canvas` appeared in a plugin index, but both GitHub and Git retrieval returned Repository not found during this review, so it was excluded from source comparison.

## Behavior and limitations

- Quick adjustments directly edit the current graph and use normal undo/redo, validation, and draft protection. They extract prompt/text, seed, steps, cfg, denoise, width/height, and similar inputs. Node IDs and titles are shown instead of inferring positive/negative semantics from node order. Arbitrary string, numeric, and boolean inputs can be pinned; links cannot.
- Pins are stored in the session's browser draft. They are excluded from workflow saves to the MCP server and standalone API-graph JSON exports, and reset when another workflow is loaded.
- Only explicit graphs observed by the plugin in `run_workflow` calls from v0.3 onward are captured at execution time. Polling and library changes do not overwrite them. Restoration preserves execution-time inputs, including seeds, input overrides, and resolved random seed values returned by the server. Jobs without an available graph, including older jobs or some `generate_image` jobs, have no restore button.
- Restoration loads a draft only. GPU execution requires the Run button. An existing edited draft blocks restoration until it is saved, exported, or discarded.
- Validation reloads node definitions from the connected instance, checks numeric types and ranges, and does not round or correct values automatically. Truncated choice lists are not used to declare a model missing; complete choice validation is delegated to the existing MCP. Seed/noise_seed values of `-1` are accepted as random-seed requests according to the connected service's convention.
- This was a pre-release comparison and improvement pass, not an exhaustive guarantee of compatibility or originality.
