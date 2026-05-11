/**
 * 025_RenameDeepSeekNonThinkToLight
 *
 * Slice 33-fix.6: rename DeepSeek effort "non-think" → "light".
 *
 * The contracts schema for `DEEPSEEK_REASONING_EFFORT_OPTIONS` was
 * renamed from `["non-think", "high", "max"]` to `["light", "high", "max"]`
 * because V4-Pro is reasoning-first — there's no real off-switch, only
 * a depth knob, and the old "non-think" label was misleading.
 *
 * Persisted rows from before the rename still carry `"non-think"` in
 * `model_selection_json.options.effort`. The decoder rejects them on
 * startup and the backend crash-loops. This migration rewrites the
 * stored value in-place across every table that may carry it.
 *
 * Tables touched:
 *   - projection_threads.model_selection_json     (the immediate trigger)
 *   - projection_projects.default_model_selection_json (defaults set by user)
 *   - orchestration_events.payload_json           (event log — defensive)
 *
 * Idempotent: only updates rows where the literal "non-think" is
 * currently present, so re-running is a no-op.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // 1. projection_threads — root cause of the crash loop.
  yield* sql`
    UPDATE projection_threads
    SET model_selection_json = json_set(
      model_selection_json,
      '$.options.effort',
      'light'
    )
    WHERE model_selection_json IS NOT NULL
      AND json_extract(model_selection_json, '$.options.effort') = 'non-think'
  `;

  // 2. projection_projects — defaults the user may have set.
  yield* sql`
    UPDATE projection_projects
    SET default_model_selection_json = json_set(
      default_model_selection_json,
      '$.options.effort',
      'light'
    )
    WHERE default_model_selection_json IS NOT NULL
      AND json_extract(default_model_selection_json, '$.options.effort') = 'non-think'
  `;

  // 3. orchestration_events — defensive sweep across the two known
  // shapes that carry a model selection in the event log.
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      payload_json,
      '$.modelSelection.options.effort',
      'light'
    )
    WHERE json_extract(payload_json, '$.modelSelection.options.effort') = 'non-think'
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      payload_json,
      '$.defaultModelSelection.options.effort',
      'light'
    )
    WHERE json_extract(payload_json, '$.defaultModelSelection.options.effort') = 'non-think'
  `;
});
