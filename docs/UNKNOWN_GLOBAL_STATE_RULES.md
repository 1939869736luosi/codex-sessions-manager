# Unknown Global-State Cleanup Rules

This document records the P11 rule boundary and the P12 implementation for `.codex-global-state.json` references.

P12 promotes only two exact-key patterns after preview and explicit confirmation. All other unknown global-state refs remain warnings and are not deletable by the tool.

## Current Behavior

The tool already treats these global-state locations as known:

| Location | Shape | Current write behavior |
|---|---|---|
| `$.pinned-thread-ids[n]` | Array value equals a session id | Deleted and restored by existing known-ref logic |
| `$.queued-follow-ups.<session-id>` | Object key is a session id | Deleted and restored by existing known-ref logic |
| `$.diffViewThreadSettings.<session-id>` | Object key is a session id | Deleted and restored by existing known-ref logic |

All other UUID-shaped keys or values are reported through `possibleUnknownGlobalStateRefs`. Current delete writes do not remove them. Current trash bundles do not store them. Current restore writes do not recreate them.

The current unknown scanner:

- walks the full JSON object after skipping the three known top-level locations above;
- records an object key only when the whole key is a session-shaped UUID;
- records a string value only when the whole value is a session-shaped UUID;
- does not treat a UUID embedded inside longer text as a ref.

## Observed Local Shapes

A read-only check of the current local `/Users/luosi/.codex/.codex-global-state.json` on 2026-05-24 showed these unknown shapes:

| Pattern | Count | Shape | P11 classification |
|---|---:|---|---|
| `$.electron-persisted-atom-state.prompt-history.<session-id>` | 112 | Object key, value is an array | Promote to exact-key candidate for P12 |
| `$.electron-persisted-atom-state.heartbeat-thread-permissions-by-id.<session-id>` | 124 | Object key, value is an object with `approvalPolicy`, `approvalsReviewer`, `sandboxPolicy` | Promote to exact-key candidate for P12 |
| `$.electron-persisted-atom-state.prompt-history.<session-id>[n]` | 6 | Array value is a UUID-shaped string | Keep unknown |
| `$.electron-local-remote-control-installation-id` | 1 | String value is UUID-shaped | Keep unknown |

The root scan also showed `audit-root --status global-state-unknown --source global-state-unknown` returning 57 candidates, and `preview-root --source global-state-unknown` returning 72 matching candidates before the display limit. These are candidates for review, not deletion lists.

## Promoted Exact-Key Candidates

Only these two formerly unknown patterns are promoted by P12:

1. `$.electron-persisted-atom-state.prompt-history.<session-id>`
2. `$.electron-persisted-atom-state.heartbeat-thread-permissions-by-id.<session-id>`

They are exact-key candidates because the session id is the property key, not free text. P12 must delete only the exact property for the selected session id. It must not scan inside the value and must not delete sibling entries.

The `prompt-history` value may contain user-entered text. Human output must not print its contents. Preview output may show only the path, value type, item count, and byte estimate.

The `heartbeat-thread-permissions-by-id` value may be treated as structurally known only when it is an object and its keys are limited to the expected permission fields. If the value has an unexpected shape, keep it unknown.

## Must Remain Unknown

These shapes must not be deleted by P12:

- UUID-shaped string values, including `$.electron-local-remote-control-installation-id`.
- UUID-shaped array values inside `prompt-history`.
- Any UUID embedded in longer text.
- Any path outside the two exact-key candidates above.
- Any object key under the exact-key candidates when the value shape is unexpected.
- Any partial match, prefix match, suffix match, or case where the session id is not the entire key.
- Any global-state file that cannot be parsed as JSON.
- Any case where path resolution, root selection, or snapshot creation is uncertain.

The reason is simple: these values may be installation ids, prompt content, app settings, or future Codex state unrelated to a deleted session.

## Required Preview Before Writes

Before any P12 write can remove an exact-key candidate, the preview must show:

- the target session id;
- the root path and global-state file path;
- each exact JSON path to remove;
- the rule id, for example `electronPromptHistoryByThreadId` or `heartbeatThreadPermissionsById`;
- the value shape, such as `array(20)` or `object(3)`;
- an approximate byte count for the value;
- whether the same session still has rollout files, shell snapshots, `session_index`, `history`, SQLite rows, known global-state refs, unknown refs, or `thread_spawn_edges`;
- family warnings and broken parent/child warnings;
- whether the command is only a preview or a confirmed write.

Preview must not print prompt text, full object values, or the full global-state file.

`audit-root` and `preview-root` must remain read-only. Their results are not deletion recommendations. They must not become a shortcut for deleting unknown global-state refs.

## Write Refusal Rules

P12 must refuse to write when any of these are true:

- the command is not explicitly confirmed (`--yes` for CLI, `confirm=true` for MCP);
- the write target is not one of the two exact-key candidate paths;
- the path matches only by prefix or substring;
- the target session id is not the entire final object key;
- the global-state file is missing when the confirmed delete command scanned it;
- the global-state file changes between the confirmed delete command's scan and write;
- the global-state file is unreadable or unparsable;
- snapshot creation fails;
- the session still has live rollout files unless the same confirmed delete operation is removing that session;
- `restore` would overwrite an existing exact-key entry;
- a trash bundle does not contain enough data to restore any exact-key entry that was removed during a trash delete;
- the operation comes from `audit-root` or `preview-root`;
- family warnings are unresolved and the write would silently expand to parent, child, side, fork, or subagent sessions.

No command may delete global-state refs by broad search over the entire JSON file.

## Snapshot And Restore Requirements

Any confirmed write that removes an exact-key candidate must snapshot the full global-state file before writing. If any later step fails, rollback must restore the original file bytes.

Trash delete must be recoverable:

- the trash manifest must store removed exact-key refs with path, rule id, session id, and full value;
- restore preflight must refuse if the exact path already exists in live global-state;
- restore must recreate the exact entry only when missing;
- restore failure must roll back the full global-state file;
- purge must only remove the selected trash entry and must not touch live global-state.

Permanent delete also needs a rollback snapshot, but it does not need a long-term restore bundle.

## CLI, MCP, Skill, And README Wording

CLI and MCP should use the same rule:

- without confirmation, show preview only;
- with confirmation, remove only known refs and promoted exact-key refs;
- keep all other unknown refs as warnings;
- never call unknown refs "safe to delete" just because they appear in `audit-root` or `preview-root`.

Human-facing wording should say:

- "unknown global-state refs are warnings";
- "these exact-key refs can be removed only after preview and explicit confirmation";
- "root candidates are not deletion recommendations";
- "a clean result cannot be claimed while unknown refs remain";
- "prompt contents and full global-state values are not printed".

Files that need P12 wording updates:

- `README.md`
- `README.zh-CN.md`
- `docs/SAFETY.md`
- `SKILL.md`
- `examples/codex-sessions-manager.SKILL.md`
- CLI help in `src/cli/run.ts`
- CLI formatters in `src/cli/format.ts`
- MCP tool descriptions in `src/mcp/server.ts`

## P12 Implementation Checklist

P12 is implemented through these focused changes:

1. Global-state rule classification in `src/core/global-state.ts`.
   - Preserve the existing known refs.
   - Add rule metadata for exact-key candidates.
   - Add ignored/noise classification for UUID-shaped string values that are not safe keys.

2. Type extensions in `src/core/types.ts`.
   - Keep existing `possibleUnknown...` fields for compatibility.
   - Add rule id, safety class, value shape, and byte estimate where needed.

3. Scan, audit, doctor, preview, and verify output updates.
   - Show exact-key candidates separately from unknown warnings.
   - Keep `audit-root` and `preview-root` read-only.
   - Keep `risky-global-state` meaningful and documented.

4. Confirmed exact-key deletion.
   - Only exact property deletion.
   - Preview-first behavior unchanged.
   - Snapshot before write.
   - Refuse on changed, unreadable, or unparsable global-state.

5. Trash and restore.
   - Store removed exact-key refs in trash bundles.
   - Restore only if the exact key is absent.
   - Roll back on failure.

6. CLI, MCP, Skill, README, and safety docs.
   - Keep wording consistent across entry points.
   - Do not present root scans as cleanup approval.

7. Focused tests.
   - Known refs remain known.
   - Exact-key candidates are classified correctly.
   - UUID values inside prompt history remain unknown/noise.
   - UUID-shaped installation id remains unknown/noise.
   - Preview includes path, rule id, shape, and counts without values.
   - Delete removes only exact-key candidates after confirmation.
   - Delete refuses if global-state changes between the confirmed command scan and write.
   - Trash restore round-trips exact-key refs.
   - Restore refuses exact-key conflicts.
   - `audit-root` and `preview-root` stay read-only and reject write flags.

## Out Of Scope

P11 and P12 must not handle:

- db-only cleanup policy;
- broken-family cleanup policy;
- duplicate trash cleanup;
- subagent family cleanup;
- broad global-state rewriting;
- automatic parent/child/family recursion;
- force restore;
- automatic purge;
- real `~/.codex` write tests.
