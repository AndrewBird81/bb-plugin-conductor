import { useRef, type ReactNode } from "react";
import {
  Markdown,
  UrlLink,
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcMutation as useRpcMutation,
  useBbNavigate,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { defineRpcContract } from "../src/rpc";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { rpcContract, type Review, type Ticket, type TicketDetail } from "../src/contract";
import { useOpenAgentThread, useOrchestratorTabOnFirstVisit } from "./AgentTabs";
import { DecisionCard } from "./DecisionCard";
import { TEXT_LINK } from "./TicketLink";
import { Overview } from "./Overview";
import { BoardSettings } from "./BoardSettings";
import {
  STAGE_LABELS,
  errorText,
  formatTime,
  parseRoute,
  routeBoardId,
  shortTitle,
  useBoard,
  useBoards,
  useGo,
  useOpenDecisions,
  useOpenTicket,
  useReviewRefresh,
  useTicketDetail,
} from "./hooks";
import { PlanReview } from "./PlanReview";
import { StartBoard } from "./StartBoard";

// The part of the bundled GitHub PR Status contract this page reads.
const githubPrStatus = defineRpcContract({
  pullRequests: {
    input: z.object({ keys: z.array(z.string()) }),
    output: z.record(
      z.string(),
      z.discriminatedUnion("outcome", [
        z.object({
          outcome: z.literal("available"),
          pullRequest: z.object({
            number: z.number(),
            title: z.string(),
            url: z.string(),
            state: z.enum(["draft", "open", "merged", "closed"]),
          }),
        }),
        z.object({ outcome: z.literal("absent") }),
        z.object({ outcome: z.literal("unavailable"), message: z.string() }),
      ]),
    ),
  },
});

export function BoardPage({ subPath }: PluginNavPanelProps) {
  const route = parseRoute(subPath);
  const boards = useBoards();
  const list = boards.data?.boards;
  useReviewRefresh();
  const boardId = routeBoardId(route, list);

  let body: ReactNode;
  if (boards.error) body = <Empty>{errorText(boards.error)}</Empty>;
  else if (!boards.data) body = <Empty>Loading…</Empty>;
  else if (route.kind === "start" || (route.kind === "home" && list!.length === 0)) body = <StartBoard />;
  else if (boardId === null || !list!.some((b) => b.id === boardId)) body = <Empty>That board no longer exists.</Empty>;
  else if (route.kind === "settings") body = <BoardSettings boardId={boardId} />;
  else if (route.kind === "ticket") body = <TicketView boardId={boardId} ticketKey={route.key} />;
  else if (route.kind === "plan") body = <PlanReview boardId={boardId} ticketKey={route.key} roundN={route.round} />;
  else body = <OverviewPage boardId={boardId} />;

  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <div className={cn("mx-auto w-full space-y-6", route.kind === "plan" ? "max-w-6xl" : "max-w-5xl")}>{body}</div>
    </div>
  );
}

/** Title-bar controls: refresh and settings for the board in view. */
export function BoardHeader({ subPath }: PluginNavPanelProps) {
  const route = parseRoute(subPath);
  const boards = useBoards();
  const boardId = routeBoardId(route, boards.data?.boards);
  const go = useGo();
  const refresh = useRpcMutation({
    contract: rpcContract,
    method: "board.refresh",
  });
  if (boardId === null) return null;
  return (
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        variant="ghost"
        disabled={refresh.isPending}
        onClick={() => void refresh.mutate({ boardId }).catch(() => {})}
      >
        {refresh.isPending ? "Refreshing…" : "Refresh"}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => go.settings(boardId)}>
        Settings
      </Button>
    </div>
  );
}

function OverviewPage({ boardId }: { boardId: number }) {
  const board = useBoard(boardId);
  const decisions = useOpenDecisions();
  useOrchestratorTabOnFirstVisit(Boolean(board.data));
  if (board.error) return <Empty>{errorText(board.error)}</Empty>;
  if (!board.data) return <Empty>Loading…</Empty>;
  const mine = (decisions.data?.decisions ?? []).filter((d) => d.boardId === boardId);
  return <Overview board={board.data} decisions={mine} />;
}

function TicketView({ boardId, ticketKey }: { boardId: number; ticketKey: string }) {
  const go = useGo();
  const openAgent = useOpenAgentThread();
  const integrations = useBoards().data?.integrations;
  const { data, error } = useTicketDetail(boardId, ticketKey);
  if (error) return <Empty>{errorText(error)}</Empty>;
  if (!data) return <Empty>Loading…</Empty>;
  if (!data.detail) return <Empty>No ticket {ticketKey} on the board.</Empty>;
  const { ticket, decisions, stageEvents, reviews, linear } = data.detail;

  return (
    <>
      <div className="space-y-2">
        <button
          type="button"
          className="text-xs text-muted-foreground hover:underline"
          onClick={() => go.board(boardId)}
        >
          ← All tickets
        </button>
        <h1 className="text-lg font-semibold">
          {ticket.key} {shortTitle(ticket.title)}
        </h1>
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span>{ticket.repo ?? "unknown repo"}</span>
          {ticket.branch && (
            <span className="font-mono text-xs">
              {ticket.branch}
              {ticket.base ? ` → ${ticket.base.replace(/^origin\//, "")}` : ""}
            </span>
          )}
          {ticket.milestone && <span>{ticket.milestone}</span>}
          {ticket.linearState && <span>Linear: {ticket.linearState}</span>}
          <span className="text-foreground">{STAGE_LABELS[ticket.stage]}</span>
          {ticket.stageNote && <span>“{ticket.stageNote}”</span>}
        </p>
        <div className="flex flex-wrap gap-2">
          {ticket.linearUrl && (
            <Button asChild size="sm" variant="outline">
              <UrlLink href={ticket.linearUrl}>Linear</UrlLink>
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => openAgent(ticket.leadThreadId, `${ticket.key} lead`)}>
            Lead thread
          </Button>
          {ticket.implementerThreadIds.map((id, i) => (
            <Button key={id} size="sm" variant="outline" onClick={() => openAgent(id, `${ticket.key} implementer`)}>
              Implementer
              {ticket.implementerThreadIds.length > 1 ? ` ${i + 1}` : ""}
            </Button>
          ))}
        </div>
      </div>

      {ticket.planRound && (
        <Section title="Plan">
          <p className="flex flex-wrap items-center gap-x-3 text-sm">
            <span>
              Round {ticket.planRound.n}: {ticket.planRound.status.replace("_", " ")}
              {ticket.planRound.marks > 0 ? `, ${ticket.planRound.marks} marks` : ""}
            </span>
            {ticket.planRound.status === "open" ? (
              <Button size="sm" onClick={() => go.plan(boardId, ticket.key, ticket.planRound!.n)}>
                Review plan
              </Button>
            ) : (
              <button
                type="button"
                className={cn(TEXT_LINK, "font-medium")}
                onClick={() => go.plan(boardId, ticket.key, ticket.planRound!.n)}
              >
                Open plan
              </button>
            )}
          </p>
        </Section>
      )}

      <Section title="Decisions" count={decisions.length}>
        {decisions.length === 0 ? (
          <Empty>No decisions yet.</Empty>
        ) : (
          <div className="space-y-3">
            {decisions.map((d) => (
              <DecisionCard key={d.id} decision={d} showTicket={false} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Pull requests">
        <PullRequests ticket={ticket} />
      </Section>

      {integrations?.codeReview && (
        <Section
          title="Reviews"
          count={reviews.length}
          trailing={<ReviewChanges boardId={boardId} ticket={ticket} reviews={reviews} />}
        >
          {reviews.length === 0 ? (
            <Empty>No Code Review Workspace reviews for this ticket.</Empty>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border text-sm">
              {reviews.map((r) => (
                <li key={r.targetKey} className="flex flex-wrap items-center gap-x-3 px-3 py-2">
                  <a
                    className="font-mono text-xs hover:underline"
                    href={`/plugins/code-review-workspace/review/${encodeURIComponent(r.targetKey)}`}
                  >
                    {r.id}
                  </a>
                  <span className="text-muted-foreground">{r.label ?? REVIEW_STATE_LABELS[r.state]}</span>
                  {r.createdAt && (
                    <span className="ml-auto text-xs text-muted-foreground">{formatTime(r.createdAt)}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {linear ? (
        <LinearSection boardId={boardId} linear={linear} />
      ) : (
        integrations &&
        !integrations.linear && (
          <p className="text-xs text-muted-foreground">
            Install the Linear plugin to see the issue's description and relations here.
          </p>
        )
      )}

      <Section title="Stage history" count={stageEvents.length}>
        {stageEvents.length === 0 ? (
          <Empty>The agents have not reported a stage yet.</Empty>
        ) : (
          <ul className="space-y-1 text-sm">
            {stageEvents.map((e, i) => (
              <li key={i} className="flex gap-3">
                <span className="w-32 shrink-0 text-muted-foreground">{formatTime(e.at)}</span>
                <span className="w-28 shrink-0">{e.stage ? STAGE_LABELS[e.stage] : "Update"}</span>
                <span className="text-muted-foreground">{e.note}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

/**
 * Opens the ticket's live review in Code Review Workspace; with none, starts
 * its folder's review from the lead thread, then goes to it.
 */
function ReviewChanges({ boardId, ticket, reviews }: { boardId: number; ticket: Ticket; reviews: Review[] }) {
  const start = useRpcMutation({ contract: rpcContract, method: "reviews.start" });
  // bb routes a click on a link inside the plugin in place; the SDK only navigates to this plugin's own panels.
  const link = useRef<HTMLAnchorElement>(null);
  const live = ticket.openReview ?? reviews.find((r) => r.state !== "approved" && r.state !== "archived") ?? null;
  const go = async () => {
    const { targetKey } = await start.mutate({ boardId, key: ticket.key });
    const anchor = link.current;
    if (!anchor) return;
    anchor.href = `/plugins/code-review-workspace/review/${encodeURIComponent(targetKey)}`;
    anchor.click();
  };
  // The hidden link stays mounted whichever button shows: the refetch after starting can switch to Open review first.
  return (
    <span className="flex items-center gap-2">
      {live ? (
        <Button asChild size="sm" variant="outline">
          <a href={`/plugins/code-review-workspace/review/${encodeURIComponent(live.targetKey)}`}>Open review</a>
        </Button>
      ) : (
        ticket.environmentId && (
          <>
            {start.error && (
              <span role="alert" className="text-xs font-normal text-destructive">
                {errorText(start.error)}
              </span>
            )}
            <Button size="sm" variant="outline" disabled={start.isPending} onClick={() => void go().catch(() => {})}>
              {start.isPending ? "Starting review…" : "Review changes"}
            </Button>
          </>
        )
      )}
      <a ref={link} hidden aria-hidden="true" />
    </span>
  );
}

function PullRequests({ ticket }: { ticket: Ticket }) {
  const { data } = useRpcKeyedQuery({
    pluginId: "bb--github-pr-status",
    contract: githubPrStatus,
    method: "pullRequests",
    keys: ticket.environmentId ? [ticket.environmentId] : [],
  });
  const row = ticket.environmentId ? data?.[ticket.environmentId] : undefined;
  const live = row?.outcome === "available" ? row.pullRequest : null;
  const reported = ticket.prs.filter((pr) => pr.url !== live?.url);
  if (!live && reported.length === 0) return <Empty>No PRs yet.</Empty>;
  return (
    <ul className="space-y-1 text-sm">
      {live && (
        <li className="flex gap-2">
          <UrlLink href={live.url} className="hover:underline">
            #{live.number} {live.title}
          </UrlLink>
          <span className="text-muted-foreground">{live.state} · this branch</span>
        </li>
      )}
      {reported.map((pr, i) => (
        <li key={`${pr.url ?? pr.label}-${i}`} className="flex gap-2">
          {pr.url ? (
            <UrlLink href={pr.url} className="hover:underline">
              {pr.repo}#{pr.number}
            </UrlLink>
          ) : (
            <span>
              {pr.repo} {pr.number ? `#${pr.number}` : (pr.label ?? "")}
            </span>
          )}
          <span className="text-muted-foreground">
            {pr.state === "local" ? "not pushed" : pr.state}
            {pr.base ? ` into ${pr.base}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

function LinearSection({ boardId, linear }: { boardId: number; linear: NonNullable<TicketDetail["linear"]> }) {
  const openTicket = useOpenTicket();
  const relation = (label: string, items: { identifier: string; title: string }[]) =>
    items.length > 0 && (
      <p>
        <span className="text-muted-foreground">{label}: </span>
        {items.map((r, i) => (
          <span key={r.identifier}>
            {i > 0 && ", "}
            <button
              type="button"
              className="font-mono hover:underline"
              title={r.title}
              onClick={() => openTicket(boardId, r.identifier)}
            >
              {r.identifier}
            </button>
          </span>
        ))}
      </p>
    );
  return (
    <Section title="Linear">
      <div className="space-y-2 text-sm">
        {relation("Blocks", linear.blocks)}
        {relation("Related", linear.related)}
        {linear.description && (
          <details className="rounded-lg border border-border px-3 py-2">
            <summary className="cursor-pointer text-muted-foreground">Description and acceptance criteria</summary>
            <div className="pt-2">
              <Markdown content={linear.description} />
            </div>
          </details>
        )}
      </div>
    </Section>
  );
}

const REVIEW_STATE_LABELS = {
  "needs-review": "needs your review",
  "with-agent": "your comments are with the agent",
  idle: "not waiting on you",
  approved: "approved",
  archived: "archived",
} as const;

function Section({
  title,
  count,
  trailing,
  children,
}: {
  title: string;
  count?: number;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
        {count !== undefined && <span className="font-normal">({count})</span>}
        {trailing && <span className="ml-auto normal-case tracking-normal">{trailing}</span>}
      </h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}
