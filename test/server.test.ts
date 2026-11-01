import { experimental_PluginRpcCallError } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import plugin, { ASK_TOOL, LEGACY_TOOLS, REPORT_TOOL, SETUP_SKILL, SKILL, SUBMIT_PLAN_TOOL } from "../server";
import type { Board, Decision, PlanMark, PlanRound, TicketDetail } from "../src/contract";

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
  /** Files on the agents' machine, by absolute path. */
  files: Record<string, string>;
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
  options: { world?: Partial<World>; board?: Record<string, unknown>; peers?: string[]; noBoard?: boolean } = {},
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
    files: {},
    startReview: () => ({ ok: true, targetKey: "br-started" }),
    started: [],
    ...options.world,
  };
  const peers = options.peers ?? ["linear", "code-review-workspace"];
  const metadata = new Map<string, Record<string, unknown>>();
  const sent: { threadId: string; text: string; originPluginId?: string; mode: string }[] = [];

  const { bb, harness } = createFakePluginHost({
    pluginId: "conductor",
    agentSkillIds: [SKILL, SETUP_SKILL],
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => ({
          id: threadId,
          title: threadId === ORCH ? "Orchestrator" : threadId,
          environmentId: `env_${threadId}`,
        }),
        storageLocation: async ({ threadId }: { threadId: string }) => ({ hostId: "host_1", storageRootPath: `/storage/${threadId}` }),
        list: async ({ parentThreadId, threadIds }: { parentThreadId?: string; threadIds?: string[] } = {}) =>
          threadIds
            ? Object.values(world.children).flat().filter((t) => threadIds.includes(t.id))
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
        status: async () => ({ mergeBase: { aheadCount: 0 } }),
        get: async ({ environmentId }: { environmentId: string }) => ({
          path: `/work/${environmentId}`,
          hostId: "host_1",
          id: environmentId,
          branchName: `bb/${environmentId}`,
          mergeBaseBranch: environmentId === "env_thr_lead2" ? "origin/m4-avatars" : "origin/abc-103-api-route",
          baseBranch: null,
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
                  stateName: "In Progress",
                  url: `https://linear.app/acme/issue/${identifier}`,
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
  await plugin(bb);
  if (!options.noBoard) {
    await harness.behavior.callRpc("boards.create", { threadId: ORCH });
    await harness.behavior.callRpc("boards.update", { boardId: 1, options: { githubOwner: "acme", ...options.board } });
    await harness.behavior.callRpc("board.refresh", { boardId: 1 });
  }
  return { harness, metadata, sent, world };
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
    expect(board.tickets.find((t) => t.key === "ABC-102")).toMatchObject({ stage: "plan-review", stageSource: "reported" });

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

  it("opens a round on its own from a waiting plan in the plans folder, and closes it when the user replies in the thread", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-plans-"));
    const file = join(dir, "2026-10-28-abc102-image-sizes.md");
    writeFileSync(file, "# plan");
    utimesSync(file, 1000, 1000);
    const { harness, world } = await setup({ board: { plansDir: dir } });

    let board = (await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board;
    expect(board.tickets.find((t) => t.key === "ABC-102")).toMatchObject({
      stage: "plan-review",
      stageSource: "inferred",
      planRound: { n: 1, source: "inferred", status: "open", path: file },
    });

    // The same file does not open a second round; an agent's message does not close it.
    world.replies.thr_lead2 = [{ createdAt: Date.now() + 60_000, data: { initiator: "agent", senderThreadId: "thr_other" } }];
    board = (await harness.behavior.callRpc("board.refresh", { boardId: 1 })) as Board;
    expect(board.tickets.find((t) => t.key === "ABC-102")).toMatchObject({ stage: "plan-review", planRound: { n: 1 } });

    world.replies.thr_lead2.unshift({ createdAt: Date.now() + 60_001, data: { initiator: "user", senderThreadId: null, source: "tell" } });
    board = (await harness.behavior.callRpc("board.refresh", { boardId: 1 })) as Board;
    expect(board.tickets.find((t) => t.key === "ABC-102")).toMatchObject({ stage: "planning", planRound: { status: "withdrawn" } });

    writeFileSync(file, "# plan, revised");
    board = (await harness.behavior.callRpc("board.refresh", { boardId: 1 })) as Board;
    expect(board.tickets.find((t) => t.key === "ABC-102")).toMatchObject({ stage: "plan-review", planRound: { n: 2, status: "open" } });
  });

  it("leaves tickets that moved past planning alone, and closes a stale inferred round", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-plans-"));
    writeFileSync(join(dir, "2026-10-28-abc102-image-sizes.md"), "# plan");
    const { harness } = await setup({ board: { plansDir: dir } });
    expect(((await harness.behavior.callRpc("board.list", { boardId: 1 })) as Board).plansWaiting).toHaveLength(1);

    await harness.behavior.runCli(["report", "ABC-102", "--stage", "done"]);
    const board = (await harness.behavior.callRpc("board.refresh", { boardId: 1 })) as Board;
    expect(board.tickets.find((t) => t.key === "ABC-102")).toMatchObject({ stage: "done", planRound: { status: "withdrawn" } });
    expect(board.plansWaiting).toEqual([]);
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
    expect(config.tools.map((t) => t.name).sort()).toEqual([ASK_TOOL, REPORT_TOOL, SUBMIT_PLAN_TOOL]);
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
    expect(config.tools.map((t) => t.name).sort()).toEqual([REPORT_TOOL, SUBMIT_PLAN_TOOL]);
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
