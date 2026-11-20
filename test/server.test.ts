import { experimental_PluginRpcCallError } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeQueueEntry,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, { ASK_TOOL, LEGACY_TOOLS, REPORT_TOOL, SETUP_SKILL, SKILL, SUBMIT_PLAN_TOOL, WITHDRAW_PLAN_TOOL } from "../server";
import { REVIEW_MAX_WAIT_MS, REVIEW_SETTLE_MS } from "../src/board";
import type { Board, Decision, PlanMark, PlanRound, Ticket, TicketDetail } from "../src/contract";

const ORCH = "thr_orch";

interface World {
  children: Record<string, ReturnType<typeof makeThreadResponse>[]>;
  bindings: Record<string, unknown>;
  failSend: boolean;
  replies: Record<string, { createdAt: number; data: Record<string, unknown> }[]>;
  /** Overrides for the first review round (ref-1, opened from the ABC-101 lead). */
  round: Record<string, unknown>;
  /** More Code Review Workspace reviews, after the fixture's. */
  reviews: unknown[];
  /** Code Review Workspace's answer to reviews.v1.status in place of the fixture's; it throws when this throws. */
  status: (() => unknown) | null;
  /** How many times reviews.v1.status was called. */
  statusReads: number;
  /** Files on the agents' machine, by absolute path. */
  files: Record<string, string>;
  /** Linear states for keys looked up by identifier. */
  issueStates: Record<string, { stateName: string; tone: string }>;
  /** Worktree state by environment id; clean and pushed when absent. */
  workspaces: Record<string, { dirty?: boolean; ahead?: number; noUpstream?: boolean; inMain?: boolean; offline?: boolean }>;
  /** Threads whose worktree bb removed after archiving. */
  removed: string[];
  /** Code Review Workspace's reviewThreadChanges, by the thread it runs for; throws when it throws. */
  startReview: (threadId: string) => unknown;
  /** Threads reviewThreadChanges was called for. */
  started: string[];
}

function thread(id: string, parentThreadId: string, title: string, extra = {}) {
  return makeThreadResponse({
    id,
    parentThreadId,
    title,
    projectId: "proj_api",
    environmentId: `env_${id}`,
    createdAt: 1,
    ...extra,
  });
}

/** A review as Code Review Workspace 1.10's reviews.v1.status lists it: local, waiting on the user, unless `extra` says otherwise. */
function crwReview(extra: Record<string, unknown> = {}) {
  return {
    targetKey: "ref-0",
    id: "accounts-api:ref-0",
    createdAt: 1,
    pr: null,
    branch: null,
    folder: null,
    mainThreadId: null,
    threadIds: [],
    waitsOn: "user",
    waitsOnThreadId: null,
    approved: false,
    since: 1,
    label: "Ready",
    archived: false,
    mergedInto: null,
    ...extra,
  };
}

/** Overrides that archive a review. */
const ARCHIVED = { waitsOn: "nobody", archived: true, label: "Archived" };

/** What BB's callRpc throws when a plugin's RPC fails, as Code Review Workspace's guide lists the cases. */
const rpcError = (status: number, code: string | null, message: string) =>
  experimental_PluginRpcCallError.from({ code: code ?? `http_${status}`, status, message: `HTTP ${status}: ${message}` });
/** Code Review Workspace before 1.10, or still starting. */
const notYet = () => {
  throw rpcError(404, "unknown_method", 'plugin "code-review-workspace" has no rpc method "reviews.v1.status"');
};
const notRunning = () => {
  throw rpcError(503, null, 'plugin "code-review-workspace" is not running (status: disabled)');
};

async function setup(
  options: {
    world?: Partial<World>;
    board?: Record<string, unknown>;
    peers?: string[];
    noBoard?: boolean;
    /** Answers for `gh api <path>`, by path; anything else fails like a 404. */
    github?: Record<string, string>;
  } = {},
) {
  const world: World = {
    children: {
      [ORCH]: [
        thread("thr_lead1", ORCH, "ABC-101 avatar uploads"),
        thread("thr_lead2", ORCH, "ABC-102 image sizes", { projectId: "proj_web" }),
        thread("thr_other", ORCH, "Investigate flaky CI"),
      ],
      thr_lead1: [thread("thr_impl1", "thr_lead1", "ABC-101 impl")],
    },
    bindings: {
      thr_lead1: {
        binding: {
          issueId: "issue-1126",
          identifier: "ABC-101",
          title: "Accept avatar uploads on sign-up",
          stateName: "In Progress",
          url: "https://linear.app/acme/issue/ABC-101",
          tone: "started",
        },
        suggestion: null,
      },
    },
    failSend: false,
    replies: {},
    round: {},
    reviews: [],
    status: null,
    statusReads: 0,
    files: {},
    issueStates: {},
    workspaces: {},
    removed: [],
    startReview: () => ({ ok: true, targetKey: "br-started" }),
    started: [],
    ...options.world,
  };
  const peers = options.peers ?? ["linear", "code-review-workspace"];
  const metadata = new Map<string, Record<string, unknown>>();
  const sent: { threadId: string; text: string; originPluginId?: string; mode: string }[] = [];
  const calls: { archive: string[]; unarchive: string[]; restore: string[] } = { archive: [], unarchive: [], restore: [] };
  const gets: Record<string, number> = {};
  let restoring: string | null = null;
  const allThreads = () => Object.values(world.children).flat();
  const setArchived = (threadId: string, at: number | null): string[] => {
    const thread = allThreads().find((t) => t.id === threadId);
    if (!thread) return [];
    (thread as { archivedAt: number | null }).archivedAt = at;
    // Like bb, archiving a thread takes its children with it.
    return [threadId, ...(at === null ? [] : (world.children[threadId] ?? []).flatMap((child) => setArchived(child.id, at)))];
  };

  const { bb, harness } = createFakePluginHost({
    pluginId: "conductor",
    agentSkillIds: [SKILL, SETUP_SKILL],
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => ({
          id: threadId,
          title: threadId === ORCH ? "Orchestrator" : threadId,
          environmentId: `env_${threadId}`,
          // bb sets the flag a moment after unarchiving.
          canRestoreEnvironment: world.removed.includes(threadId) && (gets[threadId] = (gets[threadId] ?? 0) + 1) > 1,
          status: restoring === threadId ? ((restoring = null), "starting") : "idle",
        }),
        archive: async ({ threadId }: { threadId: string }) => {
          calls.archive.push(threadId);
          return { ok: true, archivedThreadIds: setArchived(threadId, 1_000) };
        },
        unarchive: async ({ threadId }: { threadId: string }) => {
          calls.unarchive.push(threadId);
          setArchived(threadId, null);
          return { ok: true };
        },
        restoreEnvironment: async ({ threadId }: { threadId: string }) => {
          if (restoring) throw new Error("another restore is still starting");
          restoring = threadId;
          calls.restore.push(threadId);
          return {};
        },
        storageLocation: async ({ threadId }: { threadId: string }) => ({ hostId: "host_1", storageRootPath: `/storage/${threadId}` }),
        list: async ({
          parentThreadId,
          threadIds,
          environmentId,
        }: { parentThreadId?: string; threadIds?: string[]; environmentId?: string } = {}) =>
          threadIds
            ? allThreads().filter((t) => threadIds.includes(t.id))
            : environmentId
              ? allThreads().filter((t) => t.environmentId === environmentId)
              : (world.children[parentThreadId ?? ""] ?? []),
        events: {
          list: async ({ threadId }: { threadId: string }) =>
            (world.replies[threadId] ?? []).map((reply, i) => ({ type: "client/turn/requested", seq: i, ...reply })),
        },
        experimental_listPluginMetadata: async ({ threadIds }: { threadIds: string[] }) => ({
          threads: threadIds
            .filter((id) => metadata.has(id))
            .map((threadId) => ({ threadId, metadata: metadata.get(threadId)! })),
        }),
        updatePluginMetadata: async ({ threadId, set }: { threadId: string; set: Record<string, unknown> }) => {
          const next = { ...metadata.get(threadId), ...set };
          metadata.set(threadId, next);
          return { metadata: next };
        },
        send: async (args: { threadId: string; mode: string; originPluginId?: string; input: { text: string }[] }) => {
          if (world.failSend) throw new Error("thread is gone");
          sent.push({ threadId: args.threadId, text: args.input[0]!.text, originPluginId: args.originPluginId, mode: args.mode });
          return {};
        },
      },
      projects: {
        list: async () => [
          { id: "proj_api", name: "accounts-api" },
          { id: "proj_web", name: "web-api" },
        ],
      },
      files: {
        read: async ({ path, rootPath }: { path: string; rootPath?: string }) => {
          if (rootPath && !path.startsWith(`${rootPath}/`)) throw new Error("outside root");
          if (!(path in world.files)) throw new Error(`ENOENT ${path}`);
          const content = world.files[path]!;
          return { content, contentEncoding: "utf8", sizeBytes: content.length, sha256: "x" };
        },
      },
      environments: {
        status: async ({ environmentId, mergeBaseBranch }: { environmentId: string; mergeBaseBranch?: string }) => {
          const ws = world.workspaces[environmentId] ?? {};
          if (ws.offline) return { outcome: "unavailable", message: "machine offline" };
          const branch = `bb/${environmentId}`;
          const upstream = mergeBaseBranch === `origin/${branch}`;
          const main = mergeBaseBranch === "origin/main";
          const missing = upstream && ws.noUpstream;
          return {
            outcome: "available",
            workspace: {
              branch: { currentBranch: branch, defaultBranch: "main" },
              checkout: { kind: "branch", branchName: branch, headSha: "abc" },
              workingTree: { hasUncommittedChanges: ws.dirty ?? false },
              mergeBase: {
                baseRef: missing ? null : "def",
                aheadCount: missing ? 0 : upstream ? (ws.ahead ?? 0) : main ? 3 : 0,
                hasCommittedUnmergedChanges: main ? !ws.inMain : false,
                squashMergeCheckComplete: true,
              },
            },
          };
        },
        get: async ({ environmentId }: { environmentId: string }) => ({
          path: `/work/${environmentId}`,
          hostId: "host_1",
          id: environmentId,
          branchName: `bb/${environmentId}`,
          mergeBaseBranch: environmentId === "env_thr_lead2" ? "origin/m4-avatars" : "origin/abc-103-api-route",
          baseBranch: null,
          status: world.removed.some((id) => `env_${id}` === environmentId) ? "destroyed" : "ready",
        }),
      },
      plugins: {
        list: async () => ({ plugins: peers.map((id) => ({ id, status: "running", enabled: true })) }),
        callRpc: async (args: { pluginId: string; method: string; input: unknown; outputSchema: { parse(v: unknown): unknown } }) => {
          const raw = (() => {
            if (args.pluginId === "linear" && args.method === "threadIssues") {
              const ids = (args.input as { threadIds: string[] }).threadIds;
              return { threads: Object.fromEntries(ids.filter((id) => id in world.bindings).map((id) => [id, world.bindings[id]])) };
            }
            if (args.pluginId === "linear" && args.method === "resolveIdentifiers") {
              const ids = (args.input as { identifiers: string[] }).identifiers;
              return {
                issues: ids.map((identifier) => ({
                  id: `issue-${identifier}`,
                  identifier,
                  title: `Accounts API - Title of ${identifier}`,
                  url: `https://linear.app/acme/issue/${identifier}`,
                  ...(world.issueStates[identifier] ?? { stateName: "In Progress" }),
                })),
              };
            }
            if (args.pluginId === "linear" && args.method === "issue") {
              return {
                result: {
                  kind: "issue",
                  detail: {
                    identifier: "ABC-101",
                    title: "Accept avatar uploads on sign-up",
                    url: "https://linear.app/acme/issue/ABC-101",
                    stateName: "In Progress",
                    description: "Repo: `accounts-api`\n\n### Acceptance criteria\n* POST /users accepts AvatarURL",
                    relations: { blocks: [{ identifier: "ABC-105", title: "Render avatar", id: "x" }], related: [] },
                  },
                },
              };
            }
            if (args.pluginId === "code-review-workspace" && !peers.includes(args.pluginId)) {
              throw rpcError(404, null, 'unknown plugin "code-review-workspace"');
            }
            if (args.pluginId === "code-review-workspace" && args.method === "reviews.v1.status") {
              world.statusReads++;
              if (world.status) return world.status();
              return {
                reviews: [
                  crwReview({ targetKey: "ref-1", id: "accounts-api:abc-101", createdAt: 6, mainThreadId: "thr_lead1", threadIds: ["thr_lead1"], ...world.round }),
                  crwReview({ targetKey: "ref-2", id: "x:y", createdAt: 5, mainThreadId: "thr_someone_else", threadIds: ["thr_someone_else"] }),
                  crwReview({ targetKey: "ref-3", id: "a:b", createdAt: 4, mainThreadId: "thr_impl1", threadIds: ["thr_impl1"], ...ARCHIVED }),
                  ...world.reviews,
                ],
              };
            }
            if (args.pluginId === "code-review-workspace" && args.method === "reviewThreadChanges") {
              const { threadId } = args.input as { threadId: string };
              world.started.push(threadId);
              return world.startReview(threadId);
            }
            throw new Error(`unexpected rpc ${args.pluginId}.${args.method}`);
          })();
          return args.outputSchema.parse(raw);
        },
      },
    } as never,
  });
  const ghCalls: string[] = [];
  const gh = async (args: string[]) => {
    ghCalls.push(args[1]!);
    const answer = options.github?.[args[1]!];
    if (answer === undefined) throw new Error("gh: Not Found (HTTP 404)");
    return `${answer}\n`;
  };
  await plugin(bb, { gh });
  if (!options.noBoard) {
    await harness.behavior.callRpc("boards.create", { threadId: ORCH });
    await harness.behavior.callRpc("boards.update", { boardId: 1, options: { githubOwner: "acme", ...options.board } });
    await harness.behavior.callRpc("board.refresh", { boardId: 1 });
  }
  return { harness, metadata, sent, world, ghCalls, calls, bb };
}

type Harness = Awaited<ReturnType<typeof setup>>["harness"];

/** The configuration the ABC-101 lead's next session gets. */
const leadConfig = (harness: Harness) =>
  harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({ thread: { id: "thr_lead1" }, pluginMetadata: { boardId: 1, ticketKey: "ABC-101", role: "lead" } }),
  );

async function ask(harness: Harness, threadId: string, overrides: Record<string, unknown> = {}) {
  return harness.behavior.callAgentTool(
    ASK_TOOL,
    {
      question: "Name the avatar key AvatarURL or AvatarUrl?",
      options: [
        { label: "AvatarURL", detail: "Matches PhotoURL" },
        { label: "AvatarUrl" },
      ],
      recommendation: "AvatarURL",
      reasoning: "The create request already uses PhotoURL.",
      blocking: true,
      ...overrides,
    },
    { threadId, projectId: "proj_api" },
  );
}

const openDecisions = async (harness: Harness) =>
  ((await harness.behavior.callRpc("decisions.list", { status: "open" })) as { decisions: Decision[] }).decisions;

describe("ticket discovery", () => {
  it("lists the orchestrator's children as tickets, keyed by Linear or by title", async () => {
    const { harness } = await setup();
    const board = (await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board;

    expect(board.tickets.map((t) => t.key)).toEqual(["ABC-101", "ABC-102"]);
    const [bc1126, abc102] = board.tickets;
    expect(bc1126).toMatchObject({
      title: "Accept avatar uploads on sign-up",
      repo: "accounts-api",
      linearState: "In Progress",
      leadThreadId: "thr_lead1",
      implementerThreadIds: ["thr_impl1"],
      branch: "bb/env_thr_lead1",
      base: "origin/abc-103-api-route",
      milestone: null,
      stage: "code-review",
      openReview: { targetKey: "ref-1", id: "accounts-api:abc-101", state: "needs-review" },
    });
    expect(abc102).toMatchObject({ title: "image sizes", repo: "web-api", milestone: null, linearUrl: null });
  });

  it("tags each ticket thread with its ticket and role", async () => {
    const { metadata } = await setup();
    expect(metadata.get("thr_lead1")).toEqual({ boardId: 1, ticketKey: "ABC-101", role: "lead" });
    expect(metadata.get("thr_impl1")).toEqual({ boardId: 1, ticketKey: "ABC-101", role: "implementer" });
    expect(metadata.has("thr_other")).toBe(false);
  });

  it("still finds tickets by title when Linear is unavailable", async () => {
    const { harness } = await setup({ world: { bindings: { thr_lead1: { binding: "not an object" } } } });
    const board = (await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board;
    expect(board.tickets.map((t) => t.key)).toEqual(["ABC-101", "ABC-102"]);
  });

  it("starts with no boards, and a board from any thread", async () => {
    const { harness } = await setup({ noBoard: true });
    expect(await harness.behavior.callRpc("boards.list", null)).toMatchObject({ boards: [] });
    expect(await harness.behavior.runCli(["tickets"])).toMatchObject({ exitCode: 1 });

    const created = await harness.behavior.runCli(["board", "create", "--thread", ORCH]);
    expect(created).toMatchObject({ exitCode: 0, stdout: "Board 1 (Orchestrator) created with 2 tickets." });
    await expect(harness.behavior.callRpc("boards.create", { threadId: ORCH })).rejects.toThrow("already runs board 1");
  });

  it("keeps two boards apart", async () => {
    const { harness, world } = await setup();
    world.children.thr_orch2 = [thread("thr_lead9", "thr_orch2", "ABC-101 same key, other board")];
    await harness.behavior.callRpc("boards.create", { threadId: "thr_orch2", name: "Second" });
    const second = (await harness.behavior.callRpc("board.list", { boardId: 2 })) as Board;
    expect(second.tickets.map((t) => [t.key, t.leadThreadId])).toEqual([["ABC-101", "thr_lead9"]]);
    const first = (await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board;
    expect(first.tickets.find((t) => t.key === "ABC-101")!.leadThreadId).toBe("thr_lead1");
  });

  it("reads milestones only when the board has a milestone pattern", async () => {
    const { harness } = await setup({ board: { milestonePattern: "^m(\\d+(?:\\.\\d+)?)-", milestoneLabel: "M$1" } });
    const board = (await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board;
    expect(board.tickets.find((t) => t.key === "ABC-102")!.milestone).toBe("M4");
  });

  it("works without the Linear and Code Review Workspace plugins", async () => {
    const { harness } = await setup({ peers: [] });
    const board = (await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board;
    expect(board.integrations).toEqual({ linear: false, codeReview: false });
    expect(board.sweepError).toBeNull();
    expect(board.tickets.find((t) => t.key === "ABC-101")).toMatchObject({ title: "avatar uploads", linearUrl: null, stage: "planning" });
    expect(board.reviewsWaiting).toEqual([]);
  });
});

describe("decisions", () => {
  it("records a decision from an implementer and tells the agent how to wait", async () => {
    const { harness } = await setup();
    const result = await ask(harness, "thr_impl1");

    expect(result).toContain("D-1 is with the user");
    expect(result).toContain("end your turn now");
    expect(result).toContain('"[conductor] D-1 answered"');
    const [decision] = await openDecisions(harness);
    expect(decision).toMatchObject({ ref: "D-1", ticketKey: "ABC-101", threadId: "thr_impl1", blocking: true });
    const board = (await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board;
    expect(board.tickets[0]).toMatchObject({ openDecisions: 1, blockingDecisions: 1 });
  });

  it("lets a non-blocking decision continue", async () => {
    const { harness } = await setup();
    expect(await ask(harness, "thr_lead1", { blocking: false })).toContain("continue with your recommendation");
  });

  it("refuses threads that are not on the board", async () => {
    const { harness } = await setup();
    const result = await ask(harness, "thr_other");
    expect(result).toMatchObject({ isError: true });
    expect(await openDecisions(harness)).toEqual([]);
  });

  it("rejects a decision with one option", async () => {
    const { harness } = await setup();
    await expect(ask(harness, "thr_lead1", { options: [{ label: "Only" }] })).rejects.toThrow();
  });

  it("sends the answer to the asking thread once", async () => {
    const { harness, sent } = await setup();
    await ask(harness, "thr_impl1");

    const answered = (await harness.behavior.callRpc("decisions.answer", {
      id: 1,
      choice: "AvatarURL",
      note: "Keep the URL acronym",
    })) as Decision;

    expect(answered).toMatchObject({ status: "answered", deliveryError: null });
    expect(answered.deliveredAt).not.toBeNull();
    expect(sent).toEqual([
      {
        threadId: "thr_impl1",
        mode: "auto",
        originPluginId: "conductor",
        text: [
          "[conductor] D-1 answered",
          "Question: Name the avatar key AvatarURL or AvatarUrl?",
          "Answer: AvatarURL",
          "Note: Keep the URL acronym",
        ].join("\n"),
      },
    ]);
    await expect(harness.behavior.callRpc("decisions.answer", { id: 1, choice: "AvatarUrl" })).rejects.toThrow(
      "D-1 is already answered",
    );
    expect(sent).toHaveLength(1);
    expect(await openDecisions(harness)).toEqual([]);
  });

  it("keeps a failed delivery for retry", async () => {
    const { harness, sent, world } = await setup();
    await ask(harness, "thr_lead1");
    world.failSend = true;

    const failed = (await harness.behavior.callRpc("decisions.answer", { id: 1, choice: "AvatarUrl" })) as Decision;
    expect(failed.deliveryError).toContain("thread is gone");
    expect(failed.deliveredAt).toBeNull();

    world.failSend = false;
    const retried = (await harness.behavior.callRpc("decisions.retryDelivery", { id: 1 })) as Decision;
    expect(retried.deliveryError).toBeNull();
    expect(sent.map((s) => s.text.split("\n")[0])).toEqual(["[conductor] D-1 answered"]);
  });

  it("tells the agent when a decision is withdrawn", async () => {
    const { harness, sent } = await setup();
    await ask(harness, "thr_lead1");
    await harness.behavior.callRpc("decisions.withdraw", { id: 1, note: "Moved to ABC-106" });
    expect(sent[0]!.text).toContain("[conductor] D-1 withdrawn by the user");
    expect(sent[0]!.text).toContain("Note: Moved to ABC-106");
  });

  it("works from the CLI", async () => {
    const { harness, sent } = await setup();
    const created = await harness.behavior.runCli([
      "ask", "--thread", "thr_lead1", "--question", "Round fps?", "--option", "Round", "--option", "Keep", "--blocking",
    ]);
    expect(created).toMatchObject({ exitCode: 0, stdout: "D-1 created for ABC-101." });

    const listed = await harness.behavior.runCli(["decisions"]);
    expect(listed.stdout).toContain("D-1  ABC-101  open (blocking)  Round fps?");

    const answered = await harness.behavior.runCli(["answer", "D-1", "Keep", "as", "is", "--note", "fine"]);
    expect(answered).toMatchObject({ exitCode: 0, stdout: "D-1 answered, sent to the agent." });
    expect(sent[0]!.text).toContain("Answer: Keep as is");
  });
});

describe("stage reports", () => {
  it("updates the ticket and its history", async () => {
    const { harness } = await setup();
    const result = await harness.behavior.callAgentTool(
      REPORT_TOOL,
      {
        stage: "draft-pr",
        note: "model PR open",
        milestone: "M4",
        prs: [{ repo: "accounts-api", number: 70, url: "https://github.com/acme/accounts-api/pull/70", state: "draft" }],
      },
      { threadId: "thr_impl1" },
    );
    // The fixture's open review round outranks the reported PRs.
    expect(result).toBe('ABC-101 is now "code-review" on the board.');

    const { detail } = (await harness.behavior.callRpc("board.ticket", { boardId: 1, key: "ABC-101" })) as { detail: TicketDetail };
    expect(detail.ticket).toMatchObject({ stageNote: "model PR open", milestone: "M4" });
    expect(detail.ticket.prs).toEqual([
      { repo: "accounts-api", number: 70, url: "https://github.com/acme/accounts-api/pull/70", label: null, base: null, state: "draft" },
    ]);
    expect(detail.ticket).toMatchObject({ stage: "code-review", reportedStage: "draft-pr" });
    expect(detail.stageEvents[0]).toMatchObject({ stage: "draft-pr", threadId: "thr_impl1" });
    expect(detail.linear).toMatchObject({ stateName: "In Progress", blocks: [{ identifier: "ABC-105", title: "Render avatar" }] });
    expect(detail.reviews).toEqual([
      expect.objectContaining({ targetKey: "ref-1", state: "needs-review", threadId: "thr_lead1" }),
      expect.objectContaining({ targetKey: "ref-3", state: "archived", threadId: "thr_impl1" }),
    ]);
  });

  it("accepts plan_review and links a second ticket worked in the same thread", async () => {
    const { harness } = await setup();
    await harness.behavior.callAgentTool(REPORT_TOOL, { stage: "plan_review" }, { threadId: "thr_lead2" });
    let board = (await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board;
    expect(board.tickets.find((t) => t.key === "ABC-102")).toMatchObject({ stage: "planning", reportedStage: "plan-review" });

    const seeded = await harness.behavior.runCli([
      "report", "ABC-103", "--thread", "thr_lead1", "--milestone", "M2",
      "--pr", "accounts-api#74", "--pr", "accounts-api#75:held", "--pr", "accounts-api:local:route PR",
    ]);
    expect(seeded).toMatchObject({ exitCode: 0, stdout: "ABC-103 draft-pr (inferred) M2 #74:draft #75:held route PR:local" });

    board = (await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board;
    const bc1134 = board.tickets.find((t) => t.key === "ABC-103")!;
    expect(bc1134).toMatchObject({
      title: "Accounts API - Title of ABC-103",
      leadThreadId: "thr_lead1",
      implementerThreadIds: ["thr_impl1"],
      sharedWith: ["ABC-101"],
      repo: "accounts-api",
    });
    expect(bc1134.prs[0]!.url).toBe("https://github.com/acme/accounts-api/pull/74");
    expect(board.tickets.find((t) => t.key === "ABC-101")!.sharedWith).toEqual(["ABC-103"]);

    await ask(harness, "thr_impl1", { ticket: "ABC-103" });
    expect((await openDecisions(harness))[0]).toMatchObject({ ticketKey: "ABC-103" });
  });

  it("names the next draft to open after the one in review, when that rule is on", async () => {
    const { harness } = await setup({ board: { rules: { onePrAtATime: true } } });
    await harness.behavior.runCli([
      "report", "ABC-102", "--pr", "web-api#49:merged", "--pr", "web-api#50:open", "--pr", "web-api#51",
    ]);
    const board = (await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board;
    expect(board.nextPr).toMatchObject({ ticketKey: "ABC-102", number: 51, after: { number: 50 } });
    expect(board.tickets.find((t) => t.key === "ABC-102")!.stage).toBe("in-review");
  });

  it("rejects an unknown stage", async () => {
    const { harness } = await setup();
    await expect(
      harness.behavior.callAgentTool(REPORT_TOOL, { stage: "shipping" }, { threadId: "thr_lead1" }),
    ).rejects.toThrow();
  });
});

describe("done after release", () => {
  const noReview = { round: ARCHIVED };
  const merged = (number: number, state = "merged") => ({ repo: "web", number, base: "m1-avatars", state });
  const releasePrs = "pulls?state=closed&base=main&head=acme%3Am1-avatars&per_page=100";
  const github = { "repos/acme/web/pulls/40": "m1-avatars\t2026-03-02T10:00:00Z", "repos/acme/web": "main" };
  const stageOf = async (harness: Harness, key: string) =>
    ((await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board).tickets.find((t) => t.key === key)!.stage;

  it("moves merged work to Done once the milestone's release PR into the default branch merged", async () => {
    const { harness, ghCalls } = await setup({ world: noReview, github: { ...github, [`repos/acme/web/${releasePrs}`]: "" } });
    await harness.behavior.callAgentTool(REPORT_TOOL, { stage: "in-milestone", prs: [merged(40), merged(41, "held")] }, { threadId: "thr_lead2" });
    await harness.behavior.callRpc("board.refresh", { boardId: 1 });
    expect(await stageOf(harness, "ABC-102")).toBe("in-milestone");
    // Without a release PR the branch is compared; a deleted branch is a 404.
    expect(ghCalls).toContain("repos/acme/web/compare/m1-avatars...main");
    expect(ghCalls).not.toContain("repos/acme/web/pulls/41");

    const released = await setup({ world: noReview, github: { ...github, [`repos/acme/web/${releasePrs}`]: "2026-03-09T16:00:00Z" } });
    await released.harness.behavior.callAgentTool(REPORT_TOOL, { stage: "in-milestone", prs: [merged(40)] }, { threadId: "thr_lead2" });
    await released.harness.behavior.callRpc("board.refresh", { boardId: 1 });
    expect(await stageOf(released.harness, "ABC-102")).toBe("done");
  });

  it("does not count a release that merged before the ticket's PR", async () => {
    const { harness } = await setup({ world: noReview, github: { ...github, [`repos/acme/web/${releasePrs}`]: "2026-02-20T16:00:00Z" } });
    await harness.behavior.callAgentTool(REPORT_TOOL, { prs: [merged(40)] }, { threadId: "thr_lead2" });
    await harness.behavior.callRpc("board.refresh", { boardId: 1 });
    expect(await stageOf(harness, "ABC-102")).toBe("in-milestone");
  });

  it("counts a milestone branch that is an ancestor of the default branch, and a PR merged straight into it", async () => {
    const ancestor = await setup({ world: noReview, github: { ...github, [`repos/acme/web/${releasePrs}`]: "", "repos/acme/web/compare/m1-avatars...main": "ahead" } });
    await ancestor.harness.behavior.callAgentTool(REPORT_TOOL, { prs: [merged(40)] }, { threadId: "thr_lead2" });
    await ancestor.harness.behavior.callRpc("board.refresh", { boardId: 1 });
    expect(await stageOf(ancestor.harness, "ABC-102")).toBe("done");

    const direct = await setup({ world: noReview, github: { "repos/acme/web/pulls/40": "main\t2026-03-02T10:00:00Z", "repos/acme/web": "main" } });
    await direct.harness.behavior.callAgentTool(REPORT_TOOL, { prs: [merged(40)] }, { threadId: "thr_lead2" });
    await direct.harness.behavior.callRpc("board.refresh", { boardId: 1 });
    expect(await stageOf(direct.harness, "ABC-102")).toBe("done");
  });

  it("is Done when Linear has the issue completed only once every PR is merged or closed, and archives only then", async () => {
    const binding = { issueId: "issue-1126", identifier: "ABC-101", title: "Accept avatar uploads", stateName: "In Progress", url: null, tone: "started" };
    const { harness, calls } = await setup({
      board: { archiveDoneThreads: true },
      world: { ...noReview, bindings: { thr_lead1: { binding, suggestion: null } } },
    });
    await harness.behavior.callAgentTool(REPORT_TOOL, { stage: "in-review", prs: [merged(40), { ...merged(41), state: "open" }] }, { threadId: "thr_lead1" });
    // Linear closes the ticket when #40 merges into the milestone; #41 is still in review.
    Object.assign(binding, { stateName: "Done", tone: "completed" });
    await harness.behavior.callRpc("board.refresh", { boardId: 1 });
    let board = (await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board;
    expect(board.tickets.find((t) => t.key === "ABC-101")).toMatchObject({ stage: "in-review", doneAt: null, archive: null });
    expect(calls.archive).toEqual([]);

    await harness.behavior.callAgentTool(REPORT_TOOL, { prs: [merged(40), merged(41)] }, { threadId: "thr_lead1" });
    await harness.behavior.callRpc("board.refresh", { boardId: 1 });
    board = (await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board;
    expect(board.tickets.find((t) => t.key === "ABC-101")).toMatchObject({ stage: "done", archive: { state: "archived" } });
  });

  it("reads Linear state on each sweep for tickets without a thread binding", async () => {
    const { harness, world } = await setup({ world: noReview });
    await harness.behavior.callAgentTool(REPORT_TOOL, { prs: [merged(40)] }, { threadId: "thr_lead2" });
    expect(await stageOf(harness, "ABC-102")).toBe("in-milestone");
    world.issueStates["ABC-102"] = { stateName: "Done", tone: "completed" };
    await harness.behavior.callRpc("board.refresh", { boardId: 1 });
    expect(await stageOf(harness, "ABC-102")).toBe("done");
  });
});

describe("done tickets", () => {
  const noReview = { round: ARCHIVED };
  const archiving = { archiveDoneThreads: true };
  const pr = (number: number, state: string) => ({ repo: "web", number, state });
  const ticketOf = async (harness: Harness, key: string) =>
    ((await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board).tickets.find((t) => t.key === key)!;
  const refresh = (harness: Harness) => harness.behavior.callRpc("board.refresh", { boardId: 1 });
  const done = (harness: Harness, threadId: string, prs = [pr(40, "merged")]) =>
    harness.behavior.callAgentTool(REPORT_TOOL, { stage: "done", prs }, { threadId });

  it("archives a Done ticket's lead and implementers once it is safe, and records it", async () => {
    const { harness, calls } = await setup({ world: noReview, board: archiving });
    await done(harness, "thr_lead1");
    await refresh(harness);
    // Archiving the lead takes its implementer with it; nothing else is touched.
    expect(calls.archive).toEqual(["thr_lead1"]);
    const ticket = await ticketOf(harness, "ABC-101");
    expect(ticket.archive).toMatchObject({ state: "archived", reason: null, threadIds: ["thr_lead1", "thr_impl1"] });
    expect(ticket.doneAt).not.toBeNull();
    const { detail } = (await harness.behavior.callRpc("board.ticket", { boardId: 1, key: "ABC-101" })) as { detail: TicketDetail };
    expect(detail.stageEvents[0]).toMatchObject({ kind: "archived", note: "Archived 2 threads" });
  });

  it("keeps a ticket with the reason, and archives it on a later sweep once the check passes", async () => {
    const { harness, calls } = await setup({ world: noReview, board: archiving });
    await done(harness, "thr_lead1", [pr(56, "merged"), pr(57, "held")]);
    await refresh(harness);
    expect((await ticketOf(harness, "ABC-101")).archive).toMatchObject({ state: "kept", reason: "PR #57 held" });
    expect(calls.archive).toEqual([]);
    await done(harness, "thr_lead1", [pr(56, "merged"), pr(57, "closed")]);
    await refresh(harness);
    expect((await ticketOf(harness, "ABC-101")).archive).toMatchObject({ state: "archived" });
  });

  it.each([
    [{ dirty: true }, "uncommitted changes in bb/env_thr_impl1"],
    [{ ahead: 2 }, "2 unpushed commits"],
    [{ noUpstream: true }, "branch not on the remote"],
    [{ offline: true }, "workspace unavailable"],
    [{ noUpstream: true, inMain: true }, null],
  ])("checks each worktree before archiving: %o", async (workspace, reason) => {
    const { harness, calls } = await setup({ world: { ...noReview, workspaces: { env_thr_impl1: workspace } }, board: archiving });
    await done(harness, "thr_lead1");
    await refresh(harness);
    const { archive } = await ticketOf(harness, "ABC-101");
    if (reason) {
      expect(archive).toMatchObject({ state: "kept", reason });
      expect(calls.archive).toEqual([]);
    } else {
      expect(archive).toMatchObject({ state: "archived" });
    }
  });

  it.each([
    ["abc", null],
    ["fff", "branch not on the remote"],
  ])("asks GitHub when the remote branch is gone: merged PR head %s", async (head, reason) => {
    const { harness, calls } = await setup({
      world: { ...noReview, workspaces: { env_thr_impl1: { noUpstream: true } } },
      board: archiving,
      github: { "repos/acme/web/pulls/40": `m1-avatars\t2026-03-02T10:00:00Z\t${head}` },
    });
    await done(harness, "thr_lead1");
    await refresh(harness);
    const { archive } = await ticketOf(harness, "ABC-101");
    if (reason) {
      expect(archive).toMatchObject({ state: "kept", reason });
      expect(calls.archive).toEqual([]);
    } else {
      expect(archive).toMatchObject({ state: "archived" });
    }
  });

  it("keeps a ticket while an agent runs", async () => {
    const children = {
      [ORCH]: [thread("thr_lead1", ORCH, "ABC-101 avatar uploads", { status: "active" })],
      thr_lead1: [],
    };
    const { harness } = await setup({ world: { ...noReview, children }, board: archiving });
    await done(harness, "thr_lead1");
    await refresh(harness);
    expect((await ticketOf(harness, "ABC-101")).archive).toMatchObject({ state: "kept", reason: "an agent is running" });
  });

  it("keeps tickets that share a worktree until every one is Done, then archives them together", async () => {
    const children = {
      [ORCH]: [
        thread("thr_lead1", ORCH, "ABC-101 avatar uploads"),
        thread("thr_lead2", ORCH, "ABC-102 image sizes", { environmentId: "env_thr_lead1" }),
        thread("thr_other", ORCH, "Investigate flaky CI"),
      ],
      thr_lead1: [thread("thr_impl1", "thr_lead1", "ABC-101 impl")],
    };
    const { harness, calls } = await setup({ world: { ...noReview, children }, board: archiving });
    await done(harness, "thr_lead2");
    await refresh(harness);
    expect((await ticketOf(harness, "ABC-102")).archive).toMatchObject({ state: "kept", reason: "workspace shared with ABC-101" });
    await done(harness, "thr_lead1");
    await refresh(harness);
    expect(calls.archive.sort()).toEqual(["thr_lead1", "thr_lead2"]);
    expect((await ticketOf(harness, "ABC-102")).archive).toMatchObject({ state: "archived" });
    expect(calls.archive).not.toContain(ORCH);
    expect(calls.archive).not.toContain("thr_other");
  });

  it("keeps a worktree another thread still uses", async () => {
    const children = {
      [ORCH]: [
        thread("thr_lead2", ORCH, "ABC-102 image sizes"),
        thread("thr_other", ORCH, "Investigate flaky CI", { environmentId: "env_thr_lead2" }),
      ],
    };
    const { harness, calls } = await setup({ world: { ...noReview, children }, board: archiving });
    await done(harness, "thr_lead2");
    await refresh(harness);
    expect((await ticketOf(harness, "ABC-102")).archive).toMatchObject({
      state: "kept",
      reason: 'workspace shared with "Investigate flaky CI"',
    });
    expect(calls.archive).toEqual([]);
  });

  it("leaves a Done ticket's decisions out of the inbox, and keeps its threads for them", async () => {
    const { harness } = await setup({ world: noReview, board: archiving });
    await ask(harness, "thr_lead2", { blocking: false });
    await done(harness, "thr_lead2");
    await refresh(harness);
    expect(await openDecisions(harness)).toEqual([]);
    const all = (await harness.behavior.callRpc("decisions.list", { status: "open", includeDone: true })) as { decisions: Decision[] };
    expect(all.decisions).toHaveLength(1);
    const { boards } = (await harness.behavior.callRpc("boards.list", null)) as { boards: { openDecisions: number }[] };
    expect(boards[0]!.openDecisions).toBe(0);
    expect((await ticketOf(harness, "ABC-102")).archive).toMatchObject({ state: "kept", reason: "1 open decision" });
  });

  it("unarchives the threads, restores removed worktrees, and never archives that ticket again", async () => {
    const { harness, calls, world } = await setup({ world: noReview, board: archiving });
    await done(harness, "thr_lead1");
    await refresh(harness);
    world.removed = ["thr_lead1", "thr_impl1"];
    const { ticket } = (await harness.behavior.callRpc("ticket.unarchive", { boardId: 1, key: "ABC-101" })) as { ticket: Ticket };
    expect(calls.unarchive).toEqual(["thr_lead1", "thr_impl1"]);
    expect(calls.restore).toEqual(["thr_lead1", "thr_impl1"]);
    expect(ticket.archive).toMatchObject({ state: "unarchived" });
    await refresh(harness);
    expect(calls.archive).toEqual(["thr_lead1"]);
    const { detail } = (await harness.behavior.callRpc("board.ticket", { boardId: 1, key: "ABC-101" })) as { detail: TicketDetail };
    expect(detail.stageEvents[0]).toMatchObject({ kind: "unarchived", note: "Unarchived 2 threads, restored 2 worktrees" });
  });

  it("archives nothing with the setting off, but records threads archived by hand and when a ticket was Done", async () => {
    const { harness, calls, world } = await setup({ world: noReview });
    await done(harness, "thr_lead2");
    await refresh(harness);
    expect(calls.archive).toEqual([]);
    expect(await ticketOf(harness, "ABC-102")).toMatchObject({ archive: null, doneAt: expect.any(Number) });
    (world.children[ORCH]!.find((t) => t.id === "thr_lead2") as { archivedAt: number | null }).archivedAt = 5_000;
    await refresh(harness);
    expect((await ticketOf(harness, "ABC-102")).archive).toMatchObject({ state: "archived", at: 5_000 });
    await harness.behavior.callAgentTool(REPORT_TOOL, { stage: "building" }, { threadId: "thr_lead2" });
    expect((await ticketOf(harness, "ABC-102")).doneAt).toBeNull();
  });
});

describe("blocked tickets", () => {
  const noReview = { round: ARCHIVED };
  const ticketOf = async (harness: Harness, key: string) =>
    ((await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board).tickets.find((t) => t.key === key)!;
  const block = (harness: Harness, args: Record<string, unknown> = { stage: "blocked", blockedBy: ["abc-101"], note: "route PR" }) =>
    harness.behavior.callAgentTool(REPORT_TOOL, args, { threadId: "thr_lead2" });

  it("shows what a Blocked ticket waits on and how that ticket moved since, and clears on the next stage", async () => {
    const { harness } = await setup({ world: noReview });
    expect(await block(harness)).toBe('ABC-102 is now "blocked" on the board.');
    expect(await ticketOf(harness, "ABC-102")).toMatchObject({
      stage: "blocked",
      stageNote: "route PR",
      blockedBy: ["ABC-101"],
      blockers: [{ key: "ABC-101", onBoard: true, stage: "planning", moved: null, told: false }],
    });

    await harness.behavior.callAgentTool(
      REPORT_TOOL,
      { stage: "in-review", note: "route PR open", prs: [{ repo: "api", number: 57, state: "open" }] },
      { threadId: "thr_lead1" },
    );
    // A report with only PRs keeps the ticket Blocked.
    await harness.behavior.callAgentTool(REPORT_TOOL, { prs: [{ repo: "api", number: 60, state: "draft" }] }, { threadId: "thr_lead2" });
    expect((await ticketOf(harness, "ABC-102")).blockers[0]).toMatchObject({
      stage: "in-review",
      moved: { stage: "in-review", note: "route PR open" },
    });

    await harness.behavior.callAgentTool(REPORT_TOOL, { stage: "building" }, { threadId: "thr_lead2" });
    expect(await ticketOf(harness, "ABC-102")).toMatchObject({ stage: "building", blockedBy: [], blockers: [] });
    const { detail } = (await harness.behavior.callRpc("board.ticket", { boardId: 1, key: "ABC-102" })) as { detail: TicketDetail };
    expect(detail.stageEvents.map((e) => e.stage)).toContain("blocked");
  });

  it("needs a ticket key or a note, and works from the CLI with a reason that is not a ticket", async () => {
    const { harness } = await setup({ world: noReview });
    expect(await block(harness, { stage: "blocked" })).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining("blockedBy") }],
    });
    expect((await ticketOf(harness, "ABC-102")).stage).not.toBe("blocked");
    await harness.behavior.runCli(["report", "ABC-102", "--stage", "blocked", "--note", "waiting for infra access"]);
    expect(await ticketOf(harness, "ABC-102")).toMatchObject({ stage: "blocked", blockedBy: [], stageNote: "waiting for infra access" });
    await harness.behavior.runCli(["report", "ABC-102", "--stage", "blocked", "--blocked-by", "ABC-101", "--blocked-by", "XYZ-9"]);
    expect((await ticketOf(harness, "ABC-102")).blockers.map((b) => [b.key, b.onBoard])).toEqual([
      ["ABC-101", true],
      ["XYZ-9", false],
    ]);
  });

  it("tells the agent its blocker is Done from the button, and on its own with the board setting", async () => {
    const { harness, sent } = await setup({ world: noReview });
    await block(harness);
    await expect(harness.behavior.callRpc("ticket.tellUnblocked", { boardId: 1, key: "ABC-102" })).rejects.toThrow("is Done yet");
    await harness.behavior.runCli(["report", "ABC-101", "--stage", "done"]);
    const { ticket } = (await harness.behavior.callRpc("ticket.tellUnblocked", { boardId: 1, key: "ABC-102" })) as { ticket: Ticket };
    expect(sent.at(-1)).toMatchObject({
      threadId: "thr_lead2",
      text: "[conductor] ABC-101 is Done. You can continue ABC-102; report your next stage when you resume.",
    });
    expect(ticket.blockers[0]).toMatchObject({ stage: "done", told: true });

    const auto = await setup({ world: noReview, board: { tellBlockedAgents: true } });
    await block(auto.harness);
    await auto.harness.behavior.runCli(["report", "ABC-101", "--stage", "done"]);
    await auto.harness.behavior.callRpc("board.refresh", { boardId: 1 });
    await auto.harness.behavior.callRpc("board.refresh", { boardId: 1 });
    expect(auto.sent.filter((m) => m.threadId === "thr_lead2")).toHaveLength(1);
  });
});

describe("review rounds", () => {
  const boardOf = async (harness: Harness) => (await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board;
  const detailOf = async (harness: Harness, key: string) =>
    ((await harness.behavior.callRpc("board.ticket", { boardId: 1, key })) as { detail: TicketDetail }).detail;
  const poll = (harness: Harness) => harness.behavior.callRpc("reviews.poll", null);

  it("drops a round from Code review as soon as it is archived, without waiting for a sweep", async () => {
    const { harness, world } = await setup();
    const stageOf = async () => (await boardOf(harness)).tickets.find((t) => t.key === "ABC-101")!.stage;
    expect(await stageOf()).toBe("code-review");

    world.round = ARCHIVED;
    const result = await harness.behavior.callAgentTool(
      REPORT_TOOL,
      { stage: "draft-pr", prs: [{ repo: "accounts-api", number: 76 }] },
      { threadId: "thr_lead1" },
    );
    expect(result).toBe('ABC-101 is now "draft-pr" on the board.');
    expect(await stageOf()).toBe("draft-pr");
  });

  it("moves a round to the agent the moment the user sends comments, found by polling", async () => {
    const { harness, world } = await setup();
    expect(await poll(harness)).toEqual({ changed: false });

    world.round = { waitsOn: "agent", waitsOnThreadId: "thr_lead1", since: 10, label: "0 of 2 reported" };
    const signals = harness.realtimeSignals.length;
    expect(await poll(harness)).toEqual({ changed: true });
    expect(harness.realtimeSignals.length).toBeGreaterThan(signals);

    const board = await boardOf(harness);
    expect(board.reviewsWaiting).toEqual([]);
    expect(board.tickets.find((t) => t.key === "ABC-101")).toMatchObject({
      stage: "building",
      openReview: { targetKey: "ref-1", label: "0 of 2 reported", state: "with-agent" },
    });
    expect(await poll(harness)).toEqual({ changed: false });
  });

  it("does not count an approved round as waiting on the user", async () => {
    const { harness } = await setup({ world: { round: { waitsOn: "nobody", approved: true, label: "Approved" } } });
    const board = await boardOf(harness);
    expect(board.tickets.find((t) => t.key === "ABC-101")!.stage).not.toBe("code-review");
    expect(board.reviewsWaiting).toEqual([]);
  });

  // Code Review Workspace's "Who it waits on" table (docs/plugin-api.md), and where each row leaves the ticket.
  it.each([
    ["a local review, nothing sent", "user", false, "needs-review", "code-review"],
    ["comments sent to its main thread, which is fixing them, idle or not", "agent", false, "with-agent", "building"],
    ["…then it reports them all, or runs bb review ready", "user", false, "needs-review", "code-review"],
    ["…or it's archived or deleted first", "user", false, "needs-review", "code-review"],
    ["comments sent from a PR's review, yours or not, being fixed", "agent", false, "with-agent", "building"],
    ["…then a teammate comments on your PR, or someone asks you again", "user", false, "needs-review", "code-review"],
    ["a local review approved in its main thread", "nobody", true, "approved", "planning"],
    ["…then the folder changes, before you click Update and after", "user", false, "needs-review", "code-review"],
    ["your own PR approved in its main thread, then new comments", "user", true, "needs-review", "code-review"],
    ["someone else's PR you requested changes on", "author", false, "with-agent", "building"],
    ["a Push under way", "agent", false, "with-agent", "building"],
    ["a Push under way, approved before", "agent", true, "with-agent", "building"],
    ["a draft PR, a snooze, a folder on another branch or removed", "nobody", false, "idle", "planning"],
    ["a draft PR, a snooze, a folder on another branch or removed, approved before", "nobody", true, "approved", "planning"],
  ] as const)("%s: %s, approved %s, reads as %s and leaves the ticket in %s", async (_, waitsOn, approved, state, stage) => {
    const { harness } = await setup({ world: { round: { waitsOn, approved, since: Date.now() } } });
    const board = await boardOf(harness);
    const waiting = state === "needs-review" || state === "with-agent";
    expect(board.tickets.find((t) => t.key === "ABC-101")).toMatchObject({
      stage,
      openReview: waiting ? { targetKey: "ref-1", state } : null,
    });
    expect(board.reviewsWaiting.map((r) => r.targetKey)).toEqual(state === "needs-review" ? ["ref-1"] : []);
    expect((await detailOf(harness, "ABC-101")).reviews[0]).toMatchObject({ targetKey: "ref-1", state });
  });

  it("keeps a ticket in Building while its review is with the agent, until the agent reports after it went there", async () => {
    const { harness, world } = await setup({
      world: { round: { waitsOn: "agent", since: Date.now() - 1000, label: "1 of 2 reported" } },
    });
    const ticket = async () => (await boardOf(harness)).tickets.find((t) => t.key === "ABC-101")!;
    expect(await ticket()).toMatchObject({ stage: "building", openReview: { state: "with-agent", label: "1 of 2 reported" } });

    await harness.behavior.callAgentTool(
      REPORT_TOOL,
      { stage: "draft-pr", prs: [{ repo: "accounts-api", number: 76 }] },
      { threadId: "thr_lead1" },
    );
    expect((await ticket()).stage).toBe("draft-pr");

    // Another Send after that report takes it back to the agent.
    world.round = { waitsOn: "agent", since: Date.now() + 60_000, label: "0 of 1 reported" };
    await poll(harness);
    expect((await ticket()).stage).toBe("building");
  });

  it("keeps a ticket PR waiting on its author in Building until the agent reports after the review", async () => {
    const { harness } = await setup({
      world: {
        round: ARCHIVED,
        reviews: [
          crwReview({
            targetKey: "pr-9f8e7d6c5b4a3f2e-77",
            id: "accounts-api#77",
            pr: { repo: "acme/accounts-api", number: 77, url: "https://github.com/acme/accounts-api/pull/77", author: "ticket-bot" },
            branch: "abc-101-avatars",
            mainThreadId: "thr_lead1",
            threadIds: ["thr_lead1"],
            waitsOn: "author",
            since: Date.now() - 1000,
            label: "Changes requested",
          }),
        ],
      },
    });
    const ticket = async () => (await boardOf(harness)).tickets.find((t) => t.key === "ABC-101")!;
    expect(await ticket()).toMatchObject({ stage: "building", openReview: { label: "Changes requested", state: "with-agent" } });

    await harness.behavior.callAgentTool(REPORT_TOOL, { stage: "in-review" }, { threadId: "thr_lead1" });
    expect((await ticket()).stage).toBe("in-review");
  });

  // A folder's review (br- keys): one per checkout and branch, whichever thread opened it.
  const folderReview = (extra: Record<string, unknown> = {}) =>
    crwReview({
      targetKey: "br-0a1b2c3d4e5f6a7b",
      id: "web-api:bb/env_thr_lead2",
      createdAt: 7,
      branch: "bb/env_thr_lead2",
      folder: { environmentId: "env_thr_lead2" },
      mainThreadId: "thr_elsewhere",
      threadIds: ["thr_elsewhere"],
      ...extra,
    });

  it("finds a folder review by the ticket's checkout when no ticket thread opened it", async () => {
    const { harness } = await setup({ world: { reviews: [folderReview()] } });
    const board = await boardOf(harness);
    expect(board.tickets.find((t) => t.key === "ABC-102")).toMatchObject({
      stage: "code-review",
      openReview: { targetKey: "br-0a1b2c3d4e5f6a7b", id: "web-api:bb/env_thr_lead2", label: "Ready", state: "needs-review" },
    });
    expect(board.reviewsWaiting).toContainEqual(
      expect.objectContaining({ targetKey: "br-0a1b2c3d4e5f6a7b", ticketKey: "ABC-102", label: "Ready", threadId: "thr_elsewhere" }),
    );
  });

  it("finds a review by the thread its comments went to", async () => {
    const { harness } = await setup({
      world: {
        round: ARCHIVED,
        reviews: [
          folderReview({
            folder: null,
            threadIds: ["thr_elsewhere", "thr_impl1"],
            waitsOn: "agent",
            waitsOnThreadId: "thr_impl1",
            label: "2 of 6 reported",
          }),
        ],
      },
    });
    expect((await boardOf(harness)).tickets.find((t) => t.key === "ABC-101")).toMatchObject({
      stage: "building",
      openReview: { label: "2 of 6 reported", state: "with-agent" },
    });
  });

  it("gives a folder review that several tickets share only to the ticket its branch names", async () => {
    const { harness, world } = await setup({ world: { reviews: [folderReview()] } });
    world.children[ORCH]!.push(thread("thr_lead3", ORCH, "ABC-103 thumbnails", { environmentId: "env_thr_lead2" }));
    await harness.behavior.callRpc("board.refresh", { boardId: 1 });
    let board = await boardOf(harness);
    expect(board.tickets.filter((t) => t.environmentId === "env_thr_lead2").map((t) => [t.key, t.openReview])).toEqual([
      ["ABC-102", null],
      ["ABC-103", null],
    ]);
    expect(board.reviewsWaiting.map((r) => r.targetKey)).not.toContain("br-0a1b2c3d4e5f6a7b");

    world.reviews = [folderReview({ branch: "bb/abc-103-thumbs" })];
    await poll(harness);
    board = await boardOf(harness);
    expect(board.reviewsWaiting).toContainEqual(expect.objectContaining({ targetKey: "br-0a1b2c3d4e5f6a7b", ticketKey: "ABC-103" }));
  });

  it("matches a folder review by checkout only on the ticket's branch or one naming it", async () => {
    const onBranch = (targetKey: string, environmentId: string, branch: string) =>
      folderReview({ targetKey, branch, folder: { environmentId }, mainThreadId: null, threadIds: [] });
    const shared = { environmentId: "env_shared" };
    const { harness } = await setup({
      world: {
        children: {
          [ORCH]: [
            thread("thr_lead1", ORCH, "ABC-101 avatar uploads", shared),
            thread("thr_lead2", ORCH, "ABC-102 image sizes", shared),
            thread("thr_lead3", ORCH, "ABC-103 thumbnails"),
          ],
        },
        round: ARCHIVED,
        reviews: [
          onBranch("br-shared-other", "env_shared", "fix-typo"),
          onBranch("br-shared-named", "env_shared", "abc-102-image-sizes"),
          // ABC-103's checkout, moved to a branch that isn't the ticket's.
          onBranch("br-own-other", "env_thr_lead3", "try-something"),
        ],
      },
    });
    const board = await boardOf(harness);
    expect(board.reviewsWaiting.map((r) => [r.targetKey, r.ticketKey])).toEqual([["br-shared-named", "ABC-102"]]);
    expect(board.tickets.find((t) => t.key === "ABC-103")!.openReview).toBeNull();
  });

  it("assigns a stacked PR's review by its head, not the base that names the ticket below", async () => {
    const { harness } = await setup({
      world: {
        round: ARCHIVED,
        reviews: [
          crwReview({
            targetKey: "pr-acme-web-api-52",
            id: "web-api#52",
            pr: { repo: "acme/web-api", number: 52, url: "https://github.com/acme/web-api/pull/52", author: "sam" },
            branch: "abc-102-sizes",
            mainThreadId: "thr_lead1",
            threadIds: ["thr_lead1", "thr_lead2"],
          }),
        ],
      },
    });
    expect((await boardOf(harness)).reviewsWaiting.map((r) => [r.targetKey, r.ticketKey])).toEqual([
      ["pr-acme-web-api-52", "ABC-102"],
    ]);
  });

  it("leaves out a review merged into another", async () => {
    const { harness } = await setup({
      world: {
        reviews: [
          folderReview({
            targetKey: "br-merged",
            folder: null,
            mainThreadId: null,
            threadIds: ["thr_lead1"],
            waitsOn: "nobody",
            archived: true,
            mergedInto: "ref-1",
            label: "Merged into another review",
          }),
        ],
      },
    });
    expect((await detailOf(harness, "ABC-101")).reviews.map((r) => r.targetKey)).toEqual(["ref-1", "ref-3"]);
  });

  it("assigns a review to the ticket its branch names, not one whose key is a prefix of it", async () => {
    const { harness } = await setup({
      world: {
        round: ARCHIVED,
        reviews: [
          folderReview({ branch: "bb/abc-101-avatars", folder: { environmentId: "env_thr_lead1" }, mainThreadId: null, threadIds: [] }),
        ],
      },
    });
    await harness.behavior.runCli(["report", "ABC-10", "--thread", "thr_lead1"]);
    const board = await boardOf(harness);
    expect(board.reviewsWaiting.map((r) => r.ticketKey)).toEqual(["ABC-101"]);
  });

  const startReview = (harness: Harness, key: string) =>
    harness.behavior.callRpc("reviews.start", { boardId: 1, key }) as Promise<{ targetKey: string }>;

  it("starts the folder review from the ticket's lead thread and shows it without waiting for a poll", async () => {
    const { harness, world } = await setup();
    world.startReview = () => {
      world.reviews.push(folderReview({ targetKey: "br-started", mainThreadId: "thr_lead2", threadIds: ["thr_lead2"] }));
      return { ok: true, targetKey: "br-started" };
    };
    expect((await boardOf(harness)).tickets.find((t) => t.key === "ABC-102")!.openReview).toBeNull();
    const signals = harness.realtimeSignals.length;

    expect(await startReview(harness, "ABC-102")).toEqual({ targetKey: "br-started" });
    expect(world.started).toEqual(["thr_lead2"]);
    expect(harness.realtimeSignals.length).toBeGreaterThan(signals);
    const board = await boardOf(harness);
    expect(board.tickets.find((t) => t.key === "ABC-102")!.openReview).toMatchObject({ targetKey: "br-started" });
    expect(board.reviewsWaiting).toContainEqual(expect.objectContaining({ targetKey: "br-started", ticketKey: "ABC-102" }));
  });

  it("refuses a ticket with no folder or none on the board, and does not call Code Review Workspace", async () => {
    const { harness, world } = await setup();
    world.children[ORCH]!.push(thread("thr_lead3", ORCH, "ABC-130 no checkout", { environmentId: null }));
    await harness.behavior.callRpc("board.refresh", { boardId: 1 });
    expect((await detailOf(harness, "ABC-130")).ticket.environmentId).toBeNull();
    await expect(startReview(harness, "ABC-999")).rejects.toThrow("No ticket ABC-999");
    await expect(startReview(harness, "ABC-130")).rejects.toThrow("has no folder to review");
    expect(world.started).toEqual([]);
  });

  it("passes on why Code Review Workspace did not start the review", async () => {
    const { harness, world } = await setup();
    world.startReview = () => ({ ok: false, error: "This thread’s folder isn’t on a branch." });
    await expect(startReview(harness, "ABC-101")).rejects.toThrow("This thread’s folder isn’t on a branch.");
    world.startReview = () => {
      throw new Error("code-review-workspace is not running");
    };
    await expect(startReview(harness, "ABC-101")).rejects.toThrow(
      "Couldn't reach Code Review Workspace: code-review-workspace is not running",
    );
    expect(world.started).toEqual(["thr_lead1", "thr_lead1"]);
  });

  it("tolerates odd output from Code Review Workspace's start", async () => {
    const { harness, world } = await setup();
    world.startReview = () => ({ ok: true });
    await expect(startReview(harness, "ABC-101")).rejects.toThrow("Code Review Workspace didn't start the review");
    world.startReview = () => null;
    await expect(startReview(harness, "ABC-101")).rejects.toThrow("Couldn't reach Code Review Workspace");
  });

  const cases: [string, Parameters<typeof setup>[0], boolean][] = [
    ["missing", { peers: ["linear"] }, false],
    ["disabled", { world: { status: notRunning } }, false],
    ["older than 1.10", { world: { status: notYet } }, false],
    ["failing", { world: { status: () => { throw rpcError(500, "handler_error", "database is locked"); } } }, true],
    ["answering without a list", { world: { status: () => ({ reviews: "soon" }) } }, true],
    ["answering a list with an odd review", { world: { reviews: [{ targetKey: "br-odd", waitsOn: "everyone" }] } }, true],
  ];
  it.each(cases)("works as without Code Review Workspace when it is %s", async (_, options, logged) => {
    const { harness, world } = await setup({ ...options, board: { rules: { codeReviewRounds: true } } });
    const board = await boardOf(harness);
    expect(board.integrations).toEqual({ linear: true, codeReview: false });
    expect(board.sweepError).toBeNull();
    expect(board.reviewsWaiting).toEqual([]);
    expect(board.tickets.map((t) => [t.key, t.stage, t.openReview])).toEqual([
      ["ABC-101", "planning", null],
      ["ABC-102", "planning", null],
    ]);
    expect((await detailOf(harness, "ABC-101")).reviews).toEqual([]);
    expect((await leadConfig(harness)).instructions).not.toContain("bb review");
    await expect(startReview(harness, "ABC-101")).rejects.toThrow("Code Review Workspace 1.10 or newer is not running");
    expect(world.started).toEqual([]);
    expect(harness.logEntries.some((entry) => entry.message.includes("reviews.v1.status"))).toBe(logged);
  });

  it("asks again on the next poll when Code Review Workspace answers unknown_method while it starts", async () => {
    const { harness, world } = await setup({ world: { status: notYet }, board: { rules: { codeReviewRounds: true } } });
    expect((await boardOf(harness)).integrations.codeReview).toBe(false);

    world.status = null;
    const signals = harness.realtimeSignals.length;
    expect(await poll(harness)).toEqual({ changed: true });
    expect(harness.realtimeSignals.length).toBeGreaterThan(signals);
    let board = await boardOf(harness);
    expect(board.integrations.codeReview).toBe(true);
    expect(board.tickets.find((t) => t.key === "ABC-101")).toMatchObject({ stage: "code-review", openReview: { targetKey: "ref-1" } });
    expect((await leadConfig(harness)).instructions).toContain("bb review");

    // Not answering for a moment later hides it only until a poll gets an answer again.
    world.status = notYet;
    await poll(harness);
    board = await boardOf(harness);
    expect(board.integrations.codeReview).toBe(false);
    expect(board.tickets.find((t) => t.key === "ABC-101")).toMatchObject({ stage: "planning", openReview: null });
    world.status = null;
    await poll(harness);
    expect((await boardOf(harness)).integrations.codeReview).toBe(true);
  });

  it("tells open pages when Code Review Workspace starts or stops answering, though no round moved", async () => {
    const { harness, world } = await setup({ world: { round: ARCHIVED, status: notYet } });
    for (const [status, codeReview] of [[null, true], [notYet, false]] as const) {
      world.status = status;
      const signals = harness.realtimeSignals.length;
      expect(await poll(harness)).toEqual({ changed: false });
      expect(harness.realtimeSignals.length).toBeGreaterThan(signals);
      expect((await boardOf(harness)).integrations.codeReview).toBe(codeReview);
    }
  });

  it("hides every review state as soon as any read finds Code Review Workspace missing", async () => {
    const { harness, world } = await setup();
    expect((await boardOf(harness)).tickets.find((t) => t.key === "ABC-101")!.stage).toBe("code-review");
    world.status = notRunning;
    expect((await detailOf(harness, "ABC-101")).reviews).toEqual([]);
    const board = await boardOf(harness);
    expect(board.integrations.codeReview).toBe(false);
    expect(board.tickets.find((t) => t.key === "ABC-101")).toMatchObject({ stage: "planning", openReview: null });
    expect(board.reviewsWaiting).toEqual([]);
  });
});

describe("review rounds on ticket thread activity", () => {
  const WITH_AGENT = { waitsOn: "agent", waitsOnThreadId: "thr_lead1", since: 10, label: "0 of 2 reported" };
  const stageOf = async (harness: Harness) =>
    ((await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board).tickets.find((t) => t.key === "ABC-101")!.stage;
  const turn = (harness: Harness, event: "thread.active" | "thread.idle", id: string) =>
    harness.emitThreadEvent(event, {
      thread: makeThreadResponse({ id, status: event === "thread.active" ? "active" : "idle" }),
      lastAssistantText: null,
    });
  const message = (harness: Harness, event: "message.queued" | "message.dispatched", threadId: string) =>
    harness.emitThreadEvent(event, { entry: makeQueueEntry({ threadId, originPluginId: "code-review-workspace" }) });

  /** A board set up with real timers, then fake ones from here on. */
  async function setupWithClock(options: Parameters<typeof setup>[0] = {}) {
    const result = await setup(options);
    // Lets the plugin's first sweep finish.
    await new Promise((resolve) => setTimeout(resolve, 50));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    return result;
  }
  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves a ticket's card when its thread's turn starts, with no poll", async () => {
    const { harness, world } = await setupWithClock();
    expect(await stageOf(harness)).toBe("code-review");
    world.round = WITH_AGENT;
    const reads = world.statusReads;
    const signals = harness.realtimeSignals.length;

    await turn(harness, "thread.active", "thr_lead1");
    await vi.advanceTimersByTimeAsync(REVIEW_SETTLE_MS);
    expect(world.statusReads).toBe(reads + 1);
    expect(harness.realtimeSignals.length).toBeGreaterThan(signals);
    expect(await stageOf(harness)).toBe("building");
  });

  it("catches a Send that Code Review Workspace records after delivering it", async () => {
    const { harness, world } = await setupWithClock();
    const reads = world.statusReads;

    await message(harness, "message.dispatched", "thr_lead1");
    await vi.advanceTimersByTimeAsync(500);
    world.round = WITH_AGENT;
    expect(world.statusReads).toBe(reads);
    await vi.advanceTimersByTimeAsync(REVIEW_SETTLE_MS - 500);
    expect(world.statusReads).toBe(reads + 1);
    expect(await stageOf(harness)).toBe("building");
  });

  it("makes one read for a burst of activity on a ticket's threads", async () => {
    const { harness, world } = await setupWithClock();
    const reads = world.statusReads;

    await message(harness, "message.queued", "thr_lead1");
    await vi.advanceTimersByTimeAsync(200);
    await message(harness, "message.dispatched", "thr_lead1");
    await turn(harness, "thread.active", "thr_lead1");
    await vi.advanceTimersByTimeAsync(1_000);
    await turn(harness, "thread.active", "thr_impl1");
    await vi.advanceTimersByTimeAsync(1_000);
    await turn(harness, "thread.idle", "thr_impl1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(world.statusReads).toBe(reads + 1);
  });

  it("still reads during steady activity, and again once it settles", async () => {
    const { harness, world } = await setupWithClock();
    const reads = world.statusReads;

    for (let elapsed = 0; elapsed < REVIEW_MAX_WAIT_MS; elapsed += 1_000) {
      await message(harness, "message.queued", "thr_lead1");
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(world.statusReads).toBe(reads + 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(world.statusReads).toBe(reads + 2);
  });

  it("makes no read for threads that are not on a board", async () => {
    const { harness, world } = await setupWithClock();
    const reads = world.statusReads;

    await turn(harness, "thread.active", "thr_other");
    await turn(harness, "thread.idle", ORCH);
    await message(harness, "message.dispatched", "thr_someone_else");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(world.statusReads).toBe(reads);
  });
});

describe("plan review", () => {
  const PLAN = ["# Avatars", "", "Store the original and", "resize on read.", "", "- Add a CDN purge job"].join("\n");
  const path = "/work/env_thr_lead1/plans/abc-101.md";
  const submit = (harness: Harness, args: Record<string, unknown> = { path }) =>
    harness.behavior.callAgentTool(SUBMIT_PLAN_TOOL, args, { threadId: "thr_lead1" });
  const rounds = async (harness: Harness) =>
    ((await harness.behavior.callRpc("plans.list", { boardId: 1, key: "ABC-101" })) as { rounds: PlanRound[] }).rounds;

  // The default fixture has a code review round open on this lead, which would outrank plan review.
  const noReview = { world: { round: ARCHIVED } };

  it("opens a round from the agent's plan file and puts it in front of the user", async () => {
    const { harness, world } = await setup(noReview);
    world.files[path] = PLAN;
    expect(await submit(harness)).toBe(
      '[conductor] Plan round 1 for ABC-101 is with the user on the Conductor board. End your turn now. The review arrives as a message that starts "[conductor] Plan round 1 for ABC-101".',
    );
    const board = (await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board;
    expect(board.plansWaiting).toEqual([expect.objectContaining({ ticketKey: "ABC-101", n: 1, status: "open", source: "submitted" })]);
    expect(board.tickets.find((t) => t.key === "ABC-101")).toMatchObject({ stage: "plan-review", planRound: { n: 1, status: "open" } });
    const [round] = await rounds(harness);
    const got = (await harness.behavior.callRpc("plans.get", { roundId: round!.id })) as { content: string };
    expect(got.content).toBe(PLAN);
    expect(await harness.behavior.callRpc("plans.waiting", null)).toMatchObject({ rounds: [{ ticketKey: "ABC-101" }] });
  });

  it("refuses files outside the workspace, plans folder and thread storage", async () => {
    const { harness, world } = await setup();
    world.files["/home/me/notes.md"] = PLAN;
    expect(await submit(harness, { path: "/home/me/notes.md" })).toMatchObject({ isError: true });
    expect(await submit(harness, { path: "/work/env_thr_lead1/.env" })).toMatchObject({ isError: true });
    world.files["/storage/thr_lead1/plan.md"] = PLAN;
    expect(await submit(harness, { path: "/storage/thr_lead1/plan.md" })).toContain("Plan round 1");
  });

  it("sends the marks back as one message when changes are requested, then supersedes on resubmit", async () => {
    const { harness, world, sent } = await setup(noReview);
    world.files[path] = PLAN;
    await submit(harness);
    const [round] = await rounds(harness);
    await expect(harness.behavior.callRpc("plans.decide", { roundId: round!.id, decision: "changes_requested" })).rejects.toThrow(
      "Add a mark or an overall comment",
    );
    await harness.behavior.callRpc("plans.mark.save", {
      roundId: round!.id, kind: "comment", quote: "resize on read.", startLine: 3, endLine: 4, comment: "Use a queue.",
    });
    const removal = (await harness.behavior.callRpc("plans.mark.save", {
      roundId: round!.id, kind: "remove", quote: "Add a CDN purge job", startLine: 6, endLine: 6,
    })) as PlanMark;
    await expect(
      harness.behavior.callRpc("plans.mark.save", { roundId: round!.id, kind: "comment", quote: "x", startLine: 40, endLine: 41, comment: "y" }),
    ).rejects.toThrow("outside the plan");

    const decided = (await harness.behavior.callRpc("plans.decide", {
      roundId: round!.id, decision: "changes_requested", overallComment: "Smaller steps.",
    })) as PlanRound;
    expect(decided).toMatchObject({ status: "changes_requested", marks: 2, deliveryError: null });
    expect(sent.at(-1)).toMatchObject({ threadId: "thr_lead1", mode: "auto", originPluginId: "conductor" });
    expect(sent.at(-1)!.text).toContain('## 2. (line 6) Remove: "Add a CDN purge job"');
    expect(sent.at(-1)!.text).toContain("## 3. General feedback about the plan\n> Smaller steps.");
    await expect(harness.behavior.callRpc("plans.mark.delete", { id: removal.id })).rejects.toThrow("already changes requested");

    let board = (await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board;
    expect(board.tickets.find((t) => t.key === "ABC-101")!.stage).toBe("planning");

    world.files[path] = `${PLAN}\n- Add a queue`;
    await submit(harness);
    const all = await rounds(harness);
    expect(all.map((r) => [r.n, r.status])).toEqual([[2, "open"], [1, "changes_requested"]]);
    const diff = (await harness.behavior.callRpc("plans.diff", { fromRoundId: all[1]!.id, toRoundId: all[0]!.id })) as { patch: string };
    expect(diff.patch).toContain("+- Add a queue");

    await harness.behavior.callRpc("plans.decide", { roundId: all[0]!.id, decision: "approved" });
    expect(sent.at(-1)!.text).toContain("[conductor] Plan round 2 for ABC-101: approved");
    board = (await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board;
    expect(board.tickets.find((t) => t.key === "ABC-101")!.stage).toBe("building");
    expect(board.plansWaiting).toEqual([]);
  });

  it("supersedes an open round when the agent submits again", async () => {
    const { harness, world } = await setup();
    world.files[path] = PLAN;
    await submit(harness);
    await submit(harness);
    expect((await rounds(harness)).map((r) => r.status)).toEqual(["open", "superseded"]);
  });

  it("keeps a failed delivery for retry", async () => {
    const { harness, world, sent } = await setup();
    world.files[path] = PLAN;
    await submit(harness);
    const [round] = await rounds(harness);
    world.failSend = true;
    const failed = (await harness.behavior.callRpc("plans.decide", { roundId: round!.id, decision: "approved" })) as PlanRound;
    expect(failed.deliveryError).toContain("thread is gone");
    world.failSend = false;
    const retried = (await harness.behavior.callRpc("plans.retryDelivery", { roundId: round!.id })) as PlanRound;
    expect(retried.deliveredAt).not.toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("refuses a plan while the ticket has open decisions, and takes it once they are answered", async () => {
    const { harness, world } = await setup(noReview);
    world.files[path] = PLAN;
    await ask(harness, "thr_lead1");
    expect(await submit(harness)).toMatchObject({
      isError: true,
      content: [{ text: "ABC-101 has open decisions (D-1). Wait for the answers, fold them into the plan, then submit it." }],
    });
    expect(await rounds(harness)).toEqual([]);
    await harness.behavior.callRpc("decisions.answer", { id: 1, choice: "AvatarURL" });
    await submit(harness);
    expect(await rounds(harness)).toEqual([expect.objectContaining({ n: 1, status: "open" })]);
  });

  it("withdraws the open round when the agent asks a decision, and says so", async () => {
    const { harness, world } = await setup(noReview);
    world.files[path] = PLAN;
    await submit(harness);
    const result = await ask(harness, "thr_lead1", { blocking: false });
    expect(result).toContain("Plan round 1 was withdrawn from the board");
    expect(await rounds(harness)).toEqual([expect.objectContaining({ n: 1, status: "withdrawn" })]);
    const board = (await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board;
    expect(board.plansWaiting).toEqual([]);
    expect(board.tickets.find((t) => t.key === "ABC-101")).toMatchObject({ stage: "planning" });
    const { detail } = (await harness.behavior.callRpc("board.ticket", { boardId: 1, key: "ABC-101" })) as { detail: TicketDetail };
    expect(detail.stageEvents[0]).toMatchObject({ stage: "planning", note: "Plan round 1 withdrawn: the agent asked D-1" });
  });

  it("lets the agent and the CLI withdraw an open round", async () => {
    const { harness, world } = await setup(noReview);
    world.files[path] = PLAN;
    await submit(harness);
    expect(await harness.behavior.callAgentTool(WITHDRAW_PLAN_TOOL, { note: "needs a rework" }, { threadId: "thr_lead1" })).toBe(
      "Plan round 1 for ABC-101 is withdrawn. Submit the plan again with conductor_submit_plan when it is ready.",
    );
    expect(await harness.behavior.callAgentTool(WITHDRAW_PLAN_TOOL, {}, { threadId: "thr_lead1" })).toMatchObject({
      isError: true,
      content: [{ text: "No plan round is open for ABC-101." }],
    });

    await submit(harness);
    await harness.behavior.runCli(["withdraw-plan", "ABC-101", "--note", "split into two tickets"]);
    expect((await rounds(harness)).map((r) => [r.n, r.status])).toEqual([
      [2, "withdrawn"],
      [1, "withdrawn"],
    ]);
    const board = (await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board;
    expect(board.tickets.find((t) => t.key === "ABC-101")).toMatchObject({ stage: "planning", stageNote: "Plan round 2 withdrawn: split into two tickets" });
  });

  it("never opens a round from a plan file in the folder; the ticket page shows it as a draft until the agent submits it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-plans-"));
    const file = join(dir, "2026-11-11-abc101-avatars.md");
    writeFileSync(file, PLAN);
    const { harness, world } = await setup({ ...noReview, board: { plansDir: dir } });
    world.files[file] = PLAN;
    await ask(harness, "thr_lead1");
    await harness.behavior.callRpc("board.refresh", { boardId: 1 });

    const board = (await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board;
    expect(board.plansWaiting).toEqual([]);
    expect(board.tickets.find((t) => t.key === "ABC-101")).toMatchObject({ stage: "planning", planRound: null });
    let { detail } = (await harness.behavior.callRpc("board.ticket", { boardId: 1, key: "ABC-101" })) as { detail: TicketDetail };
    expect(detail.draftPlan).toMatchObject({ path: file });

    await harness.behavior.callRpc("decisions.answer", { id: 1, choice: "AvatarURL" });
    await submit(harness, { path: file });
    ({ detail } = (await harness.behavior.callRpc("board.ticket", { boardId: 1, key: "ABC-101" })) as { detail: TicketDetail });
    expect(detail.ticket).toMatchObject({ stage: "plan-review", planRound: { n: 1, source: "submitted" } });
    expect(detail.draftPlan).toBeNull();
  });

  it("withdraws a round an older version opened from the plans folder", async () => {
    const { harness, world, bb } = await setup(noReview);
    world.files[path] = PLAN;
    await submit(harness);
    bb.storage.database().prepare(`UPDATE plan_rounds SET source = 'inferred'`).run();
    await harness.behavior.callRpc("board.refresh", { boardId: 1 });
    expect(await rounds(harness)).toEqual([expect.objectContaining({ n: 1, status: "withdrawn" })]);
    const { detail } = (await harness.behavior.callRpc("board.ticket", { boardId: 1, key: "ABC-101" })) as { detail: TicketDetail };
    expect(detail.ticket.stage).toBe("planning");
    expect(detail.stageEvents[0]).toMatchObject({ note: "Plan round 1 withdrawn: found in the plans folder, never submitted" });
  });

  it("never lets the plans folder supersede a submitted round; an edited file only marks it changed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-plans-"));
    const file = join(dir, "2026-11-04-abc101-avatars.md");
    const { harness, world } = await setup({ ...noReview, board: { plansDir: dir } });
    writeFileSync(file, PLAN);
    world.files[file] = PLAN;
    await submit(harness, { path: file });

    for (const edit of ["# Avatars, edit 1", "# Avatars, edit 2"]) {
      writeFileSync(file, edit);
      world.files[file] = edit;
      await harness.behavior.callRpc("board.refresh", { boardId: 1 });
    }
    const all = await rounds(harness);
    expect(all).toEqual([expect.objectContaining({ n: 1, source: "submitted", status: "open", fileChanged: true })]);
    const got = (await harness.behavior.callRpc("plans.get", { roundId: all[0]!.id })) as { content: string };
    expect(got.content).toBe(PLAN);
    const board = (await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board;
    expect(board.tickets.find((t) => t.key === "ABC-101")).toMatchObject({ stage: "plan-review", planRound: { n: 1 } });

    // Only the agent's own resubmission opens the next round.
    await submit(harness, { path: file });
    expect((await rounds(harness)).map((r) => [r.n, r.status, r.fileChanged])).toEqual([
      [2, "open", false],
      [1, "superseded", true],
    ]);
  });

});

describe("import from Phase Board", () => {
  const exported = {
    settings: { orchestratorThreadId: ORCH, ticketPattern: "ABC-\\d+", plansDir: "/plans", githubOwner: "acme" },
    tables: {
      tickets: [
        {
          key: "ABC-101", title: "Accept avatar uploads", repo: "api", project_id: "proj_api", linear_url: null,
          linear_issue_id: null, linear_state: null, lead_thread_id: "thr_lead1", environment_id: "env_thr_lead1",
          branch: "b", base: "origin/m2-x", milestone: "M2", reported_milestone: "M2", stage: "planning",
          stage_note: "Paused with the route PR unpushed.", reported_stage: "paused", reported_at: 50,
          prs_json: JSON.stringify([{ repo: "api", number: 76, url: "https://github.com/acme/api/pull/76", label: null, base: null, state: "draft" }]),
          updated_at: 50,
        },
      ],
      thread_tickets: [
        { thread_id: "thr_lead1", ticket_key: "ABC-101", role: "lead", is_primary: 1 },
        { thread_id: "thr_impl1", ticket_key: "ABC-101", role: "implementer", is_primary: 1 },
      ],
      decisions: [
        {
          id: 7, ticket_key: "ABC-101", thread_id: "thr_impl1", question: "Key name?", options_json: '[{"label":"A","detail":null},{"label":"B","detail":null}]',
          recommendation: "A", reasoning: "Because", blocking: 1, status: "answered", answer_choice: "A", answer_note: null,
          answered_at: 40, delivered_at: 41, delivery_error: null, created_at: 30,
        },
      ],
      stage_events: [{ id: 1, ticket_key: "ABC-101", stage: "paused", note: "paused", thread_id: "thr_lead1", at: 50 }],
    },
  };

  it("moves the board, tickets, decisions and history over once, with every rule on", async () => {
    const { harness } = await setup({ noBoard: true });
    harness.sdk.stub("plugins.callRpc", async (args: { pluginId: string; method: string; outputSchema: { parse(v: unknown): unknown } }) => {
      if (args.pluginId === "phase-board" && args.method === "export.all") return args.outputSchema.parse(exported);
      throw new Error("unexpected rpc");
    });

    const result = await harness.behavior.runCli(["import-phase-board"]);
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "Imported into board 1: 1 tickets, 2 thread links, 1 decisions, 1 history entries.",
    });
    const board = (await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board;
    expect(board.board).toMatchObject({ name: "Orchestrator", orchestratorThreadId: ORCH });
    expect(Object.values(board.board.options.rules).every(Boolean)).toBe(true);
    expect(board.board.options).toMatchObject({ ticketPattern: "ABC-\\d+", milestoneLabel: "M$1", plansDir: "/plans", githubOwner: "acme" });
    const ticket = board.tickets.find((t) => t.key === "ABC-101")!;
    expect(ticket).toMatchObject({ stage: "paused", milestone: "M2", implementerThreadIds: ["thr_impl1"] });
    expect(ticket.prs[0]!.number).toBe(76);

    const all = (await harness.behavior.callRpc("decisions.list", { status: "all" })) as { decisions: Decision[] };
    expect(all.decisions).toEqual([expect.objectContaining({ ref: "D-7", boardId: 1, status: "answered" })]);
    const { detail } = (await harness.behavior.callRpc("board.ticket", { boardId: 1, key: "ABC-101" })) as { detail: TicketDetail };
    expect(detail.stageEvents).toEqual([expect.objectContaining({ stage: "paused", note: "paused" })]);

    expect(await harness.behavior.runCli(["import-phase-board"])).toMatchObject({ exitCode: 1 });
  });
});

describe("agent configuration", () => {
  const resolve = (harness: Harness, overrides: Parameters<typeof makePluginAgentConfigurationContext>[0]) =>
    harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext(overrides));

  it("gives ticket threads the tools, the skill and their ticket as data", async () => {
    const { harness } = await setup();
    const config = await resolve(harness, {
      thread: { id: "thr_impl1" },
      pluginMetadata: { boardId: 1, ticketKey: "ABC-101", role: "implementer" },
    });
    expect(config.tools.map((t) => t.name).sort()).toEqual([ASK_TOOL, REPORT_TOOL, SUBMIT_PLAN_TOOL, WITHDRAW_PLAN_TOOL]);
    expect(config.skills).toEqual([SKILL]);
    expect(config.instructions).toContain('ticket "ABC-101" as its implementer');
    expect(config.instructions).toContain("conductor_ask_decision");
    expect(config.instructions).not.toContain("stacked PRs");
  });

  it("builds the instructions from the board's rule switches and its own text", async () => {
    const { harness } = await setup({
      board: { userName: "Sam", rules: { askDecisions: false, splitPrs: true }, extraRules: "Never deploy.\nAsk before merging." },
    });
    const config = await resolve(harness, { thread: { id: "thr_lead1" }, pluginMetadata: { boardId: 1, ticketKey: "ABC-101", role: "lead" } });
    expect(config.tools.map((t) => t.name).sort()).toEqual([REPORT_TOOL, SUBMIT_PLAN_TOOL, WITHDRAW_PLAN_TOOL]);
    expect(config.instructions).not.toContain("conductor_ask_decision");
    expect(config.instructions).toContain("stacked PRs by layer");
    expect(config.instructions).toContain("Rules Sam set for this board (board configuration, quoted):\n> Never deploy.\n> Ask before merging.");
  });

  it("tells agents the Code Review Workspace folder-review loop only while it answers its review status", async () => {
    const lead = { thread: { id: "thr_lead1" }, pluginMetadata: { boardId: 1, ticketKey: "ABC-101", role: "lead" } };
    const board = { userName: "Sam", rules: { codeReviewRounds: true } };

    const on = await resolve((await setup({ board })).harness, lead);
    expect(on.instructions).toContain(
      'run `bb review` with nothing after it in this ticket\'s own worktree, the first time with `--context "ABC-101: <ticket title>"`',
    );
    expect(on.instructions).toContain("Don't open one in a folder shared with other tickets or the orchestrator");
    expect(on.instructions).toContain('`bb review report <id> done|declined --note "..."`');
    expect(on.instructions).toContain("run `bb review ready`");
    expect(on.instructions).toContain("Don't push until Sam or the review says so.");
    expect(on.instructions).toContain(
      "run `bb review report --commit <sha>` before pushing, then do what it prints: push exactly that commit, or wait. Never force-push.",
    );
    expect(on.instructions).toContain("Act only on what Sam sends back from the review.");

    const old = await resolve((await setup({ board, world: { status: notYet } })).harness, lead);
    expect(old.instructions).not.toContain("bb review");
    const missing = await resolve((await setup({ board, peers: ["linear"] })).harness, lead);
    expect(missing.instructions).not.toContain("bb review");
  });

  it("never mentions a person unless the board names one", async () => {
    const { harness } = await setup({ board: { rules: { planRounds: true, onePrAtATime: true } } });
    const config = await resolve(harness, { thread: { id: "thr_lead1" }, pluginMetadata: { boardId: 1, ticketKey: "ABC-101", role: "lead" } });
    expect(config.instructions).toContain("the user");
    expect(config.instructions).not.toMatch(/Adam|Phase Board|phase-board/);
    const result = await ask(harness, "thr_lead1");
    expect(JSON.stringify(result)).not.toMatch(/Adam|Phase Board/);
  });

  it("gives other threads nothing, and the orchestrator only the skill", async () => {
    const { harness } = await setup();
    expect(await resolve(harness, { thread: { id: "thr_random" } })).toMatchObject({ tools: [], skills: [SETUP_SKILL] });
    expect(
      await resolve(harness, { thread: { id: "thr_side" }, pluginMetadata: { boardId: 1, ticketKey: "ABC-101", role: "lead" }, origin: { kind: "fork", pluginId: "side-chat" } } as never),
    ).toMatchObject({ tools: [], skills: [SETUP_SKILL] });
    expect(await resolve(harness, { thread: { id: ORCH } })).toMatchObject({ tools: [], skills: [SKILL, SETUP_SKILL] });
  });

  it("still answers the Phase Board tool names for agents started before the rename", async () => {
    const { harness } = await setup();
    const result = await harness.behavior.callAgentTool(
      LEGACY_TOOLS.report,
      { stage: "building" },
      { threadId: "thr_lead2" },
    );
    expect(result).toBe('ABC-102 is now "building" on the board.');
  });
});
