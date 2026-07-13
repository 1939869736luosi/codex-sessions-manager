import { describe, expect, it } from "vitest";

import {
  formatRootDeletePreview,
  formatRootResidueAudit,
  formatVerifyResult,
} from "../src/cli/format.js";
import type {
  DeleteValidationItem,
  RootDeletePreview,
  RootDeletePreviewCounts,
  RootResidueAudit,
  RootResidueCandidateSource,
  SqliteDeletionCounts,
} from "../src/core/types.js";

const ID = "019daaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";

function zeroSqlite(): SqliteDeletionCounts {
  return {
    threadRows: 0,
    logRows: 0,
    spawnEdgeRows: 0,
    assignedAgentJobs: 0,
    dynamicToolRows: 0,
    stage1Rows: 0,
    threadGoalRows: 0,
  };
}

function zeroCounts(): RootDeletePreviewCounts {
  return {
    rolloutFiles: 0,
    shellSnapshots: 0,
    sessionIndexRows: 0,
    historyRows: 0,
    sqliteRows: 0,
    dedicatedLogRows: 0,
    knownGlobalStateRefs: 0,
    exactKeyGlobalStateRefs: 0,
    possibleUnknownGlobalStateRefs: 0,
    threadSpawnEdges: 0,
  };
}

const ALL_SOURCES: RootResidueCandidateSource[] = [
  "rollout_files",
  "shell_snapshots",
  "session_index",
  "history",
  "sqlite",
  "global_state_known",
  "global_state_exact_key",
  "global_state_unknown",
  "thread_spawn_edges",
];

describe("formatter branch coverage for release-gate output", () => {
  it("evaluates every retained-surface validation condition independently", () => {
    const clean: DeleteValidationItem = {
      sessionId: ID,
      title: "clean",
      filePathsRemaining: [],
      shellSnapshotFilesRemaining: [],
      globalStateRefsRemaining: 0,
      exactKeyGlobalStateRefsRemaining: 0,
      exactKeyGlobalStateRefPaths: [],
      possibleUnknownGlobalStateRefsRemaining: 0,
      possibleUnknownGlobalStateRefPaths: [],
      globalStateWarning: null,
      warnings: [],
      sessionIndexRowsRemaining: 0,
      historyRowsRemaining: 0,
      sqlite: zeroSqlite(),
    };
    const cases: DeleteValidationItem[] = [
      { ...clean, title: "file", filePathsRemaining: ["sessions/x.jsonl"] },
      { ...clean, title: "snapshot", shellSnapshotFilesRemaining: ["shell_snapshots/x.sh"] },
      { ...clean, title: "global-warning", globalStateWarning: "not readable" },
      { ...clean, title: "global", globalStateRefsRemaining: 1 },
      { ...clean, title: "exact", exactKeyGlobalStateRefsRemaining: 1 },
      { ...clean, title: "unknown", possibleUnknownGlobalStateRefsRemaining: 1 },
      { ...clean, title: "index", sessionIndexRowsRemaining: 1 },
      { ...clean, title: "history", historyRowsRemaining: 1 },
      {
        ...clean,
        title: "sqlite",
        sqlite: { ...zeroSqlite(), threadRows: 1, logRows: 2 },
        warnings: ["retained logs"],
      },
      clean,
    ];

    const text = formatVerifyResult(cases);

    expect(text.match(/仍有残留/gu)).toHaveLength(9);
    expect(text).toContain("clean: 无残留");
    expect(text).toContain("global_state_refs=unknown");
    expect(text).toContain("retained_sqlite=logs=2");
    expect(text).toContain("warnings=retained logs");
  });

  it("formats empty root audits without inventing filters, counts, or candidates", () => {
    const audit: RootResidueAudit = {
      rootPath: "/safe/root",
      safetyNotice: "read only",
      filters: { statuses: [], sources: [], includeAll: false },
      totalCandidatesBeforeFilter: 0,
      totalCandidatesAfterFilter: 0,
      totalCandidates: 0,
      returnedCandidates: 0,
      limit: 50,
      byStatus: {},
      bySource: {},
      candidates: [],
      warningSummary: { total: 1, returned: 1, omitted: 0 },
      warnings: ["surface unavailable"],
    };

    const text = formatRootResidueAudit(audit);

    expect(text).toContain("筛选: 无");
    expect(text).toContain("按状态（筛选后，limit 前）:\n- 无");
    expect(text).toContain("没有发现疑似残留");
    expect(text).toContain("surface unavailable");
  });

  it("labels every root audit source and renders active filters and family state", () => {
    const counts = { ...zeroCounts(), rolloutFiles: 1, sqliteRows: 2, threadSpawnEdges: 3 };
    const audit: RootResidueAudit = {
      rootPath: "/safe/root",
      safetyNotice: "read only",
      filters: { statuses: ["partial-residue"], sources: ["sqlite"], includeAll: true },
      totalCandidatesBeforeFilter: 1,
      totalCandidatesAfterFilter: 1,
      totalCandidates: 1,
      returnedCandidates: 1,
      limit: 10,
      byStatus: { "partial-residue": 1 },
      bySource: Object.fromEntries(ALL_SOURCES.map((source) => [source, 1])),
      candidates: [{
        sessionId: ID,
        statuses: ["partial-residue"],
        sources: ALL_SOURCES,
        surfaces: counts,
        family: {
          isFamilyMember: true,
          brokenFamily: true,
          rootId: ID,
          parentIds: ["parent"],
          childIds: ["child"],
          familyMemberCount: 3,
          brokenRelationCount: 1,
        },
        warningSummary: { total: 0, returned: 0, omitted: 0 },
        warnings: [],
        recommendedAuditCommand: `codex-sessions audit ${ID}`,
      }],
      warningSummary: { total: 0, returned: 0, omitted: 0 },
      warnings: [],
    };

    const text = formatRootResidueAudit(audit);

    expect(text).toContain("status=partial-residue, source=SQLite, all=true");
    expect(text).toContain("rollout 文件,shell snapshot,session_index,history,SQLite");
    expect(text).toContain("exact-key global-state");
    expect(text).toContain("thread_spawn_edges（parent/child 关系边）");
    expect(text).toContain("family=是, broken=是, members=3");
  });

  it("formats empty and populated root delete previews, including family warnings", () => {
    const base: RootDeletePreview = {
      rootPath: "/safe/root",
      safetyNotice: "preview only",
      filters: { statuses: [], sources: [], includeAll: false },
      totalCandidatesBeforeFilter: 0,
      totalCandidatesAfterFilter: 0,
      previewedCandidates: 0,
      omittedCandidates: 0,
      limit: 50,
      aggregatePreview: zeroCounts(),
      familyWarningSummary: {
        candidatesWithFamilyWarnings: 0,
        unselectedParentIds: [],
        unselectedChildIds: [],
        unselectedFamilyMemberIds: [],
        missingParentIds: [],
        missingChildIds: [],
        brokenRelationCount: 0,
        warningCount: 0,
        warnings: [],
      },
      candidates: [],
      warningSummary: { total: 0, returned: 0, omitted: 0 },
      warnings: [],
    };
    const emptyText = formatRootDeletePreview(base);
    expect(emptyText).toContain("筛选条件: 无");
    expect(emptyText).toContain("没有匹配候选");

    const populated: RootDeletePreview = {
      ...base,
      filters: { statuses: ["sqlite-residue"], sources: ["sqlite"], includeAll: true },
      totalCandidatesBeforeFilter: 1,
      totalCandidatesAfterFilter: 1,
      previewedCandidates: 1,
      aggregatePreview: { ...zeroCounts(), sqliteRows: 1 },
      familyWarningSummary: {
        ...base.familyWarningSummary,
        candidatesWithFamilyWarnings: 1,
        unselectedParentIds: ["parent"],
        brokenRelationCount: 1,
        warningCount: 1,
        warnings: ["review family"],
      },
      candidates: [{
        sessionId: ID,
        statuses: ["sqlite-residue"],
        sources: [],
        previewCounts: { ...zeroCounts(), sqliteRows: 1 },
        familyWarnings: [{
          sessionId: ID,
          unselectedParentIds: ["parent"],
          unselectedChildIds: [],
          unselectedFamilyMemberIds: [],
          unselectedRelatedSessionIds: ["parent"],
          missingParentIds: [],
          missingChildIds: [],
          brokenRelations: [],
          warnings: ["review family"],
        }],
        recommendedAuditCommand: `codex-sessions audit ${ID}`,
        previewOnlyCommand: "preview",
        recommendedPreviewCommand: "preview",
      }],
      warnings: ["manual confirmation required"],
    };
    const text = formatRootDeletePreview(populated);

    expect(text).toContain("status=sqlite-residue, source=SQLite, all=true");
    expect(text).toContain("warnings=1, unselected=1, missing_parent=0, missing_child=0");
    expect(text).toContain("manual confirmation required");
  });
});
