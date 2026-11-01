import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  RUNNING_STATUSES,
  type Board,
  type BoardSummary,
  type Decision,
  type Integrations,
  type NextPr,
  type PlanRound,
  type PullRequest,
  type Review,
  type Role,
  type Stage,
  type Ticket,
  type TicketDetail,
} from "./contract";
import { discoverTickets } from "./discovery";
import { compileRegex, DEFAULT_TICKET_PATTERN, milestoneFor, type BoardOptions } from "./options";
import { linearIssue, linearResolve, startCodeReview, type LinkedReview } from "./peers";
import { checkPlanPath, PLAN_MAX_BYTES } from "./plans";
import { decideStage } from "./stages";
import type { BoardStore, NewDecision } from "./store";

export class NotTicketThreadError extends Error {
  constructor(threadId: string) {
    super(
      `Thread ${threadId} is not a ticket thread on a Conductor board. Only the ticket agents under a board's orchestrator, and their implementers, can use this tool; ask in your reply instead.`,
    );
  }
}

interface EngineConfig {
  orchestratorThreadId: string;
  ticketPattern: RegExp;
  /** Server-local folder holding `<date>-<key>-<slug>.md` plan files. */
  plansDir: string | null;
  options: BoardOptions;
}

type WaitingReview = Review & { ticketKey: string };

/** Facts gathered from bb and other plugins; refreshed by sweeps and thread events. */
interface Facts {
  statuses: Map<string, string>;
  reviews: WaitingReview[];
}

/** Reported stages (or none) in which a plan can still be waiting for review. */
const PLANNING_STAGES = new Set<Stage | null>([null, "planning", "plan-review"]);

/** Whether `text` names the ticket `key` whole: ABC-1 is not in abc-12. */
const namesKey = (text: string | null, key: string) =>
  !!text && new RegExp(`(?<![a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "i").test(text);

const isRunning = (status: string | undefined) =>
  status !== undefined && (RUNNING_STATUSES as readonly string[]).includes(status);

/** One board: discovery, facts and stages for the threads under its orchestrator. */
export class BoardEngine {
  private sweeping: Promise<void> | null = null;
  private facts: Facts = { statuses: new Map(), reviews: [] };
  private reviewsReadAt = 0;

  constructor(
    private readonly bb: BbPluginApi,
    readonly store: BoardStore,
    private readonly integrations: () => Integrations,
    /** Code Review Workspace's reviews; a read without a valid answer turns its integration off. */
    private readonly codeReviews: () => Promise<LinkedReview[]>,
    private readonly onChange: () => void,
  ) {}

  get boardId(): number {
    return this.store.boardId;
  }

  private config(): EngineConfig {
    const board = this.store.record();
    return {
      orchestratorThreadId: board.orchestratorThreadId,
      ticketPattern: compileRegex(board.options.ticketPattern, DEFAULT_TICKET_PATTERN),
      plansDir: board.options.plansDir.trim() || null,
      options: board.options,
    };
  }

  /** Runs one discovery and facts sweep; concurrent callers share it. */
  sweep(): Promise<void> {
    this.sweeping ??= this.runSweep().finally(() => {
      this.sweeping = null;
    });
    return this.sweeping;
  }

  private async runSweep(): Promise<void> {
    const { orchestratorThreadId, ticketPattern } = this.config();
    const root = this.store.root;
    try {
      const result = await discoverTickets(this.bb, this.store, orchestratorThreadId, ticketPattern, {
        linear: this.integrations().linear,
      });
      await this.refreshFacts();
      root.setSweep(this.boardId, result.warning);
    } catch (error) {
      this.bb.log.warn(`sweep board ${this.boardId}: ${String(error)}`);
      root.setSweep(this.boardId, String(error).slice(0, 500));
    }
    this.changed();
  }

  private ticketThreadIds(): string[] {
    const ids = new Set<string>();
    for (const t of this.store.listTickets()) {
      ids.add(t.leadThreadId);
      for (const id of t.implementerThreadIds) ids.add(id);
    }
    return [...ids];
  }

  private async refreshFacts(): Promise<void> {
    const ids = this.ticketThreadIds();
    const statuses = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      for (const thread of await this.bb.sdk.threads.list({ threadIds: batch, limit: 200 })) {
        statuses.set(thread.id, thread.status);
      }
    }
    this.facts.statuses = statuses;
    await this.refreshReviews();
    await this.inferPlanRounds(this.store.listTickets());
  }

  /**
   * Re-reads open rounds. Code Review Workspace sends no change signal, so
   * reads and reports refresh them instead of waiting for the next sweep.
   */
  private async refreshReviews(): Promise<boolean> {
    const reviews = await this.codeReviews();
    // Archived or approved rounds no longer wait on the user.
    const before = this.reviewKey();
    this.facts.reviews = this.assignReviews(
      reviews.filter((r) => r.state === "needs-review" || r.state === "with-agent"),
    );
    this.reviewsReadAt = Date.now();
    return this.reviewKey() !== before;
  }

  private reviewKey(): string {
    return this.facts.reviews.map((r) => `${r.targetKey}:${r.state}:${r.ticketKey}:${r.label}`).sort().join(",");
  }

  /** Re-reads rounds now; true when one moved. */
  async pollReviews(): Promise<boolean> {
    return this.refreshReviews();
  }

  /** Called before serving the board; cheap because the reviews are local. */
  async refreshReviewsIfStale(maxAgeMs = 30_000): Promise<void> {
    if (Date.now() - this.reviewsReadAt > maxAgeMs) await this.refreshReviews();
  }

  /** Rounds waiting on the user or the agent; none while Code Review Workspace counts as missing. */
  private waitingReviews(): WaitingReview[] {
    return this.integrations().codeReview ? this.facts.reviews : [];
  }

  /**
   * Assigns each review to one ticket, from its threads' tickets when it has
   * any, else the tickets whose checkout is its folder, on their branch or one
   * naming them; leads sharing a checkout share its branch, so of several there
   * only the ones its branch names. Of several, the ticket its branch names,
   * then the one on its branch, then the first.
   */
  private assignReviews(reviews: LinkedReview[]): WaitingReview[] {
    const tickets = this.store.listTickets();
    return reviews.flatMap(({ threadIds, environmentId, branch, ...review }) => {
      const linked = threadIds
        .flatMap((id) => this.store.threadTickets(id))
        .flatMap((link) => tickets.filter((t) => t.key === link.ticketKey));
      const inFolder = tickets.filter(
        (t) =>
          environmentId &&
          t.environmentId === environmentId &&
          ((branch && t.branch === branch) || namesKey(branch, t.key)),
      );
      const fromFolder = inFolder.length > 1 ? inFolder.filter((t) => namesKey(branch, t.key)) : inFolder;
      const candidates = linked.length > 0 ? linked : fromFolder;
      if (candidates.length === 0) return [];
      // A PR's branch is its head, so a stacked PR goes by its own branch, not the base naming the ticket below.
      const ticket =
        candidates.find((t) => namesKey(branch, t.key)) ??
        candidates.find((t) => branch && t.branch === branch) ??
        candidates[0]!;
      return [{ ...review, ticketKey: ticket.key }];
    });
  }

  /**
   * The plans-folder fallback for agents that do not submit their plan: a
   * `<date>-<key>-<slug>.md` file, no PRs and no commits past the base, and
   * the lead idle opens a round from the file. A changed file opens the next
   * round; a reply in the lead thread closes an open inferred round, since the
   * user answered there instead.
   */
  private async inferPlanRounds(tickets: Ticket[]): Promise<void> {
    const dir = this.config().plansDir;
    if (!dir) return;
    let files: string[];
    try {
      files = (await readdir(dir)).filter((name) => name.endsWith(".md"));
    } catch {
      return;
    }
    for (const ticket of tickets) {
      const latest = this.store.planRounds(ticket.key)[0] ?? null;
      // Only a ticket still planning can be waiting on a plan; a stale inferred round closes.
      const planning = ticket.prs.length === 0 && PLANNING_STAGES.has(ticket.reportedStage);
      if (!planning) {
        if (latest?.status === "open" && latest.source === "inferred") this.store.root.closeRound(latest.id, "withdrawn");
        continue;
      }
      const tag = `-${ticket.key.toLowerCase().replace(/-/g, "")}-`;
      const file = files.filter((name) => name.includes(tag)).sort().at(-1);
      if (!file) continue;
      try {
        if (latest?.status === "open" && latest.source === "inferred") {
          const repliedAt = await this.lastReplyAt(ticket.leadThreadId);
          if (repliedAt !== null && repliedAt > latest.submittedAt) this.store.root.closeRound(latest.id, "withdrawn");
        }
        if (isRunning(this.facts.statuses.get(ticket.leadThreadId))) continue;
        const content = await readFile(join(dir, file), "utf8");
        const sha256 = createHash("sha256").update(content).digest("hex");
        if (latest?.sha256 === sha256) continue;
        if (!(await this.noCommits(ticket.environmentId))) continue;
        this.store.openRound({
          ticketKey: ticket.key,
          threadId: ticket.leadThreadId,
          path: join(dir, file),
          content,
          sha256,
          source: "inferred",
          summary: null,
        });
      } catch (error) {
        this.bb.log.warn(`plan round ${ticket.key}: ${String(error)}`);
      }
    }
  }

  /**
   * Opens a plan round from a file the agent names. The file must be in the
   * agent's workspace, the board's plans folder or the thread's storage; it is
   * read on the agent's own machine, confined to that folder.
   */
  async submitPlan(
    threadId: string,
    input: { path: string; ticket: string | null; summary: string | null },
  ): Promise<{ round: PlanRound; ticket: Ticket }> {
    const ticketKey = await this.ticketFor(threadId, input.ticket);
    const thread = await this.bb.sdk.threads.get({ threadId });
    const environmentId = (thread as { environmentId?: string | null }).environmentId ?? null;
    const environment = environmentId
      ? await this.bb.sdk.environments.get({ environmentId }).catch(() => null)
      : null;
    const storage = await this.bb.sdk.threads.storageLocation({ threadId }).catch(() => null);
    const plansDir = this.config().plansDir;
    const checked = checkPlanPath(input.path, [environment?.path, storage?.storageRootPath, plansDir]);
    if (!checked.ok) throw new Error(checked.reason);
    const hostId =
      checked.root === plansDir
        ? undefined
        : checked.root === storage?.storageRootPath
          ? storage.hostId
          : (environment?.hostId ?? undefined);
    const file = await this.bb.sdk.files.read({ path: checked.path, rootPath: checked.root, hostId });
    const { content: raw, contentEncoding, sizeBytes } = file as { content: string; contentEncoding?: string; sizeBytes?: number };
    if ((sizeBytes ?? raw.length) > PLAN_MAX_BYTES) throw new Error("The plan is larger than 1 MB.");
    const content = contentEncoding === "base64" ? Buffer.from(raw, "base64").toString("utf8") : raw;
    const round = this.store.openRound({
      ticketKey,
      threadId,
      path: checked.path,
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
      source: "submitted",
      summary: input.summary,
    });
    this.store.reportStage({ ticketKey, threadId, stage: "plan-review", note: input.summary, prs: null, milestone: null });
    this.changed();
    return { round, ticket: this.withStage(this.store.getTicket(ticketKey)!) };
  }

  private async lastReplyAt(threadId: string): Promise<number | null> {
    const orchestrator = this.config().orchestratorThreadId;
    const events = await this.bb.sdk.threads.events.list({
      threadId,
      order: "desc",
      limit: "50",
      types: ["client/turn/requested"] as never,
    });
    for (const event of events) {
      const data = (event.data ?? {}) as { initiator?: string; senderThreadId?: string | null; source?: string };
      const fromUser = data.initiator === "user" && !data.senderThreadId && data.source !== "spawn";
      if (fromUser || data.senderThreadId === orchestrator) return event.createdAt;
    }
    return null;
  }

  private async noCommits(environmentId: string | null): Promise<boolean> {
    if (!environmentId) return true;
    try {
      const status = (await this.bb.sdk.environments.status({ environmentId })) as {
        mergeBase?: { aheadCount?: number } | null;
      };
      return (status.mergeBase?.aheadCount ?? 0) === 0;
    } catch {
      return true;
    }
  }

  /** Keeps agent status live between sweeps. */
  async threadStatusChanged(threadId: string, status: string): Promise<void> {
    if (this.store.threadTickets(threadId).length === 0) return;
    this.facts.statuses.set(threadId, status);
    if (!isRunning(status)) {
      const leading = this.store.listTickets().filter((t) => t.leadThreadId === threadId);
      if (leading.length > 0) await this.inferPlanRounds(leading);
    }
    this.changed();
  }

  private withStage(ticket: Ticket): Ticket {
    const plan = ticket.planRound;
    const planRound = plan && ["open", "approved", "changes_requested"].includes(plan.status) ? plan.status : null;
    // A round waiting on the user outranks one already with the agent.
    const rounds = this.waitingReviews().filter((r) => r.ticketKey === ticket.key);
    const review = rounds.find((r) => r.state === "needs-review") ?? rounds[0] ?? null;
    const running = [ticket.leadThreadId, ...ticket.implementerThreadIds].some((id) =>
      isRunning(this.facts.statuses.get(id)),
    );
    const decision = decideStage({
      reported: ticket.reportedStage,
      prs: ticket.prs,
      reviewRound: review ? (review.state as "needs-review" | "with-agent") : null,
      reportedAfterReview: (ticket.reportedAt ?? 0) > (review?.since ?? Infinity),
      planRound: planRound as "open" | "approved" | "changes_requested" | null,
      agentRunning: running,
    });
    return {
      ...ticket,
      milestone: ticket.milestone ?? milestoneFor(this.config().options, ticket.base),
      stage: decision.stage,
      stageSource: decision.source,
      openReview: review
        ? {
            targetKey: review.targetKey,
            id: review.id,
            label: review.label,
            state: review.state as "needs-review" | "with-agent",
          }
        : null,
    };
  }

  summary(): BoardSummary {
    const board = this.store.record();
    return {
      id: board.id,
      name: board.name,
      orchestratorThreadId: board.orchestratorThreadId,
      options: board.options,
      openDecisions: this.store.listDecisions({ status: "open" }).length,
      tickets: this.store.listTickets().length,
    };
  }

  board(): Board {
    const record = this.store.record();
    const tickets = this.store.listTickets().map((t) => this.withStage(t));
    return {
      board: this.summary(),
      integrations: this.integrations(),
      tickets,
      reviewsWaiting: this.waitingReviews().filter((r) => r.state === "needs-review"),
      plansWaiting: this.store.root.waitingRounds(this.boardId),
      nextPr: record.options.rules.onePrAtATime ? nextPrToOpen(tickets) : null,
      lastSweepAt: record.lastSweepAt,
      sweepError: record.sweepError,
    };
  }

  async detail(key: string): Promise<TicketDetail | null> {
    const stored = this.store.getTicket(key);
    if (!stored) return null;
    const issueId = this.store.linearIssueId(key);
    const [linear, reviews] = await Promise.all([
      issueId && this.integrations().linear ? linearIssue(this.bb, issueId) : Promise.resolve(null),
      this.codeReviews(),
    ]);
    return {
      ticket: this.withStage(stored),
      decisions: this.store.listDecisions({ ticketKey: key }),
      stageEvents: this.store.stageEvents(key),
      reviews: this.assignReviews(reviews)
        .filter((r) => r.ticketKey === key)
        .map(({ ticketKey: _, ...review }) => review),
      linear,
    };
  }

  /**
   * Starts or opens the review of the ticket's folder in Code Review Workspace,
   * as `bb review` in its lead thread would, then re-reads the reviews.
   */
  async startReview(key: string): Promise<{ targetKey: string }> {
    if (!this.integrations().codeReview) throw new Error("Code Review Workspace 1.10 or newer is not running.");
    const ticket = this.store.getTicket(key);
    if (!ticket) throw new Error(`No ticket ${key} on the board.`);
    if (!ticket.environmentId) throw new Error(`${key}'s lead thread has no folder to review.`);
    const targetKey = await startCodeReview(this.bb, ticket.leadThreadId);
    await this.refreshReviews();
    this.changed();
    return { targetKey };
  }

  threadView(threadId: string): { ticket: Ticket | null; role: Role | null; decisions: Decision[] } {
    const [link] = this.store.threadTickets(threadId);
    if (!link) return { ticket: null, role: null, decisions: [] };
    const ticket = this.store.getTicket(link.ticketKey);
    return {
      ticket: ticket ? this.withStage(ticket) : null,
      role: link.role,
      decisions: this.store.listDecisions({ ticketKey: link.ticketKey }),
    };
  }

  /**
   * The ticket a call is about: the named one (linking it to the thread when
   * the thread works on several tickets), else the thread's own ticket.
   */
  private async ticketFor(threadId: string, key: string | null): Promise<string> {
    let links = this.store.threadTickets(threadId);
    if (links.length === 0) {
      await this.sweep();
      links = this.store.threadTickets(threadId);
    }
    if (links.length === 0) throw new NotTicketThreadError(threadId);
    if (!key) return links[0]!.ticketKey;
    const wanted = key.trim().toUpperCase();
    if (links.some((link) => link.ticketKey === wanted)) return wanted;
    if (!this.config().ticketPattern.test(wanted)) {
      throw new Error(`"${key}" does not look like a ticket key.`);
    }
    const linear = this.integrations().linear
      ? (await linearResolve(this.bb, [wanted], threadId)).get(wanted)
      : undefined;
    this.store.linkTicket({
      key: wanted,
      threadId,
      title: linear?.title ?? null,
      linearUrl: linear?.url ?? null,
      linearIssueId: linear?.issueId || null,
      linearState: linear?.stateName ?? null,
    });
    return wanted;
  }

  async ask(
    threadId: string,
    input: Omit<NewDecision, "ticketKey" | "threadId"> & { ticket?: string | null },
  ): Promise<Decision> {
    const { ticket, ...rest } = input;
    const ticketKey = await this.ticketFor(threadId, ticket ?? null);
    const decision = this.store.addDecision({ ...rest, ticketKey, threadId });
    this.changed();
    return decision;
  }

  /** From an agent's thread, or from the CLI with `threadId` null for a known ticket. */
  async reportStage(
    threadId: string | null,
    input: {
      ticket: string | null;
      stage: Stage | null;
      note: string | null;
      prs: PullRequest[] | null;
      milestone: string | null;
    },
  ): Promise<Ticket> {
    let ticketKey: string;
    if (threadId) {
      ticketKey = await this.ticketFor(threadId, input.ticket);
    } else {
      ticketKey = (input.ticket ?? "").trim().toUpperCase();
      if (!this.store.getTicket(ticketKey)) {
        throw new Error(`No ticket ${ticketKey} on the board; pass the thread it is worked in.`);
      }
    }
    this.store.reportStage({ ...input, ticketKey, threadId });
    await this.refreshReviews();
    const ticket = this.store.getTicket(ticketKey)!;
    this.changed();
    return this.withStage(ticket);
  }

  private changed(): void {
    this.onChange();
  }
}

/**
 * One PR open for review at a time: after a PR that is open for review, the next
 * draft in the same stack; with none open, the first draft on the board.
 */
export function nextPrToOpen(tickets: Ticket[]): NextPr | null {
  const ordered = [...tickets].sort(
    (a, b) => (a.milestone ?? "~").localeCompare(b.milestone ?? "~") || a.key.localeCompare(b.key),
  );
  const pick = (ticket: Ticket, pr: PullRequest, after: PullRequest | null): NextPr => ({
    ticketKey: ticket.key,
    repo: pr.repo,
    number: pr.number!,
    url: pr.url,
    after: after ? { number: after.number!, url: after.url } : null,
  });
  for (const ticket of ordered) {
    const open = ticket.prs.findIndex((pr) => pr.state === "open" && pr.number !== null);
    if (open < 0) continue;
    const next = ticket.prs.slice(open + 1).find((pr) => pr.state === "draft" && pr.number !== null);
    if (next) return pick(ticket, next, ticket.prs[open]!);
  }
  if (tickets.some((t) => t.prs.some((pr) => pr.state === "open"))) return null;
  for (const ticket of ordered) {
    if (ticket.stage === "paused") continue;
    const draft = ticket.prs.find((pr) => pr.state === "draft" && pr.number !== null);
    if (draft) return pick(ticket, draft, null);
  }
  return null;
}
