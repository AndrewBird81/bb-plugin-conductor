import { useState, type MouseEvent, type ReactNode } from "react";
import { UrlLink, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { CONTROL_HOVER_TRANSITION } from "@/components/ui/motion";
import { cn } from "@/lib/utils";
import { STAGES, type Board, type Decision, type PlanRound, type PullRequest, type Stage, type Ticket } from "../src/contract";
import { useOpenAgentThread, useOpenOrchestratorTab } from "./AgentTabs";
import { DecisionCard } from "./DecisionCard";
import {
  STAGE_HINTS,
  stageLabel,
  WAITS_ON_YOU,
  ago,
  errorText,
  shortTitle,
  useGo,
  useOpenTicket,
  useOtherChildren,
  usePresence,
  type Presence,
} from "./hooks";

const PIPELINE = STAGES.filter((stage) => stage !== "paused");

export function Overview({ board, decisions }: { board: Board; decisions: Decision[] }) {
  const [milestone, setMilestone] = useState<string>("all");
  const milestones = [...new Set(board.tickets.map((t) => t.milestone).filter((m): m is string => m !== null))].sort();
  const shown = board.tickets.filter((t) => milestone === "all" || t.milestone === milestone);
  const byStage = (stage: Stage) => sortCards(shown.filter((t) => t.stage === stage));
  const milestonesOn = board.board.options.milestonePattern.trim() !== "" || milestones.length > 0;

  return (
    <>
      <section aria-label="Orchestrator" className="overflow-hidden rounded-xl border border-border bg-card">
        <OrchestratorBand board={board} />
        <NeedsYou board={board} decisions={decisions} />
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <h2 className="mr-auto text-[15px] font-semibold tracking-tight">Tickets by stage</h2>
        <Legend />
        {milestones.length > 1 && (
          <div
            role="group"
            aria-label="Milestone"
            className="inline-flex rounded-lg border border-border bg-card p-0.5"
          >
            {["all", ...milestones].map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={milestone === m}
                onClick={() => setMilestone(m)}
                className={cn(
                  "rounded-md px-3 py-1 text-sm text-muted-foreground",
                  milestone === m && "bg-muted text-foreground",
                )}
              >
                {m === "all" ? "All" : m}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="relative">
        <div aria-hidden className="absolute bottom-3 left-[21px] top-3 w-0.5 bg-border" />
        {PIPELINE.map((stage, i) => (
          <StageSection
            key={stage}
            stage={stage}
            marker={String(i + 1)}
            tickets={byStage(stage)}
            milestones={milestonesOn}
          />
        ))}
        <div className="mt-4 border-t border-dashed border-border pt-3">
          <StageSection stage="paused" marker="‖" tickets={byStage("paused")} milestones={milestonesOn} aside />
        </div>
      </div>

      {board.sweepError && <p className="text-xs text-destructive">{board.sweepError}</p>}
    </>
  );
}

function sortCards(tickets: Ticket[]): Ticket[] {
  return [...tickets].sort(
    (a, b) =>
      b.openDecisions - a.openDecisions ||
      (a.milestone ?? "~").localeCompare(b.milestone ?? "~") ||
      a.key.localeCompare(b.key, undefined, { numeric: true }),
  );
}

function OrchestratorBand({ board }: { board: Board }) {
  const navigate = useBbNavigate();
  const openOrchestrator = useOpenOrchestratorTab();
  const openAgent = useOpenAgentThread();
  const presence = usePresence();
  const id = board.board.orchestratorThreadId;
  const leadIds = new Set(board.tickets.map((t) => t.leadThreadId));
  const others = useOtherChildren(id, leadIds);
  if (!id) return null;
  const me = presence(id);
  const running = board.tickets.filter((t) =>
    [t.leadThreadId, ...t.implementerThreadIds].some((tid) => presence(tid).running),
  ).length;
  const milestones = [...new Set(board.tickets.map((t) => t.milestone).filter(Boolean))].sort().join(" and ");

  return (
    <div className="grid gap-y-2 border-b border-border px-4 py-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <Dot presence={me} />
        <h1 className="text-[17px] font-semibold tracking-tight">{me.title ?? "Orchestrator"}</h1>
        <span className="text-sm text-muted-foreground">{describePresence(me)}</span>
        <div className="ml-auto flex gap-2">
          <Button size="sm" onClick={() => (openOrchestrator() ? undefined : navigate.toThread(id))}>
            Talk to it here
          </Button>
          <Button size="sm" variant="secondary" onClick={() => navigate.toThread(id)}>
            Open thread
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        {board.tickets.length} tickets{milestones ? ` across ${milestones}` : ""}, {running} with an agent running.
      </p>
      {others.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          Other work under it:
          {others.map((t) => (
            <button
              key={t.id}
              type="button"
              className="inline-flex items-center gap-1.5 text-foreground hover:underline"
              onClick={() => openAgent(t.id, t.displayTitle)}
            >
              <Dot presence={presence(t.id)} />
              {t.displayTitle}
            </button>
          ))}
        </p>
      )}
    </div>
  );
}

function NeedsYou({ board, decisions }: { board: Board; decisions: Decision[] }) {
  const openTicket = useOpenTicket();
  const next = board.nextPr;
  const showReviews = board.integrations.codeReview;
  const showNext = board.board.options.rules.onePrAtATime;
  return (
    <div
      className={cn(
        "grid",
        showReviews && showNext && "md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]",
        showReviews !== showNext && "md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]",
      )}
    >
      <Slot
        count={decisions.length + board.plansWaiting.length}
        label="waiting on you"
        hot={decisions.length + board.plansWaiting.length > 0}
      >
        {decisions.length + board.plansWaiting.length === 0 ? (
          <p className="text-sm text-muted-foreground">Decisions and plans from your agents land here.</p>
        ) : (
          <div className="space-y-2">
            {board.plansWaiting.map((round) => (
              <PlanWaitingCard key={round.id} round={round} />
            ))}
            {decisions.map((d) => (
              <DecisionCard key={d.id} decision={d} compact />
            ))}
          </div>
        )}
      </Slot>
      {showReviews && (
        <Slot
          count={board.reviewsWaiting.length}
          label={board.reviewsWaiting.length === 1 ? "review round" : "review rounds"}
          hot={board.reviewsWaiting.length > 0}
        >
          {board.reviewsWaiting.length === 0 ? (
            <p className="text-sm text-muted-foreground">No Code Review Workspace round from a ticket agent is open.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {board.reviewsWaiting.map((r) => (
                <li key={r.targetKey} className="flex flex-wrap gap-x-2">
                  <button
                    type="button"
                    className="font-semibold hover:underline"
                    onClick={() => openTicket(board.board.id, r.ticketKey)}
                  >
                    {r.ticketKey}
                  </button>
                  <a
                    className="hover:underline"
                    href={`/plugins/code-review-workspace/review/${encodeURIComponent(r.targetKey)}`}
                  >
                    Open review
                  </a>
                  {r.label && <span className="text-muted-foreground">{r.label}</span>}
                </li>
              ))}
            </ul>
          )}
        </Slot>
      )}
      {showNext && (
        <Slot label="Next PR to open">
          {next ? (
            <div className="space-y-1 text-sm">
              <p>
                {next.url ? (
                  <UrlLink href={next.url} className="font-semibold hover:underline">
                    {next.repo} #{next.number}
                  </UrlLink>
                ) : (
                  <span className="font-semibold">
                    {next.repo} #{next.number}
                  </span>
                )}{" "}
                for{" "}
                <button
                  type="button"
                  className="hover:underline"
                  onClick={() => openTicket(board.board.id, next.ticketKey)}
                >
                  {next.ticketKey}
                </button>
              </p>
              <p className="text-muted-foreground">
                {next.after
                  ? `#${next.after.number} is in review now. You open one at a time, so #${next.number} waits for its review.`
                  : "Nothing is open for review, so this draft is next."}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No draft is waiting to be opened.</p>
          )}
        </Slot>
      )}
    </div>
  );
}

function Slot({ count, label, hot, children }: { count?: number; label: string; hot?: boolean; children: ReactNode }) {
  return (
    <div className="space-y-2 border-border px-4 py-4 [&+&]:border-t md:[&+&]:border-l md:[&+&]:border-t-0">
      <h2 className="flex items-baseline gap-2 text-sm font-semibold">
        {count !== undefined && (
          <span
            className={cn("text-[22px] font-semibold tracking-tight", hot && "text-[var(--brand,var(--attention))]")}
          >
            {count}
          </span>
        )}
        {label}
      </h2>
      {children}
    </div>
  );
}

function Legend() {
  return (
    <div aria-label="Legend" className="hidden flex-wrap gap-3 text-xs text-muted-foreground lg:flex">
      <span className="inline-flex items-center gap-1.5">
        <Pill state="merged">#</Pill>merged
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Pill state="open">#</Pill>open for review
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Pill state="draft">#</Pill>draft
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Pill state="local">local</Pill>not pushed
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Dot presence={{ running: true, status: "active", title: null, updatedAt: null }} />
        agent running
      </span>
    </div>
  );
}

function StageSection({
  stage,
  marker,
  tickets,
  milestones,
  aside = false,
}: {
  stage: Stage;
  marker: string;
  tickets: Ticket[];
  milestones: boolean;
  aside?: boolean;
}) {
  const label = stageLabel(stage, milestones);
  const hint = stage === "in-milestone" && !milestones ? "merged into its base branch" : STAGE_HINTS[stage];
  const yours = WAITS_ON_YOU.has(stage);
  const empty = tickets.length === 0;
  return (
    <section aria-label={label} className="relative grid grid-cols-[56px_minmax(0,1fr)] py-1.5">
      <div
        className={cn(
          "relative z-[1] ml-[11px] mt-0.5 grid size-6 place-items-center rounded-full border-2 bg-background text-[11px] font-bold",
          aside && "border-dashed",
          empty ? "border-border text-muted-foreground" : "border-foreground text-foreground",
          yours && "border-[var(--brand,var(--attention))] text-[var(--brand,var(--attention))]",
          yours && !empty && "bg-[var(--brand,var(--attention))] text-background",
        )}
      >
        {marker}
      </div>
      <div>
        <div className="flex min-h-7 items-baseline gap-2.5">
          <h3
            className={cn(
              "text-base font-semibold tracking-tight",
              empty && "text-sm font-medium text-muted-foreground",
            )}
          >
            {label}
          </h3>
          {!empty && <span className="text-muted-foreground">{tickets.length}</span>}
          <span className={cn("text-xs text-muted-foreground", yours && "text-[var(--brand,var(--attention))]")}>
            {empty ? (yours ? "waits on you, nothing now" : "nothing here") : hint}
          </span>
        </div>
        {!empty && (
          <div className="mb-3.5 mt-2 grid grid-cols-1 gap-2.5 md:grid-cols-[repeat(auto-fill,minmax(330px,1fr))]">
            {tickets.map((t) => (
              <TicketCard key={t.key} ticket={t} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function TicketCard({ ticket }: { ticket: Ticket }) {
  const openTicket = useOpenTicket();
  const openAgent = useOpenAgentThread();
  const presence = usePresence();
  const paused = ticket.stage === "paused";
  const agents = [
    { id: ticket.leadThreadId, role: "Lead" },
    ...ticket.implementerThreadIds.map((id, i) => ({
      id,
      role: ticket.implementerThreadIds.length > 1 ? `Implementer ${i + 1}` : "Implementer",
    })),
  ];
  const open = () => openTicket(ticket.boardId, ticket.key);
  // A click anywhere on the card opens the ticket, for the mouse; the header button is the way in for
  // the keyboard. Inner controls do their own thing, and a drag that selected text is not a click.
  const openFromCard = (e: MouseEvent<HTMLElement>) => {
    if ((e.target as Element).closest("a, button, input, textarea, select, label")) return;
    if (window.getSelection()?.isCollapsed === false) return;
    open();
  };
  return (
    <article
      onClick={openFromCard}
      className={cn(
        "group grid cursor-pointer gap-2.5 rounded-xl border border-border bg-card px-3.5 py-3 hover:bg-muted",
        CONTROL_HOVER_TRANSITION,
        paused && "border-dashed",
        ticket.openDecisions > 0 && "border-[var(--brand,var(--attention))]",
      )}
    >
      {/* The spaces between spans only space out the button's accessible name; flex and grid drop them. */}
      <button
        type="button"
        className="-m-1 grid cursor-pointer gap-0.5 rounded-md p-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={open}
      >
        <span className="flex w-full items-baseline gap-2">
          <span className="text-[15px] font-bold tracking-tight underline decoration-muted-foreground underline-offset-[3px] group-hover:decoration-foreground">
            {ticket.key}
          </span>{" "}
          {ticket.milestone && (
            <span className="rounded-full border border-border px-1.5 text-[11px] font-semibold text-muted-foreground">
              {ticket.milestone}
            </span>
          )}{" "}
          {ticket.openDecisions > 0 && (
            <span className="text-xs font-medium text-[var(--brand,var(--attention))]">
              {ticket.openDecisions} decision{ticket.openDecisions > 1 ? "s" : ""}
            </span>
          )}{" "}
          <span className="ml-auto truncate text-xs text-muted-foreground">{ticket.repo}</span>
        </span>{" "}
        <span className="text-[13.5px]">{shortTitle(ticket.title)}</span>
      </button>
      {ticket.prs.length > 0 && <PrStack prs={ticket.prs} />}
      <CardNote ticket={ticket} />
      {ticket.sharedWith.length > 0 && (
        <p className="text-xs text-muted-foreground">Same agents as {ticket.sharedWith.join(", ")}.</p>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground">
        {agents.map((agent) => {
          const p = presence(agent.id);
          return (
            <span key={agent.id} className="inline-flex items-center gap-1.5">
              <Dot presence={p} />
              <button
                type="button"
                className="cursor-pointer text-foreground hover:underline"
                onClick={() => openAgent(agent.id, `${ticket.key} ${agent.role.toLowerCase()}`)}
              >
                {agent.role}
              </button>
              {describePresence(p)}
            </span>
          );
        })}
      </div>
    </article>
  );
}

function PlanNote({ boardId, ticketKey, round }: { boardId: number; ticketKey: string; round: PlanRound }) {
  const go = useGo();
  const open = round.status === "open";
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-[12.5px]">
      <span className={open ? "text-[var(--brand,var(--attention))]" : "text-muted-foreground"}>
        {open
          ? `Plan round ${round.n} waits on you${round.marks > 0 ? `, ${round.marks} mark${round.marks > 1 ? "s" : ""} drafted` : ""}.`
          : `Changes requested on plan round ${round.n}; the agent is revising.`}
      </span>
      <button type="button" className="cursor-pointer font-medium hover:underline" onClick={() => go.plan(boardId, ticketKey, round.n)}>
        {open ? "Review plan" : "See round"}
      </button>
    </p>
  );
}

/** A plan round in Waiting on you: who sent it, when, and the way in. */
function PlanWaitingCard({ round }: { round: PlanRound }) {
  const go = useGo();
  return (
    <article className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--brand,var(--attention))] bg-card px-3 py-2 text-sm">
      <span className="font-semibold">{round.ticketKey}</span>
      <span>Plan round {round.n}</span>
      <span className="text-xs text-muted-foreground">sent {ago(round.submittedAt)}</span>
      {round.source === "inferred" && <span className="text-xs text-muted-foreground">found in the plans folder</span>}
      <Button size="sm" className="ml-auto" onClick={() => go.plan(round.boardId, round.ticketKey, round.n)}>
        Review plan
      </Button>
    </article>
  );
}

function CardNote({ ticket }: { ticket: Ticket }) {
  const review = ticket.openReview;
  if (review?.state === "with-agent") {
    return (
      <p className="text-[12.5px] text-muted-foreground">
        {review.label ? `With the agent: ${review.label}.` : "Your review comments are with the agent."}
      </p>
    );
  }
  if (review) {
    return (
      <p className="text-[12.5px]">
        <a
          className="text-[var(--brand,var(--attention))] hover:underline"
          href={`/plugins/code-review-workspace/review/${encodeURIComponent(review.targetKey)}`}
        >
          A review round is open for you.
        </a>
        {review.label && <span className="text-muted-foreground"> {review.label}</span>}
      </p>
    );
  }
  const round = ticket.planRound;
  if (round && (round.status === "open" || round.status === "changes_requested")) {
    return <PlanNote boardId={ticket.boardId} ticketKey={ticket.key} round={round} />;
  }
  const merged = ticket.prs.filter((pr) => pr.state === "merged").length;
  const pushed = ticket.prs.filter((pr) => pr.state !== "local").length;
  const parts: string[] = [];
  if (ticket.stage === "in-review" && merged > 0) parts.push(`${merged} of ${pushed} merged.`);
  if (ticket.stageNote) parts.push(ticket.stageNote);
  if (parts.length === 0) return null;
  return (
    <p className={cn("text-[12.5px] text-muted-foreground", ticket.stage === "paused" && "text-[var(--warning-text)]")}>
      {parts.join(" ")}
    </p>
  );
}

function PrStack({ prs }: { prs: PullRequest[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {prs.map((pr, i) => (
        <span key={`${pr.repo}-${pr.number ?? pr.label}-${i}`} className="inline-flex items-center gap-1">
          {i > 0 && <span aria-hidden className="h-px w-2 bg-border" />}
          {pr.url ? (
            <UrlLink href={pr.url} title={`${pr.repo} #${pr.number} (${pr.state})`}>
              <Pill state={pr.state}>{label(pr)}</Pill>
            </UrlLink>
          ) : (
            <Pill state={pr.state}>{label(pr)}</Pill>
          )}
        </span>
      ))}
    </div>
  );
}

function label(pr: PullRequest): string {
  if (pr.number === null) return pr.label ?? "local";
  return pr.state === "held" ? `#${pr.number} held` : `#${pr.number}`;
}

function Pill({ state, children }: { state: PullRequest["state"]; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-block rounded-md border-[1.5px] px-2 py-px text-xs font-semibold",
        state === "merged" &&
          "border-[var(--pr-merged)] bg-[color-mix(in_oklab,var(--pr-merged)_16%,transparent)] text-[var(--pr-merged)]",
        state === "open" && "border-[var(--success)] text-[var(--success)]",
        state === "draft" && "border-dashed border-muted-foreground text-muted-foreground",
        state === "held" && "border-dashed border-[var(--warning)] text-[var(--warning)]",
        state === "local" && "border-dotted border-muted-foreground font-medium text-muted-foreground",
        state === "closed" && "border-border text-muted-foreground line-through",
      )}
    >
      {children}
    </span>
  );
}

function Dot({ presence }: { presence: Presence }) {
  const recent = presence.updatedAt !== null && Date.now() - presence.updatedAt < 3 * 3600_000;
  return (
    <span
      className="relative inline-flex size-2 shrink-0"
      title={presence.running ? "Running" : (presence.status ?? "Unknown")}
    >
      {presence.running && (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--timeline-accent)] opacity-60 motion-reduce:animate-none" />
      )}
      <span
        className={cn(
          "relative inline-flex size-2 rounded-full bg-border",
          recent && "bg-muted-foreground",
          presence.running && "bg-[var(--timeline-accent)]",
        )}
      />
    </span>
  );
}

function describePresence(p: Presence): string {
  if (p.running) return "running";
  if (p.status === "error") return "stopped with an error";
  if (p.updatedAt === null) return "";
  return `idle, active ${ago(p.updatedAt)}`;
}
