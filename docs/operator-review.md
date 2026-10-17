# ComfyUI Operator: Astra review follow-up in v0.5

On 2026-10-18, the user-requested `gpt-6-astra` review and follow-up review were completed.
The parent agent handled implementation, tests, and live DSH verification.

| Finding | Implementation |
| --- | --- |
| Agent calls bypassed the panel's duplicate-submission protection | `comfyui_operator_action` requires a host-issued, timestamped requestId. Agent and panel share OperatorRuntime and ActionQueue. A guard rejects raw MCP mutation calls. |
| An error after submission without a job_id could cause regeneration | Pending state is persisted before execution. An uncertain result blocks resubmission and new mutations, including through another ID or mutation tool. Obvious input errors are returned before creating pending state. |
| Name collisions and `edit_workflow(save_as)` could overwrite workflows | Validation and collision checks run immediately before saving. `force` and `save_as` are prohibited. Already-requested overwrites use the dedicated action's overwrite flag without another confirmation. |
| Other agents using the same MCP connection could be restricted | Membership is determined by the scoped context tool's definition identity, not merely the presence of an MCP namespace. |
| `get_job` polling could continue indefinitely | Starting checks is bounded to six calls and five minutes per turn. Wait duration respects remaining time; retrieval errors stop polling. Panel polling is separate. |
| The agent could not read browser drafts | Explicit draft sharing through the Studio “Share draft with Operator” button stores a per-session snapshot of the graph, name, description, time, and revision. Later edits do not synchronize automatically. |
| Model selection and requests for missing information were ambiguous | Explicit model/workflow choices take priority. The agent must not silently substitute the built-in Qwen path. Questions are limited to indispensable missing information. |

Three additional findings from the follow-up review were fixed, and Astra confirmed the changes in the diff:

- Name collisions involving trailing whitespace, extensions, duplicate extensions, or letter case: submitted names and comparisons are normalized, with conservative handling of Windows case-insensitivity.
- `import_image` was added to protected mutations because it changes the server's input directory.
- Obvious input errors, including missing required values, types, enums, ranges, array lengths, and empty prompts, are checked before persisting pending state.

## Additional fixes from live verification

The first shared-draft read encountered older jobs without workflowName and older pending records without origin. These introduced undefined values into the response, which DSH's lossless JSON validation rejected. Testing stopped while this was fixed. Regression mocks now enforce the host's JSON strictness.

To stop repeated tool failures, the pre-step hook rejects further automatic steps after two model-initiated tool errors in a turn. Successful reads between errors do not reset this budget; a new user message does.

After the fix, real DSH tool/call and tool/result events confirmed successful context retrieval (seq222/223). Based on actual output, the Operator reported studio-demo-512, 11 nodes, and noise_seed42, completing in eight seconds. The same request/header exposed only 19 tools: 16 MCP tools, two Operator helpers, and one question tool.
This live test covered sharing and reading only; it did not generate images, save or delete server workflows, or free VRAM.

## Remaining boundaries

- Agent instructions interpret the user's overwrite request. The host enforces the explicit overwrite flag, collision checks, and validation.
- Only a user action in Studio can acknowledge pending reconciliation. The record is retained as acknowledged rather than rewritten as an inferred success. Old IDs cannot be rerun, and invalidation evidence remains when retention limits prune records.
- This plugin update did not change ComfyUI's underlying possibility of an error after submission without a job_id. It handles that uncertainty by stopping resubmission.
- This review did not cover every combination of real GPU generation, long-running jobs, expired authentication, and cancellation in live testing. Regression tests cover write protection and failure branches. These are the limits of the v0.5 review, not a claim that later releases received no GPU smoke tests.
