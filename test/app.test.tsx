// @vitest-environment jsdom
import { fireEvent, waitFor, within } from "@testing-library/react";
import {
  loadPluginApp,
  mountPluginContentScripts,
  renderSlot,
  type PluginRpcTestHandlers,
} from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcContract } from "@get-bb/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board, BoardSummary, Decision, PlanMark, PlanRound, Review, rpcContract, Ticket, TicketDetail } from "../src/contract";
import { boardOptionsSchema } from "../src/options";
import { useDecisionBadge } from "../app/hooks";

const PLAN = ["# Avatar uploads", "", "Store the original and resize on read.", "", "- Add a CDN purge job"].join("\n");

const round: PlanRound = {
  id: 9,
  boardId: 1,
  ticketKey: "ABC-101",
  threadId: "thr_lead1",
  n: 1,
  path: "/work/acme/plans/abc-101.md",
  sha256: "abc123abc123",
  source: "submitted",
  status: "open",
  summary: null,
  overallComment: null,
  marks: 0,
  submittedAt: Date.now(),
  decidedAt: null,
  deliveredAt: null,
  deliveryError: null,
};

const ticket: Ticket = {
  boardId: 1,
  key: "ABC-101",
  title: "Accept avatar uploads on sign-up",
  repo: "accounts-api",
  projectId: "proj_api",
  linearUrl: "https://linear.app/acme/issue/ABC-101",
  linearState: "In Progress",
  leadThreadId: "thr_lead1",
  implementerThreadIds: ["thr_impl1"],
  environmentId: "env_1",
  branch: "bb/abc-101",
  base: "origin/abc-103-api-route",
  milestone: "M4",
  stage: "plan-review",
  stageSource: "inferred",
  reportedStage: null,
  reportedAt: null,
  stageNote: null,
  sharedWith: ["ABC-103"],
  prs: [],
  planRound: round,
  openReview: null,
  openDecisions: 1,
  blockingDecisions: 1,
  updatedAt: 1,
};

const decision: Decision = {
  id: 7,
  ref: "D-7",
  boardId: 1,
  ticketKey: "ABC-101",
  threadId: "thr_impl1",
  question: "Name the avatar key AvatarURL or AvatarUrl?",
  options: [
    { label: "AvatarURL", detail: "Matches PhotoURL" },
    { label: "AvatarUrl", detail: null },
  ],
  recommendation: "AvatarURL",
  reasoning: "The create request already uses PhotoURL.",
  blocking: true,
  status: "open",
  answer: null,
  deliveredAt: null,
  deliveryError: null,
  createdAt: 1,
};

const drafted: Ticket = {
  ...ticket,
  key: "ABC-104",
  title: "Media Jobs - One upload path for every image",
  stage: "in-review",
  planRound: null,
  sharedWith: [],
  openDecisions: 0,
  blockingDecisions: 0,
  milestone: "M1.5",
  prs: [
    { repo: "media-jobs", number: 49, url: "https://github.com/acme/media-jobs/pull/49", label: null, base: null, state: "merged" },
    { repo: "media-jobs", number: 50, url: "https://github.com/acme/media-jobs/pull/50", label: null, base: null, state: "open" },
    { repo: "media-jobs", number: 51, url: "https://github.com/acme/media-jobs/pull/51", label: null, base: null, state: "draft" },
  ],
};

const summary: BoardSummary = {
  id: 1,
  name: "Checkout",
  orchestratorThreadId: "thr_orch",
  options: boardOptionsSchema.parse({ milestonePattern: "^m(\\d+)-", rules: { onePrAtATime: true } }),
  openDecisions: 1,
  tickets: 2,
};

const board: Board = {
  board: summary,
  integrations: { linear: true, codeReview: true },
  tickets: [ticket, drafted],
  reviewsWaiting: [],
  plansWaiting: [],
  nextPr: { ticketKey: "ABC-104", repo: "media-jobs", number: 51, url: null, after: { number: 50, url: null } },
  lastSweepAt: 1,
  sweepError: null,
};

// Typed against the real contract, widened for renderSlot's untyped default.
const handlers = (h: Partial<PluginRpcTestHandlers<typeof rpcContract>>) => h as PluginRpcTestHandlers<PluginRpcContract>;

const rpc = (
  decisions: Decision[] = [decision],
  boards: BoardSummary[] = [summary],
  current: Board = board,
  plans: PlanRound[] = [],
) =>
  handlers({
  "boards.list": () => ({ boards, integrations: current.integrations }),
  "board.list": () => current,
  "plans.waiting": () => ({ rounds: plans }),
  "plans.list": () => ({ rounds: [round] }),
  "plans.get": () => ({ round, content: PLAN, marks: [] as PlanMark[] }),
  "plans.mark.save": (input) => ({
    id: 1,
    roundId: input.roundId,
    kind: input.kind,
    quote: input.quote,
    startLine: input.startLine,
    endLine: input.endLine,
    comment: input.comment ?? null,
    replacement: input.replacement ?? null,
    createdAt: 1,
  }),
  "plans.comment": () => round,
  "plans.decide": ({ decision }) => ({ ...round, status: decision }),
  "board.ticket": () => ({ detail: null }),
  "orchestrators.list": () => ({ boards: Object.fromEntries(boards.map((b) => [b.orchestratorThreadId, b.id])) }),
  "boards.create": ({ threadId }) => ({ ...summary, id: 2, orchestratorThreadId: threadId }),
  "boards.update": ({ boardId, name }) => ({ ...summary, id: boardId, name: name ?? summary.name }),
  "decisions.list": () => ({ decisions }),
  "decisions.answer": ({ id, choice, note }) => ({
    ...decision,
    id,
    status: "answered" as const,
    answer: { choice, note: note ?? null, at: 2 },
    deliveredAt: 2,
  }),
  "thread.ticket": ({ threadId }) =>
    threadId === "thr_impl1"
      ? { ticket, role: "implementer" as const, decisions: [decision] }
      : { ticket: null, role: null, decisions: [] },
  });

// Radix controls measure themselves; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const app = await loadPluginApp(() => import("../app"));
let cleanup: (() => unknown) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

describe("agent threads in the side panel", () => {
  // Runs first: the orchestrator tab opens once per app session.
  it("opens the orchestrator tab on the first visit and an agent's tab from its card", async () => {
    const opened: unknown[] = [];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: rpc(),
      experimental_openTab: (call) => {
        opened.push(call);
        return true;
      },
    });
    cleanup = () => slot.lifecycle.unmount();
    await slot.findByText("Accept avatar uploads on sign-up");
    await waitFor(() =>
      expect(opened[0]).toMatchObject({ tab: { id: "orchestrator", availability: "fixed", context: { kind: "nav-panel", panelId: "board" } } }),
    );

    const card = slot.getByRole("region", { name: "Plan review" });
    fireEvent.click(within(card).getByRole("button", { name: "Lead" }));
    expect(opened.at(-1)).toMatchObject({
      tab: { id: "agent", availability: "action" },
      params: { threadId: "thr_lead1" },
      title: "ABC-101 lead",
    });
    expect(opened.filter((call) => (call as { tab: { id: string } }).tab.id === "orchestrator")).toHaveLength(1);
  });

  it("falls back to the thread page where there is no board panel", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpc(), experimental_openTab: () => false });
    cleanup = () => slot.lifecycle.unmount();
    await slot.findByText("Accept avatar uploads on sign-up");
    fireEvent.click(within(slot.getByRole("region", { name: "Plan review" })).getByRole("button", { name: "Lead" }));
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ threadId: "thr_lead1" });
  });

  it("registers the orchestrator as a fixed tab and agents as action tabs on the board", () => {
    expect(app.tabs.map((t) => [t.id, t.availability, t.context])).toEqual([
      ["orchestrator", "fixed", { kind: "nav-panel", panelId: "board" }],
      ["agent", "action", { kind: "nav-panel", panelId: "board" }],
    ]);
  });
});

describe("board page", () => {
  it("shows the inbox and the tickets, and answers a decision", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpc() });
    cleanup = () => slot.lifecycle.unmount();

    await slot.findByText(decision.question);
    expect(await slot.findByText("Accept avatar uploads on sign-up")).toBeTruthy();
    const planReview = slot.getByRole("region", { name: "Plan review" });
    expect(planReview.textContent).toContain("ABC-101");
    expect(planReview.textContent).toContain("Same agents as ABC-103.");
    const inReview = slot.getByRole("region", { name: "In review" });
    expect(inReview.textContent).toContain("ABC-104");
    expect(inReview.textContent).toContain("1 of 3 merged.");
    expect(slot.getByRole("region", { name: "Draft PRs" }).textContent).toContain("nothing here");
    expect(slot.container.textContent).toContain("#50 is in review now");
    expect((slot.getByLabelText(/AvatarURL/, { selector: "input" }) as HTMLInputElement).checked).toBe(true);

    fireEvent.change(slot.getByLabelText("Note for the agent"), { target: { value: "Keep the acronym" } });
    fireEvent.click(slot.getByRole("button", { name: "Answer" }));

    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "decisions.answer",
        input: { id: 7, choice: "AvatarURL", note: "Keep the acronym" },
      }),
    );
  });

  it("opens a ticket's page from its card, by its header button or a click elsewhere on it", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpc() });
    cleanup = () => slot.lifecycle.unmount();
    await slot.findByText("Accept avatar uploads on sign-up");
    const ticketPage = { method: "toPluginPanel", options: { subPath: "1/ABC-101" } };
    const calls = slot.inspection.navigateCalls;

    fireEvent.click(slot.getByRole("button", { name: "ABC-101 M4 1 decision accounts-api Accept avatar uploads on sign-up" }));
    expect(calls).toHaveLength(1);
    expect(calls.at(-1)).toMatchObject(ticketPage);

    const shared = slot.getByText("Same agents as ABC-103.");
    fireEvent.click(shared);
    expect(calls).toHaveLength(2);
    expect(calls.at(-1)).toMatchObject(ticketPage);

    // A drag that selected text ends in a click too; it should not leave the board.
    window.getSelection()!.selectAllChildren(shared);
    fireEvent.click(shared);
    window.getSelection()!.removeAllRanges();
    expect(calls).toHaveLength(2);
  });

  it("opens an agent from its card's agent button without opening the ticket", async () => {
    const opened: unknown[] = [];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: rpc(),
      experimental_openTab: (call) => {
        opened.push(call);
        return true;
      },
    });
    cleanup = () => slot.lifecycle.unmount();
    await slot.findByText("Accept avatar uploads on sign-up");

    fireEvent.click(within(slot.getByRole("region", { name: "Plan review" })).getByRole("button", { name: "Lead" }));
    expect(opened.at(-1)).toMatchObject({ tab: { id: "agent" }, params: { threadId: "thr_lead1" } });
    expect(slot.inspection.navigateCalls).toEqual([]);
  });

  it("sends a custom answer typed under Other", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpc() });
    cleanup = () => slot.lifecycle.unmount();
    await slot.findByText(decision.question);

    fireEvent.change(slot.getByLabelText("Your own answer"), { target: { value: "Watermark.URL" } });
    fireEvent.click(slot.getByRole("button", { name: "Answer" }));

    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "decisions.answer",
        input: { id: 7, choice: "Watermark.URL" },
      }),
    );
  });
});

describe.each([
  ["with", true],
  ["without", false],
])("Waiting on you and ticket links %s Code Review Workspace", (_, codeReview) => {
  const waitingReview = { targetKey: "br-104", id: "media-jobs:bb/abc-104", label: "Ready", state: "needs-review" as const, threadId: "thr_lead1", createdAt: 5, since: 5, ticketKey: "ABC-104" };
  // The server sends no review rounds without Code Review Workspace; the board must hide them on the flag alone.
  const current: Board = {
    ...board,
    integrations: { linear: true, codeReview },
    plansWaiting: [round],
    reviewsWaiting: [waitingReview],
  };
  const ticketPage = (key: string) => ({ method: "toPluginPanel", options: { subPath: `1/${key}` } });
  const planPage = { method: "toPluginPanel", options: { subPath: "1/ABC-101/plan/1" } };
  const renderBoard = (openTab?: (call: unknown) => boolean) => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "1" }, {
      rpc: rpc([decision], [summary], current, [round]),
      ...(openTab && { experimental_openTab: openTab }),
    });
    cleanup = () => slot.lifecycle.unmount();
    return slot;
  };

  it("reviews a plan from anywhere on its card, and opens the ticket from its key", async () => {
    const slot = renderBoard();
    const card = within(await slot.findByRole("article", { name: "ABC-101 plan round 1" }));
    const calls = slot.inspection.navigateCalls;

    fireEvent.click(card.getByText("Accept avatar uploads on sign-up"));
    expect(calls).toEqual([expect.objectContaining(planPage)]);
    fireEvent.click(card.getByRole("button", { name: "Review plan round 1 of ABC-101" }));
    expect(calls).toHaveLength(2);
    expect(calls.at(-1)).toMatchObject(planPage);
    fireEvent.click(card.getByRole("button", { name: "ABC-101, ticket page" }));
    expect(calls).toHaveLength(3);
    expect(calls.at(-1)).toMatchObject(ticketPage("ABC-101"));
  });

  it("opens the ticket from a decision's key and its agent from Open thread, and its form stays put", async () => {
    const opened: unknown[] = [];
    const slot = renderBoard((call) => {
      opened.push(call);
      return true;
    });
    const card = within(await slot.findByRole("article", { name: `D-7: ${decision.question}` }));
    const calls = slot.inspection.navigateCalls;

    fireEvent.click(card.getByLabelText(/AvatarUrl/, { selector: "input" }));
    expect((card.getByLabelText(/AvatarUrl/, { selector: "input" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(card.getByText("Other:"));
    fireEvent.change(card.getByLabelText("Your own answer"), { target: { value: "Avatar.URL" } });
    fireEvent.change(card.getByLabelText("Note for the agent"), { target: { value: "Match PhotoURL later" } });
    fireEvent.click(card.getByRole("button", { name: "Answer" }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "decisions.answer",
        input: { id: 7, choice: "Avatar.URL", note: "Match PhotoURL later" },
      }),
    );
    expect(calls).toEqual([]);

    fireEvent.click(card.getByRole("button", { name: "Open thread that asked D-7" }));
    expect(opened.at(-1)).toMatchObject({ tab: { id: "agent" }, params: { threadId: "thr_impl1" }, title: "ABC-101 D-7" });
    expect(calls).toEqual([]);

    fireEvent.click(card.getByRole("button", { name: "ABC-101, ticket page" }));
    expect(calls).toEqual([expect.objectContaining(ticketPage("ABC-101"))]);
  });

  it("opens a ticket's page from its board card and from Next PR's key", async () => {
    const slot = renderBoard();
    const calls = slot.inspection.navigateCalls;
    const inReview = within(await slot.findByRole("region", { name: "In review" }));

    fireEvent.click(inReview.getByText("1 of 3 merged."));
    expect(calls).toEqual([expect.objectContaining(ticketPage("ABC-104"))]);
    const next = slot.getByText("Next PR to open").parentElement!;
    fireEvent.click(within(next).getByRole("button", { name: "ABC-104, ticket page" }));
    expect(calls).toHaveLength(2);
    expect(calls.at(-1)).toMatchObject(ticketPage("ABC-104"));
  });

  it(codeReview ? "lists review rounds by ticket, with links to the ticket and the review" : "hides review rounds", async () => {
    const slot = renderBoard();
    await slot.findByRole("article", { name: "ABC-101 plan round 1" });
    if (!codeReview) {
      expect(slot.queryByRole("heading", { name: /review round/ })).toBeNull();
      expect(slot.queryByRole("link", { name: /Open review/ })).toBeNull();
      return;
    }
    const row = slot.getByRole("link", { name: "Open review of ABC-104 in Code Review Workspace" }).closest("li")!;
    expect(within(row).getByRole("link").getAttribute("href")).toBe("/plugins/code-review-workspace/review/br-104");
    expect(row.textContent).toContain("One upload path for every image");
    fireEvent.click(within(row).getByRole("button", { name: "ABC-104, ticket page" }));
    expect(slot.inspection.navigateCalls).toEqual([expect.objectContaining(ticketPage("ABC-104"))]);
  });

  it("shows the ticket page's decisions without a ticket link, and Reviews only with the plugin", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "1/ABC-101" }, {
      rpc: handlers({
        ...rpc([decision], [summary], current),
        "board.ticket": () => ({ detail: { ticket, decisions: [decision], stageEvents: [], reviews: [], linear: null } }),
      }),
    });
    cleanup = () => slot.lifecycle.unmount();
    const card = within(await slot.findByRole("article", { name: `D-7: ${decision.question}` }));
    expect(card.queryByRole("button", { name: /ticket page/ })).toBeNull();
    expect(card.getByRole("button", { name: "Open thread that asked D-7" })).toBeTruthy();
    expect(slot.getByText("Pull requests")).toBeTruthy();
    expect(slot.queryByRole("heading", { name: /^Reviews/ }) !== null).toBe(codeReview);
  });
});

describe("review refresh", () => {
  const setVisibility = (state: DocumentVisibilityState) => {
    Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  };

  it.each([true, false])(
    "asks the server to re-read reviews when the board opens and when it comes back into view, never as time passes (codeReview %s)",
    async (codeReview) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const current = { ...board, integrations: { linear: true, codeReview } };
        const slot = renderSlot(app.navPanels[0]!, { subPath: "1" }, {
          rpc: handlers({ ...rpc([decision], [summary], current), "reviews.poll": () => ({ changed: false }) }),
        });
        cleanup = () => slot.lifecycle.unmount();
        await slot.findByText("Accept avatar uploads on sign-up");
        const asks = () => slot.inspection.rpcCalls.filter((call) => call.method === "reviews.poll").length;
        expect(asks()).toBe(1);

        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(asks()).toBe(1);

        setVisibility("hidden");
        expect(asks()).toBe(1);
        setVisibility("visible");
        // The window gaining focus with it makes no second ask.
        fireEvent.focus(window);
        expect(asks()).toBe(2);

        await vi.advanceTimersByTimeAsync(5_000);
        fireEvent.focus(window);
        expect(asks()).toBe(3);

        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(asks()).toBe(3);
      } finally {
        Reflect.deleteProperty(document, "visibilityState");
        vi.useRealTimers();
      }
    },
  );
});

describe("badge", () => {
  function BadgeProbe() {
    return <output>{JSON.stringify(useDecisionBadge())}</output>;
  }

  it("counts open decisions and warns when one blocks", async () => {
    const slot = renderSlot({ component: BadgeProbe }, {}, { rpc: rpc() });
    cleanup = () => slot.lifecycle.unmount();
    await waitFor(() =>
      expect(JSON.parse(slot.container.querySelector("output")!.textContent!)).toEqual({
        count: 1,
        tone: "warning",
        label: "1 decision waiting on you",
      }),
    );
  });

  it("shows nothing when the inbox is empty", async () => {
    const slot = renderSlot({ component: BadgeProbe }, {}, { rpc: rpc([]) });
    cleanup = () => slot.lifecycle.unmount();
    await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
    expect(slot.container.querySelector("output")!.textContent).toBe("null");
  });
});

describe("thread context", () => {
  const environment = { id: "env_1" } as never;

  it("shows the ticket in a ticket thread's Info tab", async () => {
    const slot = renderSlot(app.threadInfoRows[0]!, { threadId: "thr_impl1", projectId: "proj_api", environment }, { rpc: rpc() });
    cleanup = () => slot.lifecycle.unmount();
    expect(await slot.findByText("ABC-101 Accept avatar uploads on sign-up")).toBeTruthy();
    expect(slot.getByText("1 waiting on you")).toBeTruthy();
  });

  it("shows nothing for other threads", async () => {
    const slot = renderSlot(app.threadInfoRows[0]!, { threadId: "thr_other", projectId: "proj_api", environment }, { rpc: rpc() });
    cleanup = () => slot.lifecycle.unmount();
    await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
    expect(slot.container.textContent).toBe("");
  });

  it("marks the asking thread's row while a decision is open", async () => {
    const scripts = await mountPluginContentScripts(app, { pluginId: "conductor" });
    const slot = renderSlot(app.appOverlays[0]!, {}, { rpc: rpc() });
    cleanup = async () => {
      slot.lifecycle.unmount();
      await scripts.lifecycle.dispose();
    };
    await waitFor(() =>
      expect(scripts.inspection.getThreadRowStatus("thr_impl1")).toEqual({
        icon: "CircleQuestion",
        label: "Waiting on you",
        tone: "error",
      }),
    );
  });
});

describe("boards", () => {
  it("offers to start a board when there is none", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpc([], []) });
    cleanup = () => slot.lifecycle.unmount();
    expect(await slot.findByText("Start a board")).toBeTruthy();
    expect(slot.getByText(/Use a thread you already have/)).toBeTruthy();
  });

  it("labels the merged stage by the board's milestone setting", async () => {
    const plain = {
      ...board,
      board: { ...summary, options: boardOptionsSchema.parse({}) },
      tickets: board.tickets.map((t) => ({ ...t, milestone: null })),
      nextPr: null,
    };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "1" }, { rpc: rpc([decision], [plain.board], plain) });
    cleanup = () => slot.lifecycle.unmount();
    await slot.findByText("Accept avatar uploads on sign-up");
    expect(slot.getByRole("region", { name: "Merged" })).toBeTruthy();
    expect(slot.queryByText("Next PR to open")).toBeNull();
  });

  it("saves rule switches from the settings page", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "1/settings" }, { rpc: rpc() });
    cleanup = () => slot.lifecycle.unmount();
    fireEvent.click(await slot.findByRole("checkbox", { name: "Split PRs by layer" }));
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toContainEqual(
        expect.objectContaining({
          method: "boards.update",
          input: expect.objectContaining({ boardId: 1, options: expect.objectContaining({ rules: expect.objectContaining({ splitPrs: true }) }) }),
        }),
      ),
    );
  });

  it("offers a board from a top-level thread's menu, and opens it from its orchestrator", () => {
    const action = app.threadActions.find((a) => a.id === "board")!;
    const navigate = { toPluginPanel: vi.fn() };
    const data = { boards: { thr_orch: 1 }, create: vi.fn(async () => ({ id: 2 })) };
    const item = (thread: { id: string; parentThreadId: string | null }) =>
      action.item({ thread, data, navigate, sdk: {} } as never);
    expect(item({ id: "thr_orch", parentThreadId: null })).toMatchObject({ label: "Open its Conductor board" });
    expect(item({ id: "thr_new", parentThreadId: null })).toMatchObject({ label: "Use as a Conductor board" });
    expect(item({ id: "thr_child", parentThreadId: "thr_orch" })).toBeNull();
  });
});

describe("plan review", () => {
  it("puts a waiting plan in Waiting on you and the badge, and opens it from there", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "1" }, {
      rpc: rpc([decision], [summary], { ...board, plansWaiting: [round] }, [round]),
    });
    cleanup = () => slot.lifecycle.unmount();
    const waiting = await slot.findByText("Plan round 1");
    expect(waiting.closest("article")!.textContent).toContain("ABC-101");
    fireEvent.click(within(waiting.closest("article")!).getByRole("button", { name: "Review plan round 1 of ABC-101" }));
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", options: { subPath: "1/ABC-101/plan/1" } });
  });

  it("counts plans in the badge", async () => {
    function BadgeProbe() {
      return <output>{JSON.stringify(useDecisionBadge())}</output>;
    }
    const slot = renderSlot({ component: BadgeProbe }, {}, { rpc: rpc([], [summary], board, [round]) });
    cleanup = () => slot.lifecycle.unmount();
    await waitFor(() =>
      expect(JSON.parse(slot.container.querySelector("output")!.textContent!)).toEqual({
        count: 1,
        tone: "warning",
        label: "1 plan waiting on you",
      }),
    );
  });

  it("turns a selection into a mark on the right lines, and approves", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "1/ABC-101/plan/1" }, { rpc: rpc() });
    cleanup = () => slot.lifecycle.unmount();
    // The test runtime renders Markdown as its source text.
    const text = await slot.findByText("- Add a CDN purge job");
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.mouseUp(text);
    fireEvent.click(await slot.findByRole("button", { name: "Remove" }));
    fireEvent.change(slot.getByLabelText("Why (optional)"), { target: { value: "URLs are versioned." } });
    fireEvent.click(slot.getByRole("button", { name: "Add mark" }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "plans.mark.save",
        input: { roundId: 9, kind: "remove", quote: "- Add a CDN purge job", startLine: 5, endLine: 5, comment: "URLs are versioned." },
      }),
    );

    expect((slot.getByRole("button", { name: "Request changes" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(slot.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "plans.decide",
        input: { roundId: 9, decision: "approved", overallComment: "" },
      }),
    );
  });
});

describe("after a plan decision", () => {
  const decided: PlanRound = { ...round, status: "approved", decidedAt: 2, deliveredAt: 3 };
  const other: PlanRound = { ...round, id: 10, ticketKey: "ABC-102", threadId: "thr_lead2", submittedAt: 5 };
  const decidedRpc = (plans: PlanRound[], decisions: Decision[] = []) =>
    handlers({
      ...rpc(decisions, [summary], board, plans),
      "plans.list": () => ({ rounds: [decided] }),
      "plans.get": () => ({ round: decided, content: PLAN, marks: [] as PlanMark[] }),
    });

  it("offers the next plan waiting", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "1/ABC-101/plan/1" }, { rpc: decidedRpc([other]) });
    cleanup = () => slot.lifecycle.unmount();
    fireEvent.click(await slot.findByRole("button", { name: "Next plan: ABC-102 round 1" }));
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ options: { subPath: "1/ABC-102/plan/1" } });
  });

  it("points to the decisions left, or back to the board when nothing waits", async () => {
    let slot = renderSlot(app.navPanels[0]!, { subPath: "1/ABC-101/plan/1" }, { rpc: decidedRpc([], [decision]) });
    cleanup = () => slot.lifecycle.unmount();
    fireEvent.click(await slot.findByRole("button", { name: "Answer 1 decision on the board" }));
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ options: { subPath: "1" } });
    slot.lifecycle.unmount();

    slot = renderSlot(app.navPanels[0]!, { subPath: "1/ABC-101/plan/1" }, { rpc: decidedRpc([]) });
    cleanup = () => slot.lifecycle.unmount();
    expect(await slot.findByText("Nothing else waits on you.")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Back to the board" }));
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ options: { subPath: "1" } });
  });
});

describe("review changes", () => {
  const review: Review = {
    targetKey: "br-live",
    id: "accounts-api:bb/abc-101",
    label: "2 of 6 reported",
    state: "with-agent",
    threadId: "thr_lead1",
    createdAt: 5,
    since: 6,
  };
  const detail = (reviews: Review[]): TicketDetail => ({ ticket, decisions: [], stageEvents: [], reviews, linear: null });
  const ticketRpc = (reviews: Review[], codeReview = true, start?: () => { targetKey: string }) => {
    const current = { ...board, integrations: { linear: true, codeReview } };
    return handlers({
      ...rpc([decision], [summary], current),
      "board.ticket": () => ({ detail: detail(reviews) }),
      "reviews.start": start ?? (() => ({ targetKey: "br-started" })),
    });
  };
  // The host routes link clicks in place; here they are only recorded.
  const followed: string[] = [];
  const follow = (event: MouseEvent) => {
    const link = (event.target as Element).closest("a");
    if (!link) return;
    event.preventDefault();
    followed.push(link.getAttribute("href") ?? "");
  };
  beforeEach(() => {
    followed.length = 0;
    document.addEventListener("click", follow);
  });
  afterEach(() => document.removeEventListener("click", follow));

  it("is hidden without Code Review Workspace", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "1/ABC-101" }, { rpc: ticketRpc([], false) });
    cleanup = () => slot.lifecycle.unmount();
    await slot.findByText("Pull requests");
    expect(slot.queryByRole("button", { name: "Review changes" })).toBeNull();
  });

  it("starts the folder review and goes to it", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "1/ABC-101" }, { rpc: ticketRpc([]) });
    cleanup = () => slot.lifecycle.unmount();
    fireEvent.click(await slot.findByRole("button", { name: "Review changes" }));
    expect(slot.queryByRole("link", { name: "Open review" })).toBeNull();
    await waitFor(() => expect(followed).toEqual(["/plugins/code-review-workspace/review/br-started"]));
    expect(slot.inspection.rpcCalls).toContainEqual({ method: "reviews.start", input: { boardId: 1, key: "ABC-101" } });
  });

  it("links to the ticket's live review instead of starting one", async () => {
    const done: Review = { ...review, targetKey: "br-done", state: "approved" };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "1/ABC-101" }, { rpc: ticketRpc([done, review]) });
    cleanup = () => slot.lifecycle.unmount();
    const open = await slot.findByRole("link", { name: "Open review" });
    expect(open.getAttribute("href")).toBe("/plugins/code-review-workspace/review/br-live");
    expect(slot.queryByRole("button", { name: "Review changes" })).toBeNull();
    fireEvent.click(open);
    expect(followed).toEqual(["/plugins/code-review-workspace/review/br-live"]);
    expect(slot.inspection.rpcCalls.map((call) => call.method)).not.toContain("reviews.start");
  });

  it("links a live review whatever the folder, and starts none without one", async () => {
    const noFolder = (reviews: Review[]) =>
      handlers({
        ...rpc([decision], [summary], { ...board, integrations: { linear: true, codeReview: true } }),
        "board.ticket": () => ({ detail: { ...detail(reviews), ticket: { ...ticket, environmentId: null } } }),
      });
    let slot = renderSlot(app.navPanels[0]!, { subPath: "1/ABC-101" }, { rpc: noFolder([review]) });
    cleanup = () => slot.lifecycle.unmount();
    expect((await slot.findByRole("link", { name: "Open review" })).getAttribute("href")).toBe(
      "/plugins/code-review-workspace/review/br-live",
    );
    slot.lifecycle.unmount();
    slot = renderSlot(app.navPanels[0]!, { subPath: "1/ABC-101" }, { rpc: noFolder([]) });
    await slot.findByText("Pull requests");
    expect(slot.queryByRole("button", { name: "Review changes" })).toBeNull();
    expect(slot.queryByRole("link", { name: "Open review" })).toBeNull();
  });

  it("shows why a review did not start", async () => {
    const start = () => {
      throw new Error("This thread’s folder isn’t on a branch.");
    };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "1/ABC-101" }, { rpc: ticketRpc([], true, start) });
    cleanup = () => slot.lifecycle.unmount();
    fireEvent.click(await slot.findByRole("button", { name: "Review changes" }));
    expect((await slot.findByRole("alert")).textContent).toContain("isn’t on a branch");
    expect(followed).toEqual([]);
  });
});
