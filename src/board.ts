import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
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
  type Blocker,
  type TicketArchive,
  type TicketDetail,
} from "./contract";
import { ticketBlocker, workspaceBlocker } from "./archive";
import { discoverTickets } from "./discovery";
import type { Landings } from "./github";
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
  /** Each ticket thread's workspace and archive time. */
  threads: Map<string, { environmentId: string | null; archivedAt: number | null }>;
  reviews: WaitingReview[];
}

/** Whether `text` names the ticket `key` whole: ABC-1 is not in abc-12. */
const namesKey = (text: string | null, key: string) =>
  !!text && new RegExp(`(?<![a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "i").test(text);

/**
 * How long after activity on a ticket thread the board re-reads rounds. Code
 * Review Workspace records a Send or an approval only after delivering it.
 */
export const REVIEW_SETTLE_MS = 3_000;
/** The longest steady activity on a board's threads puts that read off. */
export const REVIEW_MAX_WAIT_MS = 15_000;

const isRunning = (status: string | undefined) =>
  status !== undefined && (RUNNING_STATUSES as readonly string[]).includes(status);

/** One board: discovery, facts and stages for the threads under its orchestrator. */
export class BoardEngine {
  private sweeping: Promise<void> | null = null;
  private archiving: Promise<void> | null = null;
  private facts: Facts = { statuses: new Map(), threads: new Map(), reviews: [] };
  private reviewsReadAt = 0;
  private activityRead: ReturnType<typeof setTimeout> | null = null;
  private activityAt = 0;
  /** When the activity the next read is for began. */
  private activitySince: number | null = null;

  constructor(
    private readonly bb: BbPluginApi,
    readonly store: BoardStore,
    private readonly integrations: () => Integrations,
    /** Code Review Workspace's reviews; a read without a valid answer turns its integration off. */
    private readonly codeReviews: () => Promise<LinkedReview[]>,
    private readonly onChange: () => void,
    private readonly landings: Landings,
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
      if (this.integrations().linear) await this.refreshLinearStates(result.bound);
      await this.refreshFacts();
      this.trackDone();
      await this.tellUnblockedAgents();
      this.syncArchives();
      await this.archiveDone();
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
    const threads: Facts["threads"] = new Map();
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      for (const thread of await this.bb.sdk.threads.list({ threadIds: batch, limit: 200 })) {
        statuses.set(thread.id, thread.status);
        threads.set(thread.id, { environmentId: thread.environmentId ?? null, archivedAt: thread.archivedAt ?? null });
      }
    }
    this.facts.statuses = statuses;
    this.facts.threads = threads;
    await this.refreshReviews();
    this.withdrawFolderRounds(this.store.listTickets());
    await this.checkSubmittedPlans(this.store.listTickets());
    await this.refreshLandings(this.store.listTickets());
  }

  /** Tickets without a thread binding of their own, looked up by key in their lead's Linear scope. */
  private async refreshLinearStates(bound: Set<string>): Promise<void> {
    const byLead = new Map<string, string[]>();
    for (const t of this.store.listTickets()) {
      if (!bound.has(t.key)) byLead.set(t.leadThreadId, [...(byLead.get(t.leadThreadId) ?? []), t.key]);
    }
    for (const [lead, keys] of byLead) {
      for (let i = 0; i < keys.length; i += 24) {
        for (const issue of (await linearResolve(this.bb, keys.slice(i, i + 24), lead)).values()) {
          this.store.setLinearState(issue.identifier, issue.stateName, issue.stateType);
        }
      }
    }
  }

  /** Asks GitHub about tickets that are In milestone by their PRs. */
  private async refreshLandings(tickets: Ticket[]): Promise<void> {
    for (const ticket of tickets) {
      const stage = this.withStage(ticket).stage;
      if (stage === "in-milestone") await this.landings.refresh(ticket.prs);
    }
  }

  /**
   * Re-reads open rounds. Code Review Workspace can't signal other plugins,
   * so reads, reports, ticket thread activity and the board page coming into
   * view refresh them instead of waiting for the next sweep.
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

  /**
   * A turn started or ended on one of the board's ticket threads, or a
   * message was queued or dispatched to it: re-reads rounds once activity
   * settles, so a burst makes one read. Steady activity gets a read at least
   * every REVIEW_MAX_WAIT_MS.
   */
  threadActivity(): void {
    const now = Date.now();
    this.activityAt = now;
    this.activitySince ??= now;
    this.scheduleActivityRead();
  }

  private scheduleActivityRead(): void {
    if (this.activityRead) clearTimeout(this.activityRead);
    const at = Math.min(this.activityAt + REVIEW_SETTLE_MS, this.activitySince! + REVIEW_MAX_WAIT_MS);
    this.activityRead = setTimeout(() => void this.readAfterActivity(), at - Date.now());
  }

  private async readAfterActivity(): Promise<void> {
    this.activityRead = null;
    // A read forced by steady activity may come too soon for the latest events; they get one of their own.
    const settled = Date.now() >= this.activityAt + REVIEW_SETTLE_MS;
    this.activitySince = settled ? null : this.activityAt;
    if (!settled) this.scheduleActivityRead();
    try {
      if (await this.refreshReviews()) this.changed();
    } catch (error) {
      this.bb.log.warn(`read reviews on board ${this.boardId}: ${String(error)}`);
    }
  }

  /** Stops a pending read, as when the board is removed or the plugin unloads. */
  dispose(): void {
    if (this.activityRead) clearTimeout(this.activityRead);
    this.activityRead = null;
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
   * Plans reach the user only when the agent submits them. Rounds an older
   * version opened from the plans folder on its own are withdrawn.
   */
  private withdrawFolderRounds(tickets: Ticket[]): void {
    for (const ticket of tickets) {
      const open = this.store.planRounds(ticket.key).find((r) => r.status === "open");
      if (open?.source === "inferred") this.closeOpenRound(ticket.key, null, "found in the plans folder, never submitted");
    }
  }

  /** The newest `<date>-<key>-<slug>.md` file for the ticket in the plans folder: a draft until the agent submits it. */
  private async draftPlan(key: string): Promise<{ path: string; modifiedAt: number } | null> {
    const dir = this.config().plansDir;
    if (!dir) return null;
    try {
      const tag = `-${key.toLowerCase().replace(/-/g, "")}-`;
      const file = (await readdir(dir)).filter((name) => name.endsWith(".md") && name.includes(tag)).sort().at(-1);
      if (!file) return null;
      const path = join(dir, file);
      return { path, modifiedAt: (await stat(path)).mtimeMs };
    } catch {
      return null;
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
    // A plan sent while questions are open would be reviewed before the answers are in it.
    const open = this.store.listDecisions({ ticketKey, status: "open" });
    if (open.length > 0) {
      throw new Error(
        `${ticketKey} has open decisions (${open.map((d) => d.ref).join(", ")}). Wait for the answers, fold them into the plan, then submit it.`,
      );
    }
    const { path, content } = await this.readPlan(threadId, input.path);
    const round = this.store.openRound({
      ticketKey,
      threadId,
      path,
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
      source: "submitted",
      summary: input.summary,
    });
    this.store.reportStage({ ticketKey, threadId, stage: "plan-review", note: input.summary, prs: null, milestone: null });
    this.changed();
    return { round, ticket: this.withStage(this.store.getTicket(ticketKey)!) };
  }

  /** Reads a plan file on the agent's own machine, confined to its workspace, the plans folder or its storage. */
  private async readPlan(threadId: string, requested: string): Promise<{ path: string; content: string }> {
    const thread = await this.bb.sdk.threads.get({ threadId });
    const environmentId = (thread as { environmentId?: string | null }).environmentId ?? null;
    const environment = environmentId
      ? await this.bb.sdk.environments.get({ environmentId }).catch(() => null)
      : null;
    const storage = await this.bb.sdk.threads.storageLocation({ threadId }).catch(() => null);
    const plansDir = this.config().plansDir;
    const checked = checkPlanPath(requested, [environment?.path, storage?.storageRootPath, plansDir]);
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
    return { path: checked.path, content };
  }

  /** Notes when a submitted plan's file changed after it was sent; the round keeps the copy the user reviews. */
  private async checkSubmittedPlans(tickets: Ticket[]): Promise<void> {
    for (const ticket of tickets) {
      const round = ticket.planRound;
      if (round?.status !== "open" || round.source !== "submitted") continue;
      try {
        const { content } = await this.readPlan(round.threadId, round.path);
        const sha256 = createHash("sha256").update(content).digest("hex");
        this.store.root.setRoundFileSha(round.id, sha256 === round.sha256 ? null : sha256);
      } catch {
        // A moved or unreadable file leaves the round as it was.
      }
    }
  }

  /** Keeps agent status live between sweeps. */
  async threadStatusChanged(threadId: string, status: string): Promise<void> {
    if (this.store.threadTickets(threadId).length === 0) return;
    this.facts.statuses.set(threadId, status);
    this.changed();
  }

  /** `blockers` is filled in only at the top level, so tickets blocking each other cannot recurse. */
  private withStage(ticket: Ticket, blockers = true): Ticket {
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
      trackerDone: ticket.linearStateType === "completed",
      landed: this.landings.landed(ticket.prs),
    });
    return {
      ...ticket,
      milestone: ticket.milestone ?? milestoneFor(this.config().options, ticket.base),
      stage: decision.stage,
      stageSource: decision.source,
      archive: this.archiveView(ticket),
      blockers: blockers ? this.blockersOf(ticket) : [],
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

  private ticketThreads(ticket: Ticket): string[] {
    return [ticket.leadThreadId, ...ticket.implementerThreadIds];
  }

  /** The stored archive state, corrected by what bb says now: threads archived or unarchived by hand. */
  private archiveView(ticket: Ticket): TicketArchive | null {
    const stored = ticket.archive;
    const ids = this.ticketThreads(ticket);
    const threads = ids.map((id) => this.facts.threads.get(id));
    if (threads.some((t) => t === undefined)) return stored;
    const archivedAt = threads.map((t) => t!.archivedAt);
    const all = archivedAt.every((at) => at !== null);
    if (stored?.state === "archived" && !all) return { state: "unarchived", reason: null, threadIds: stored.threadIds, at: stored.at };
    if (all && stored?.state !== "archived") {
      return { state: "archived", reason: null, threadIds: ids, at: Math.max(...(archivedAt as number[])) };
    }
    return stored;
  }

  private blockersOf(ticket: Ticket): Blocker[] {
    if (ticket.reportedStage !== "blocked" || ticket.blockedAt === null) return [];
    const told = new Set(this.store.blockedTold(ticket.key));
    return ticket.blockedBy.map((key) => {
      const other = this.store.getTicket(key);
      if (!other) return { key, onBoard: false, stage: null, moved: null, told: told.has(key) };
      const event = this.store.latestEvent(key, ticket.blockedAt!);
      return {
        key,
        onBoard: true,
        stage: this.withStage(other, false).stage,
        moved: event ? { stage: event.stage, note: event.note, at: event.at } : null,
        told: told.has(key),
      };
    });
  }

  /** Tells a Blocked ticket's lead which tickets it waits on are Done now. */
  async tellUnblocked(key: string): Promise<Ticket> {
    const stored = this.store.getTicket(key);
    if (!stored) throw new Error(`No ticket ${key} on the board.`);
    const ticket = this.withStage(stored);
    if (ticket.stage !== "blocked") throw new Error(`${key} is not Blocked.`);
    const done = ticket.blockers.filter((b) => b.stage === "done").map((b) => b.key);
    if (done.length === 0) throw new Error(`Nothing ${key} waits on is Done yet.`);
    const waiting = ticket.blockers.filter((b) => b.stage !== "done").map((b) => b.key);
    const text =
      `[conductor] ${done.join(", ")} ${done.length === 1 ? "is" : "are"} Done.` +
      (waiting.length > 0
        ? ` ${key} still waits on ${waiting.join(", ")}.`
        : ` You can continue ${key}; report your next stage when you resume.`);
    await this.bb.sdk.threads.send({
      threadId: ticket.leadThreadId,
      mode: "auto",
      originPluginId: this.bb.pluginId,
      input: [{ type: "text", text, mentions: [] }],
    });
    this.store.setBlockedTold(key, [...new Set([...this.store.blockedTold(key), ...done])]);
    this.changed();
    return this.withStage(this.store.getTicket(key)!);
  }

  /** With the board's setting on, tells each Blocked agent once every ticket it waits on is Done. */
  private async tellUnblockedAgents(): Promise<void> {
    if (!this.store.record().options.tellBlockedAgents) return;
    for (const ticket of this.store.listTickets().map((t) => this.withStage(t))) {
      const { blockers } = ticket;
      if (ticket.stage !== "blocked" || blockers.length === 0) continue;
      if (!blockers.every((b) => b.stage === "done") || blockers.every((b) => b.told)) continue;
      await this.tellUnblocked(ticket.key).catch((error: unknown) =>
        this.bb.log.warn(`tell ${ticket.key} unblocked: ${String(error).slice(0, 300)}`),
      );
    }
  }

  /** Records when tickets become Done, with a history entry for an inferred Done. */
  private trackDone(tickets = this.store.listTickets()): void {
    for (const stored of tickets) {
      const ticket = this.withStage(stored);
      const why =
        ticket.stageSource === "reported"
          ? null
          : ticket.linearStateType === "completed"
            ? "Linear has it completed"
            : "Its PRs reached the default branch";
      this.store.setDone(ticket.key, ticket.stage === "done", why);
    }
  }

  /** Writes archiving or unarchiving done in bb by hand into Done tickets' history. */
  private syncArchives(): void {
    for (const ticket of this.store.listTickets().map((t) => this.withStage(t))) {
      const view = ticket.archive;
      const stored = this.store.archiveState(ticket.key);
      if (ticket.stage !== "done" || !view || view.state === "kept" || view.state === stored?.state) continue;
      const note = `${view.state === "archived" ? "Archived" : "Unarchived"} in bb`;
      this.store.setArchiveState(ticket.key, view.state, null, view.threadIds, note, view.state === "archived" ? view.at : undefined);
    }
  }

  /**
   * With the board's setting on, archives Done tickets whose threads are safe
   * to retire. Tickets that share a lead or a worktree go together, so one
   * that is not Done keeps the others; the reason shows on each.
   */
  private archiveDone(): Promise<void> {
    this.archiving ??= this.runArchive().finally(() => {
      this.archiving = null;
    });
    return this.archiving;
  }

  private async runArchive(): Promise<void> {
    if (!this.store.record().options.archiveDoneThreads) return;
    const tickets = this.store.listTickets().map((t) => this.withStage(t));
    const done = new Set<string>();
    for (const ticket of tickets) {
      if (done.has(ticket.key) || ticket.stage !== "done" || ticket.archive?.state === "archived" || ticket.archive?.state === "unarchived") continue;
      const group = this.archiveGroup(ticket, tickets);
      for (const t of group) done.add(t.key);
      const reason = await this.archiveBlocker(ticket, group);
      if (reason) {
        for (const t of group) {
          if (t.stage === "done" && t.archive?.state !== "archived" && t.archive?.state !== "unarchived") {
            this.store.setArchiveState(t.key, "kept", reason, []);
          }
        }
        continue;
      }
      await this.archiveThreads(group);
    }
  }

  /** The ticket plus every ticket it shares a lead or a worktree with, transitively. */
  private archiveGroup(ticket: Ticket, tickets: Ticket[]): Ticket[] {
    const envs = (t: Ticket) =>
      this.ticketThreads(t)
        .map((id) => this.facts.threads.get(id))
        .filter((f) => f && f.archivedAt === null && f.environmentId)
        .map((f) => f!.environmentId!);
    const group = [ticket];
    for (let i = 0; i < group.length; i += 1) {
      const current = group[i]!;
      const mine = new Set(envs(current));
      for (const other of tickets) {
        if (group.includes(other) || other.archive?.state === "archived") continue;
        if (other.leadThreadId === current.leadThreadId || envs(other).some((env) => mine.has(env))) group.push(other);
      }
    }
    return group;
  }

  private async archiveBlocker(ticket: Ticket, group: Ticket[]): Promise<string | null> {
    for (const other of group) {
      if (other === ticket) continue;
      const how = other.leadThreadId === ticket.leadThreadId ? "lead also works" : "workspace shared with";
      if (other.stage !== "done") return `${how} ${other.key}`;
      if (other.archive?.state === "unarchived") return `${how} ${other.key}, which was unarchived`;
    }
    const orchestrator = this.store.record().orchestratorThreadId;
    const ids = new Set(group.flatMap((t) => this.ticketThreads(t)));
    if (ids.has(orchestrator)) return "the orchestrator works this ticket";
    for (const t of group) {
      const reason = ticketBlocker(t, {
        reviewOpen: this.facts.reviews.some((r) => r.ticketKey === t.key),
        running: false,
      });
      if (reason) return group.length > 1 && t !== ticket ? `${t.key}: ${reason}` : reason;
    }
    // Fresh reads: status, and every thread on each worktree.
    const fresh = await this.bb.sdk.threads.list({ threadIds: [...ids], limit: 200 });
    if (fresh.some((t) => t.archivedAt == null && isRunning(t.status))) return "an agent is running";
    const envs = [...new Set(fresh.filter((t) => t.archivedAt == null && t.environmentId).map((t) => t.environmentId!))];
    for (const environmentId of envs) {
      const users = await this.bb.sdk.threads.list({ environmentId, limit: 200 });
      const outsider = users.find((t) => t.archivedAt == null && !ids.has(t.id));
      if (outsider) {
        const key = this.store.threadTickets(outsider.id)[0]?.ticketKey;
        const name = outsider.id === orchestrator ? "the orchestrator" : (key ?? `"${outsider.title ?? outsider.id}"`);
        return `workspace shared with ${name}`;
      }
      const prs = group.flatMap((t) => t.prs);
      const reason = await workspaceBlocker(this.bb, environmentId, (sha) => this.landings.mergedHead(prs, sha));
      if (reason) return reason;
    }
    return null;
  }

  private async archiveThreads(group: Ticket[]): Promise<void> {
    const orchestrator = this.store.record().orchestratorThreadId;
    const archived = new Set<string>();
    // A lead's archive takes its implementers with it; leads go first.
    const order = [...new Set([...group.map((t) => t.leadThreadId), ...group.flatMap((t) => t.implementerThreadIds)])];
    for (const threadId of order) {
      if (threadId === orchestrator || archived.has(threadId) || this.facts.threads.get(threadId)?.archivedAt != null) continue;
      try {
        const result = await this.bb.sdk.threads.archive({ threadId });
        for (const id of result.archivedThreadIds) archived.add(id);
        archived.add(threadId);
      } catch (error) {
        this.bb.log.warn(`archive ${threadId}: ${String(error).slice(0, 300)}`);
      }
    }
    for (const ticket of group) {
      const ids = this.ticketThreads(ticket);
      const count = ids.filter((id) => archived.has(id)).length;
      if (count === 0) continue;
      this.store.setArchiveState(ticket.key, "archived", null, ids, `Archived ${count === 1 ? "1 thread" : `${count} threads`}`);
      for (const id of ids) {
        const fact = this.facts.threads.get(id);
        if (fact && archived.has(id)) fact.archivedAt = Date.now();
      }
    }
  }

  /** Brings a ticket's threads back, rebuilding worktrees bb already removed; the board then leaves them alone. */
  async unarchive(key: string): Promise<Ticket> {
    const stored = this.store.getTicket(key);
    if (!stored) throw new Error(`No ticket ${key} on the board.`);
    const ticket = this.withStage(stored);
    const ids = ticket.archive?.threadIds.length ? ticket.archive.threadIds : this.ticketThreads(ticket);
    const orchestrator = this.store.record().orchestratorThreadId;
    let restored = 0;
    for (const threadId of ids) {
      if (threadId === orchestrator) continue;
      await this.bb.sdk.threads.unarchive({ threadId }).catch((error: unknown) => {
        this.bb.log.warn(`unarchive ${threadId}: ${String(error).slice(0, 300)}`);
      });
    }
    // One at a time: threads that shared a worktree come back on the same branch, and bb fails overlapping restores.
    for (const threadId of ids) {
      if (!(await this.restorable(threadId))) continue;
      try {
        await this.bb.sdk.threads.restoreEnvironment({ threadId });
        restored += 1;
        for (let i = 0; i < 120; i += 1) {
          const thread = (await this.bb.sdk.threads.get({ threadId }).catch(() => null)) as { status?: string } | null;
          if (thread?.status !== "starting") break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch (error) {
        this.bb.log.warn(`restore ${threadId}: ${String(error).slice(0, 300)}`);
      }
    }
    const note = `Unarchived ${ids.length === 1 ? "1 thread" : `${ids.length} threads`}${restored ? `, restored ${restored === 1 ? "1 worktree" : `${restored} worktrees`}` : ""}`;
    this.store.setArchiveState(key, "unarchived", null, ids, note);
    await this.refreshFacts();
    this.changed();
    return this.withStage(this.store.getTicket(key)!);
  }

  /**
   * Whether bb removed the thread's worktree and can rebuild it. bb sets
   * `canRestoreEnvironment` a moment after unarchiving, so a removed worktree
   * is waited on briefly.
   */
  private async restorable(threadId: string): Promise<boolean> {
    const read = async () =>
      (await this.bb.sdk.threads.get({ threadId }).catch(() => null)) as {
        environmentId?: string | null;
        canRestoreEnvironment?: boolean;
      } | null;
    let thread = await read();
    if (!thread?.environmentId) return false;
    const env = (await this.bb.sdk.environments.get({ environmentId: thread.environmentId }).catch(() => null)) as {
      status?: string;
    } | null;
    if (env?.status !== "destroyed") return false;
    for (let i = 0; i < 20 && !thread?.canRestoreEnvironment; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      thread = await read();
    }
    return thread?.canRestoreEnvironment === true;
  }

  summary(): BoardSummary {
    const board = this.store.record();
    const done = this.doneKeys();
    return {
      id: board.id,
      name: board.name,
      orchestratorThreadId: board.orchestratorThreadId,
      options: board.options,
      openDecisions: this.store.listDecisions({ status: "open" }).filter((d) => !done.has(d.ticketKey)).length,
      tickets: this.store.listTickets().length,
    };
  }

  doneKeys(): Set<string> {
    return new Set(
      this.store
        .listTickets()
        .map((t) => this.withStage(t))
        .filter((t) => t.stage === "done")
        .map((t) => t.key),
    );
  }

  board(): Board {
    const record = this.store.record();
    const tickets = this.store.listTickets().map((t) => this.withStage(t));
    const done = new Set(tickets.filter((t) => t.stage === "done").map((t) => t.key));
    return {
      board: this.summary(),
      integrations: this.integrations(),
      tickets,
      reviewsWaiting: this.waitingReviews().filter((r) => r.state === "needs-review" && !done.has(r.ticketKey)),
      plansWaiting: this.store.root.waitingRounds(this.boardId).filter((r) => !done.has(r.ticketKey)),
      nextPr: record.options.rules.onePrAtATime ? nextPrToOpen(tickets) : null,
      lastSweepAt: record.lastSweepAt,
      sweepError: record.sweepError,
    };
  }

  async detail(key: string): Promise<TicketDetail | null> {
    const stored = this.store.getTicket(key);
    if (!stored) return null;
    const issueId = this.store.linearIssueId(key);
    const [linear, reviews, draftPlan] = await Promise.all([
      issueId && this.integrations().linear ? linearIssue(this.bb, issueId) : Promise.resolve(null),
      this.codeReviews(),
      this.draftPlan(key),
    ]);
    return {
      ticket: this.withStage(stored),
      decisions: this.store.listDecisions({ ticketKey: key }),
      stageEvents: this.store.stageEvents(key),
      reviews: this.assignReviews(reviews)
        .filter((r) => r.ticketKey === key)
        .map(({ ticketKey: _, ...review }) => review),
      linear,
      // A file already sent as the open round is not a draft.
      draftPlan: draftPlan && stored.planRound?.status === "open" && stored.planRound.path === draftPlan.path ? null : draftPlan,
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
      linearStateType: linear?.stateType ?? null,
    });
    return wanted;
  }

  /**
   * A new question means the plan in review is not final, so an open round is
   * withdrawn rather than reviewed before the answer is folded in.
   */
  async ask(
    threadId: string,
    input: Omit<NewDecision, "ticketKey" | "threadId"> & { ticket?: string | null },
  ): Promise<{ decision: Decision; withdrawn: PlanRound | null }> {
    const { ticket, ...rest } = input;
    const ticketKey = await this.ticketFor(threadId, ticket ?? null);
    const decision = this.store.addDecision({ ...rest, ticketKey, threadId });
    const withdrawn = this.closeOpenRound(ticketKey, threadId, `the agent asked ${decision.ref}`);
    this.changed();
    return { decision, withdrawn };
  }

  /** Takes a plan round off the board at the agent's or the user's request; the ticket goes back to Planning. */
  async withdrawPlan(threadId: string | null, key: string | null, note: string | null): Promise<PlanRound> {
    let ticketKey: string;
    if (threadId) {
      ticketKey = await this.ticketFor(threadId, key);
    } else {
      ticketKey = (key ?? "").trim().toUpperCase();
      if (!this.store.getTicket(ticketKey)) throw new Error(`No ticket ${ticketKey} on the board.`);
    }
    const round = this.closeOpenRound(ticketKey, threadId, note);
    if (!round) throw new Error(`No plan round is open for ${ticketKey}.`);
    this.changed();
    return round;
  }

  private closeOpenRound(ticketKey: string, threadId: string | null, why: string | null): PlanRound | null {
    const open = this.store.planRounds(ticketKey).find((r) => r.status === "open");
    if (!open) return null;
    const round = this.store.root.closeRound(open.id, "withdrawn");
    this.store.reportStage({
      ticketKey,
      threadId,
      stage: "planning",
      note: `Plan round ${open.n} withdrawn${why ? `: ${why}` : ""}`,
      prs: null,
      milestone: null,
    });
    return round;
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
      blockedBy?: string[] | null;
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
    if (input.stage === "blocked" && !input.blockedBy?.length && !input.note) {
      throw new Error("Report blocked with blockedBy (the ticket keys you wait on) or a note saying what you wait on.");
    }
    const blockedBy = [...new Set((input.blockedBy ?? []).map((k) => k.trim().toUpperCase()).filter(Boolean))].slice(0, 5);
    this.store.reportStage({ ...input, blockedBy, ticketKey, threadId });
    await this.refreshReviews();
    this.trackDone([this.store.getTicket(ticketKey)!]);
    const ticket = this.store.getTicket(ticketKey)!;
    this.changed();
    if (input.stage === "done") void this.archiveDone().then(() => this.changed());
    if (input.prs?.some((pr) => pr.state === "merged")) {
      void this.refreshLandings([ticket]).then(() => this.changed());
    }
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
    if (ticket.stage === "paused" || ticket.stage === "blocked") continue;
    const draft = ticket.prs.find((pr) => pr.state === "draft" && pr.number !== null);
    if (draft) return pick(ticket, draft, null);
  }
  return null;
}
