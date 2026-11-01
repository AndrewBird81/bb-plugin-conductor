import {
  experimental_useRpcQuery as useRpcQuery,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { useEffect } from "react";
import type { ExperimentalBadge } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import { CHANGED, rpcContract, type Stage } from "../src/contract";

export const PANEL_PATH = "board";

type Method = keyof typeof rpcContract & string;

/** An RPC query that refetches whenever the server says something changed. */
function useLiveQuery<M extends Method>(
  method: M,
  input: z.input<(typeof rpcContract)[M]["input"]>,
  enabled = true,
) {
  const query = useRpcQuery({ contract: rpcContract, method, input, enabled });
  useRealtime(CHANGED, () => {
    if (enabled) void query.refetch();
  });
  return query;
}

export const useBoards = () => useLiveQuery("boards.list", null);
export const useBoard = (boardId: number | null) => useLiveQuery("board.list", { boardId: boardId ?? 1 }, boardId !== null);
export const useOpenDecisions = () => useLiveQuery("decisions.list", { status: "open" });
export const useTicketDetail = (boardId: number, key: string) =>
  useLiveQuery("board.ticket", { boardId, key }, key !== "");
export const useThreadTicket = (threadId: string) => useLiveQuery("thread.ticket", { threadId });
export const usePlansWaiting = () => useLiveQuery("plans.waiting", null);
export const usePlanRounds = (boardId: number, key: string) => useLiveQuery("plans.list", { boardId, key });
export const usePlanRound = (roundId: number | null) =>
  useLiveQuery("plans.get", { roundId: roundId ?? 1 }, roundId !== null);

/** Orchestrator thread id → board id, kept live. */
export function useLiveOrchestrators(): Record<string, number> {
  return useLiveQuery("orchestrators.list", null).data?.boards ?? {};
}

/** Decisions plus plan rounds waiting on the user; a plan round always blocks its lead. */
export function useDecisionBadge(): ExperimentalBadge | null {
  const decisions = useOpenDecisions().data?.decisions ?? [];
  const plans = usePlansWaiting().data?.rounds ?? [];
  const count = decisions.length + plans.length;
  if (count === 0) return null;
  const blocking = decisions.filter((d) => d.blocking).length + plans.length;
  const parts = [
    decisions.length > 0 && `${decisions.length} decision${decisions.length > 1 ? "s" : ""}`,
    plans.length > 0 && `${plans.length} plan${plans.length > 1 ? "s" : ""}`,
  ].filter(Boolean);
  return { count, tone: blocking > 0 ? "warning" : "neutral", label: `${parts.join(" and ")} waiting on you` };
}

/**
 * Where the board page is: `""` (the first board, or Start), `new`,
 * `<boardId>`, `<boardId>/settings` or `<boardId>/<ticket key>`.
 */
export type Route =
  | { kind: "home" }
  | { kind: "start" }
  | { kind: "board"; boardId: number }
  | { kind: "settings"; boardId: number }
  | { kind: "ticket"; boardId: number; key: string }
  | { kind: "plan"; boardId: number; key: string; round: number | null };

export function parseRoute(subPath: string): Route {
  const [first = "", second = "", third = "", fourth = ""] = subPath.split("/").map((part) => decodeURIComponent(part));
  if (first === "") return { kind: "home" };
  if (first === "new") return { kind: "start" };
  const boardId = Number(first);
  if (!Number.isInteger(boardId) || boardId < 1) return { kind: "home" };
  if (second === "settings") return { kind: "settings", boardId };
  if (second !== "" && third === "plan") {
    const round = Number(fourth);
    return { kind: "plan", boardId, key: second, round: Number.isInteger(round) && round > 0 ? round : null };
  }
  if (second !== "") return { kind: "ticket", boardId, key: second };
  return { kind: "board", boardId };
}

/** The board a route shows; home means the first board. */
export function routeBoardId(route: Route, boards: { id: number }[] | undefined): number | null {
  if ("boardId" in route) return route.boardId;
  return route.kind === "home" ? (boards?.[0]?.id ?? null) : null;
}

export function useGo() {
  const navigate = useBbNavigate();
  const to = (subPath: string) => navigate.toPluginPanel(PANEL_PATH, { subPath });
  return {
    board: (boardId: number) => to(String(boardId)),
    ticket: (boardId: number, key: string) => to(`${boardId}/${encodeURIComponent(key)}`),
    settings: (boardId: number) => to(`${boardId}/settings`),
    plan: (boardId: number, key: string, round?: number) =>
      to(`${boardId}/${encodeURIComponent(key)}/plan${round ? `/${round}` : ""}`),
    start: () => to("new"),
  };
}

export function useOpenTicket() {
  const go = useGo();
  return (boardId: number, key: string) => go.ticket(boardId, key);
}

export const STAGE_LABELS: Record<Stage, string> = {
  planning: "Planning",
  "plan-review": "Plan review",
  building: "Building",
  "code-review": "Code review",
  "draft-pr": "Draft PRs",
  "in-review": "In review",
  "in-milestone": "In milestone",
  done: "Done",
  paused: "Paused",
};

export const STAGE_HINTS: Record<Stage, string> = {
  planning: "agents reading and planning",
  "plan-review": "waits on you",
  building: "plan approved, code in progress",
  "code-review": "waits on you",
  "draft-pr": "pushed, not yet open for review",
  "in-review": "open on GitHub, waiting for reviewers",
  "in-milestone": "merged into the milestone branch",
  done: "milestone in main, or work with no PR finished",
  paused: "stopped on purpose; resume from here",
};

/** "In milestone" reads "Merged" on boards without milestones. */
export function stageLabel(stage: Stage, milestones: boolean): string {
  return stage === "in-milestone" && !milestones ? "Merged" : STAGE_LABELS[stage];
}

/** Stages where the next move is the user's. */
export const WAITS_ON_YOU: ReadonlySet<Stage> = new Set<Stage>(["plan-review", "code-review"]);

/** "Accounts API - Accept avatar uploads" → "Accept avatar uploads". */
export function shortTitle(title: string): string {
  const cut = title.indexOf(" - ");
  return cut > 0 && cut < 60 ? title.slice(cut + 3) : title;
}

export function ago(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function formatTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface Presence {
  running: boolean;
  status: string | null;
  title: string | null;
  updatedAt: number | null;
}

/** Live thread state from bb's sidebar data; no polling. */
export function usePresence(): (threadId: string) => Presence {
  const { threads } = useSidebarThreads();
  const byId = new Map(threads.map((t) => [t.id, t]));
  return (threadId) => {
    const t = byId.get(threadId);
    return {
      running: t ? ["active", "starting", "pending"].includes(t.status) : false,
      status: t?.status ?? null,
      title: t?.displayTitle ?? null,
      updatedAt: t?.updatedAt ?? null,
    };
  };
}

/** The orchestrator's children that are not ticket leads (side work like this plugin). */
export function useOtherChildren(orchestratorThreadId: string | null, leadIds: ReadonlySet<string>) {
  const { threads } = useSidebarThreads();
  if (!orchestratorThreadId) return [];
  return threads.filter((t) => t.parentThreadId === orchestratorThreadId && !leadIds.has(t.id) && !t.isArchived);
}

/**
 * Code Review Workspace's change signals reach only its own pages. The server
 * re-reads rounds after activity on ticket threads; the board asks it to
 * re-read too when it opens and when its tab or window comes back into view,
 * for changes made with no ticket thread active. The server publishes a change
 * only when a round moved.
 */
export function useReviewRefresh() {
  const rpc = useRpc<typeof rpcContract>();
  useEffect(() => {
    let askedAt = 0;
    const refresh = () => {
      // Coming back into view can fire both events at once.
      if (document.visibilityState !== "visible" || Date.now() - askedAt < 1_000) return;
      askedAt = Date.now();
      void rpc.call("reviews.poll", null).catch(() => {});
    };
    refresh();
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [rpc]);
}
