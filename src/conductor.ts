import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { BoardEngine, NotTicketThreadError } from "./board";
import {
  CHANGED,
  type BoardSummary,
  type Decision,
  type Integrations,
  type PlanMark,
  type PlanRound,
  type PullRequest,
  type Role,
  type Stage,
  type Ticket,
} from "./contract";
import { deliver } from "./decisions";
import { applyOptionsPatch, boardOptionsSchema, DEFAULT_TICKET_PATTERN, type BoardOptionsPatch } from "./options";
import { codeReviews, type LinkedReview } from "./peers";
import { planDiff, planFeedbackMessage } from "./plans";
import type { NewDecision, Store, TableName } from "./store";

/** Plugin ids of the optional peers the board reads from. */
const PEERS = { linear: "linear" } as const;

const exportSchema = z.object({
  settings: z.record(z.string(), z.string()),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});

/** Columns of the Phase Board tables that Conductor keeps, per table. */
const IMPORT_COLUMNS: Record<TableName, string[]> = {
  tickets: [
    "key", "title", "repo", "project_id", "linear_url", "linear_issue_id", "linear_state", "lead_thread_id",
    "environment_id", "branch", "base", "reported_milestone", "reported_stage", "reported_at", "stage_note",
    "prs_json", "updated_at",
  ],
  thread_tickets: ["thread_id", "ticket_key", "role", "is_primary"],
  decisions: [
    "id", "ticket_key", "thread_id", "question", "options_json", "recommendation", "reasoning", "blocking", "status",
    "answer_choice", "answer_note", "answered_at", "delivered_at", "delivery_error", "created_at",
  ],
  stage_events: ["ticket_key", "stage", "note", "thread_id", "at"],
};

const STARTER_PROMPT = [
  "You are the orchestrator of a Conductor board.",
  "Start one child thread per ticket and put the ticket key in its title (for example `ABC-123 short summary`); the board lists those threads as tickets.",
  "Ticket agents ask decisions and report their stage through the board. Read it with `bb conductor tickets` and `bb conductor decisions`.",
  "Wait for the user to tell you which tickets to start.",
].join("\n");

/** Every board on this bb, and the routes from threads to boards. */
export class Conductor {
  private readonly engines = new Map<number, BoardEngine>();
  private integrations: Integrations = { linear: false, codeReview: false };

  constructor(
    private readonly bb: BbPluginApi,
    private readonly store: Store,
  ) {}

  integrationsNow(): Integrations {
    return this.integrations;
  }

  /**
   * Which optional plugins this bb has: Linear when it's running, read once
   * per sweep, and Code Review Workspace when it answers its review status,
   * which every read of its reviews asks again.
   */
  async refreshIntegrations(): Promise<Integrations> {
    try {
      const { plugins } = await this.bb.sdk.plugins.list();
      const running = (id: string) => plugins.some((p) => p.id === id && p.enabled && p.status === "running");
      this.integrations = { ...this.integrations, linear: running(PEERS.linear) };
    } catch (error) {
      this.bb.log.warn(`plugins.list: ${String(error)}`);
    }
    await this.codeReviews();
    return this.integrations;
  }

  /**
   * Code Review Workspace's reviews. Without a valid answer, as while it
   * starts, it counts as missing until a later read gets one.
   */
  async codeReviews(): Promise<LinkedReview[]> {
    const reviews = await codeReviews(this.bb);
    if ((reviews !== null) !== this.integrations.codeReview) {
      this.integrations = { ...this.integrations, codeReview: reviews !== null };
      this.changed();
    }
    return reviews ?? [];
  }

  engine(boardId: number): BoardEngine {
    let engine = this.engines.get(boardId);
    if (!engine) {
      if (!this.store.getBoard(boardId)) throw new Error(`No board ${boardId}.`);
      engine = new BoardEngine(
        this.bb,
        this.store.board(boardId),
        () => this.integrations,
        () => this.codeReviews(),
        () => this.changed(),
      );
      this.engines.set(boardId, engine);
    }
    return engine;
  }

  boards(): BoardSummary[] {
    return this.store.listBoards().map((board) => this.engine(board.id).summary());
  }

  async sweepAll(): Promise<void> {
    await this.refreshIntegrations();
    await Promise.all(this.store.listBoards().map((board) => this.engine(board.id).sweep()));
  }

  orchestrators(): Record<string, number> {
    return Object.fromEntries(this.store.listBoards().map((b) => [b.orchestratorThreadId, b.id]));
  }

  isOrchestrator(threadId: string): boolean {
    return this.store.boardForOrchestrator(threadId) !== null;
  }

  async createBoard(input: { threadId: string; name?: string }): Promise<BoardSummary> {
    const existing = this.store.boardForOrchestrator(input.threadId);
    if (existing) throw new Error(`Thread ${input.threadId} already runs board ${existing.id} (${existing.name}).`);
    const thread = await this.bb.sdk.threads.get({ threadId: input.threadId });
    const title = (thread as { title?: string | null }).title;
    const board = this.store.createBoard({
      name: input.name ?? title ?? `Board ${this.store.listBoards().length + 1}`,
      orchestratorThreadId: input.threadId,
      options: boardOptionsSchema.parse({}),
    });
    await this.engine(board.id).sweep();
    this.changed();
    return this.engine(board.id).summary();
  }

  /** Spawns a fresh orchestrator thread in a project and makes it a board. */
  async startBoard(input: { projectId: string; name: string }): Promise<BoardSummary> {
    const thread = await this.bb.sdk.threads.spawn({
      projectId: input.projectId,
      environment: { type: "project-default" },
      title: input.name,
      prompt: STARTER_PROMPT,
    });
    return this.createBoard({ threadId: thread.id, name: input.name });
  }

  async updateBoard(
    boardId: number,
    patch: { name?: string; orchestratorThreadId?: string; options?: BoardOptionsPatch },
  ): Promise<BoardSummary> {
    const current = this.store.getBoard(boardId);
    if (!current) throw new Error(`No board ${boardId}.`);
    this.store.updateBoard(boardId, {
      name: patch.name,
      orchestratorThreadId: patch.orchestratorThreadId,
      options: patch.options ? applyOptionsPatch(current.options, patch.options) : undefined,
    });
    await this.engine(boardId).sweep();
    this.changed();
    return this.engine(boardId).summary();
  }

  removeBoard(boardId: number): boolean {
    const removed = this.store.removeBoard(boardId);
    this.engines.delete(boardId);
    this.changed();
    return removed;
  }

  /** The board engine a ticket thread belongs to, sweeping once if it is new. */
  private async engineFor(threadId: string): Promise<BoardEngine> {
    let [link] = this.store.threadLinks(threadId);
    if (!link) {
      await this.sweepAll();
      [link] = this.store.threadLinks(threadId);
    }
    if (!link) throw new NotTicketThreadError(threadId);
    return this.engine(link.boardId);
  }

  async ask(
    threadId: string,
    input: Omit<NewDecision, "ticketKey" | "threadId"> & { ticket?: string | null },
  ): Promise<{ decision: Decision; userName: string }> {
    const engine = await this.engineFor(threadId);
    return { decision: await engine.ask(threadId, input), userName: engine.store.record().options.userName };
  }

  async reportStage(
    threadId: string | null,
    input: {
      boardId?: number;
      ticket: string | null;
      stage: Stage | null;
      note: string | null;
      prs: PullRequest[] | null;
      milestone: string | null;
    },
  ): Promise<Ticket> {
    if (threadId) return (await this.engineFor(threadId)).reportStage(threadId, input);
    const boards = this.store.listBoards();
    const boardId = input.boardId ?? (boards.length === 1 ? boards[0]!.id : undefined);
    if (boardId === undefined) throw new Error("Several boards exist; pass the board id.");
    return this.engine(boardId).reportStage(null, input);
  }

  threadView(threadId: string): { ticket: Ticket | null; role: Role | null; decisions: Decision[] } {
    const [link] = this.store.threadLinks(threadId);
    if (!link || !this.store.getBoard(link.boardId)) return { ticket: null, role: null, decisions: [] };
    return this.engine(link.boardId).threadView(threadId);
  }

  decisions(status: "open" | "all", boardId?: number): Decision[] {
    return this.store.listDecisions({ ...(status === "open" ? { status: "open" as const } : {}), boardId });
  }

  async answer(id: number, choice: string, note: string | null): Promise<Decision> {
    return this.afterSettle(id, this.store.settleDecision(id, "answered", choice, note));
  }

  async withdraw(id: number, note: string | null): Promise<Decision> {
    return this.afterSettle(id, this.store.settleDecision(id, "withdrawn", null, note));
  }

  async retryDelivery(id: number): Promise<Decision> {
    const decision = this.store.getDecision(id);
    if (!decision) throw new Error(`No decision D-${id}.`);
    if (decision.status === "open") throw new Error(`${decision.ref} is still open.`);
    if (decision.deliveredAt !== null) return decision;
    const delivered = await deliver(this.bb, this.store, decision, this.userName(decision.boardId));
    this.changed();
    return delivered;
  }

  private async afterSettle(id: number, settled: Decision | null): Promise<Decision> {
    if (!settled) {
      const existing = this.store.getDecision(id);
      throw new Error(existing ? `${existing.ref} is already ${existing.status}.` : `No decision D-${id}.`);
    }
    this.changed();
    const delivered = await deliver(this.bb, this.store, settled, this.userName(settled.boardId));
    this.changed();
    return delivered;
  }

  private userName(boardId: number): string {
    return this.store.getBoard(boardId)?.options.userName ?? "the user";
  }

  async submitPlan(
    threadId: string,
    input: { path: string; ticket: string | null; summary: string | null },
  ): Promise<{ round: PlanRound; userName: string }> {
    const engine = await this.engineFor(threadId);
    const { round } = await engine.submitPlan(threadId, input);
    return { round, userName: engine.store.record().options.userName };
  }

  plansWaiting(): PlanRound[] {
    return this.store.waitingRounds();
  }

  planRounds(boardId: number, key: string): PlanRound[] {
    return this.engine(boardId).store.planRounds(key);
  }

  planRound(roundId: number): { round: PlanRound; content: string; marks: PlanMark[] } {
    const found = this.store.getRound(roundId);
    if (!found) throw new Error(`No plan round ${roundId}.`);
    const { content, ...round } = found;
    return { round, content, marks: this.store.marks(roundId) };
  }

  planDiff(fromRoundId: number, toRoundId: number): { patch: string; path: string } {
    const from = this.store.getRound(fromRoundId);
    const to = this.store.getRound(toRoundId);
    if (!from || !to || from.boardId !== to.boardId || from.ticketKey !== to.ticketKey) {
      throw new Error("Both rounds must belong to the same ticket.");
    }
    const name = to.path.split("/").at(-1) ?? "plan.md";
    return { patch: planDiff(from.content, to.content, name), path: name };
  }

  private openRound(roundId: number) {
    const round = this.store.getRound(roundId);
    if (!round) throw new Error(`No plan round ${roundId}.`);
    if (round.status !== "open") throw new Error(`Plan round ${round.n} for ${round.ticketKey} is already ${round.status.replace("_", " ")}.`);
    return round;
  }

  saveMark(input: Omit<PlanMark, "id" | "createdAt" | "comment" | "replacement"> & {
    id?: number;
    comment?: string;
    replacement?: string;
  }): PlanMark {
    const round = this.openRound(input.roundId);
    const lines = round.content.split("\n").length;
    if (input.startLine > input.endLine || input.endLine > lines) throw new Error("The mark's lines are outside the plan.");
    if (input.kind === "replace" && input.replacement === undefined) throw new Error("A replacement needs its new text.");
    if (input.kind === "comment" && !input.comment) throw new Error("A comment needs some text.");
    if (input.id !== undefined && this.store.markRoundId(input.id) !== input.roundId) throw new Error(`No mark ${input.id} on this round.`);
    const mark = this.store.saveMark({
      ...input,
      comment: input.comment || null,
      replacement: input.kind === "replace" ? (input.replacement ?? "") : null,
    });
    this.changed();
    return mark;
  }

  deleteMark(markId: number): boolean {
    const roundId = this.store.markRoundId(markId);
    if (roundId === null) return false;
    this.openRound(roundId);
    const removed = this.store.deleteMark(markId);
    this.changed();
    return removed;
  }

  setPlanComment(roundId: number, comment: string): PlanRound {
    this.openRound(roundId);
    this.store.setOverallComment(roundId, comment.trim() || null);
    return this.planRound(roundId).round;
  }

  /** Approves (notes allowed) or requests changes, then sends the marks to the agent. */
  async decidePlan(roundId: number, decision: "approved" | "changes_requested", overallComment?: string): Promise<PlanRound> {
    const round = this.openRound(roundId);
    if (overallComment !== undefined) this.store.setOverallComment(roundId, overallComment.trim() || null);
    const overall = overallComment !== undefined ? overallComment.trim() : (round.overallComment ?? "");
    if (decision === "changes_requested" && this.store.marks(roundId).length === 0 && overall === "") {
      throw new Error("Add a mark or an overall comment to request changes.");
    }
    const closed = this.store.closeRound(roundId, decision);
    if (!closed) throw new Error(`Plan round ${round.n} was decided elsewhere.`);
    this.changed();
    const delivered = await this.deliverPlan(roundId);
    this.changed();
    return delivered;
  }

  async retryPlanDelivery(roundId: number): Promise<PlanRound> {
    const round = this.planRound(roundId).round;
    if (round.status !== "approved" && round.status !== "changes_requested") throw new Error("Only a decided round is sent.");
    if (round.deliveredAt !== null) return round;
    const delivered = await this.deliverPlan(roundId);
    this.changed();
    return delivered;
  }

  private async deliverPlan(roundId: number): Promise<PlanRound> {
    const { round, marks } = this.planRound(roundId);
    try {
      await this.bb.sdk.threads.send({
        threadId: round.threadId,
        mode: "auto",
        originPluginId: this.bb.pluginId,
        input: [{ type: "text", text: planFeedbackMessage(round, marks), mentions: [] }],
      });
      return this.store.markRoundDelivery(roundId, null);
    } catch (error) {
      this.bb.log.warn(`deliver plan round ${roundId}: ${String(error)}`);
      return this.store.markRoundDelivery(roundId, String(error).slice(0, 500));
    }
  }

  /** Re-reads review rounds on every board; tells open pages only when one moved. */
  async pollReviews(): Promise<boolean> {
    const moved = await Promise.all(this.store.listBoards().map((b) => this.engine(b.id).pollReviews()));
    const changed = moved.some(Boolean);
    if (changed) this.changed();
    return changed;
  }

  async threadStatusChanged(threadId: string, status: string): Promise<void> {
    const boards = new Set(this.store.threadLinks(threadId).map((link) => link.boardId));
    for (const boardId of boards) await this.engine(boardId).threadStatusChanged(threadId, status);
  }

  /** A new child of an orchestrator or of a ticket lead may be a ticket or an implementer. */
  async threadCreated(parentThreadId: string | null): Promise<void> {
    if (!parentThreadId) return;
    const board = this.store.boardForOrchestrator(parentThreadId);
    if (board) return this.engine(board.id).sweep();
    for (const link of this.store.threadLinks(parentThreadId)) {
      if (link.role === "lead") return this.engine(link.boardId).sweep();
    }
  }

  /**
   * The one-time move from the Phase Board plugin: its settings become a
   * board with every rule switch on (Phase Board behaved that way), and its
   * tickets, decisions and history move over unchanged.
   */
  async importPhaseBoard(): Promise<{ boardId: number; tickets: number; threads: number; decisions: number; stageEvents: number }> {
    const exported = await this.bb.sdk.plugins.callRpc({
      pluginId: "phase-board",
      method: "export.all",
      input: null,
      outputSchema: exportSchema,
    });
    const orchestratorThreadId = exported.settings.orchestratorThreadId?.trim();
    if (!orchestratorThreadId) throw new Error("Phase Board has no orchestrator thread set; there is nothing to import.");
    const existing = this.store.boardForOrchestrator(orchestratorThreadId);
    if (existing) throw new Error(`Already imported as board ${existing.id} (${existing.name}).`);

    const thread = await this.bb.sdk.threads.get({ threadId: orchestratorThreadId }).catch(() => null);
    const options = boardOptionsSchema.parse({
      ticketPattern: exported.settings.ticketPattern || DEFAULT_TICKET_PATTERN,
      milestonePattern: "^m(\\d+(?:\\.\\d+)?)-",
      milestoneLabel: "M$1",
      plansDir: exported.settings.plansDir ?? "",
      githubOwner: exported.settings.githubOwner ?? "",
      rules: Object.fromEntries(
        ["askDecisions", "reportStages", "planRounds", "onePrAtATime", "splitPrs", "oneAgentPerTicket", "codeReviewRounds"].map(
          (id) => [id, true],
        ),
      ),
    });
    const counts = this.store.transaction(() => {
      const board = this.store.createBoard({
        name: (thread as { title?: string | null } | null)?.title ?? "Imported board",
        orchestratorThreadId,
        options,
      });
      const out: Record<TableName, number> = { tickets: 0, thread_tickets: 0, decisions: 0, stage_events: 0 };
      for (const table of Object.keys(IMPORT_COLUMNS) as TableName[]) {
        const rows = (exported.tables[table] ?? []).map((row) => ({
          board_id: board.id,
          ...Object.fromEntries(IMPORT_COLUMNS[table].filter((c) => c in row).map((c) => [c, row[c]])),
        }));
        this.store.insertRows(table, rows);
        out[table] = rows.length;
      }
      return { boardId: board.id, ...out };
    });
    await this.engine(counts.boardId).sweep();
    this.changed();
    return {
      boardId: counts.boardId,
      tickets: counts.tickets,
      threads: counts.thread_tickets,
      decisions: counts.decisions,
      stageEvents: counts.stage_events,
    };
  }

  changed(): void {
    this.bb.realtime.publish(CHANGED, null);
  }
}
