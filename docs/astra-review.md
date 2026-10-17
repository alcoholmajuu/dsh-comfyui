# Astra review and changes in v0.4

On 2026-10-18, a user-requested `gpt-6-astra` subagent reviewed the source and subsequent fixes.
The parent agent implemented changes; Astra also verified them with an independent script.

| Finding | Change |
| --- | --- |
| Editing during a pending save could allow the response to restore stale content | A fieldset disables workflow editing during operations. View panning and zooming remain available. |
| Clearing submission history could allow the same request ID to run again | New IDs use a timestamp and UUID. Retained IDs are checked first; pruned IDs are rejected using a watermark and expiry. New acceptance of legacy IDs also stops after pruning. |
| Pruning uncertain submissions could erase deduplication evidence | Pending records are never automatically deleted. New submissions stop at 32 pending records. The UI shows counts, operation names, timestamps, and IDs. |
| Images removed from history could remain on disk indefinitely | Preview count and total bytes are bounded. Orphaned images are pruned after an atomic state-file rename succeeds, including on initial load. |
| Automatic polling could fill the history | Unchanged panel `get_job` results are not appended. Automatic `comfy_status` checks are also excluded from operation history. |
| Active or less frequently checked jobs could lose tracking | Active jobs receive retention priority. Polling rotates through four jobs at a time; individual failures do not stop the other checks. |
| Very large graphs could remain clipped after Fit | Fit has a separate minimum scale. Tests cover a graph equivalent to 500 nodes and continuous zooming after Fit. |
| Different inputs could be submitted under the same ID while an operation was pending | Active promises retain an input fingerprint and reject mismatches. A regression test covers this. |
| Browsing many sessions could grow memory indefinitely | An LRU bounds unused sessions to 16 entries. Pins protect state references during active submissions. |

Astra's independent checks passed for rejecting different inputs under the same ID, protecting submission state while browsing 40 sessions, releasing pins after completion, keeping the cache at 16 entries or fewer, and continuous zooming after fitting a large graph.
No major remaining issues were found in duplicate-submission prevention or retained-data cleanup within that review scope.

The parent agent verified the live UI: mouse-wheel zoom from 57% to 78%, panning by dragging empty space, and returning to 57% Fit with the 0 key. Dragging node positions or rewiring connections is outside the supported scope.
