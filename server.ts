// Conductor backend: boards of ticket agents under orchestrator threads.
// Logic lives in src/; this file only wires registrations.
import { cliCommand, defineCli, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { NotTicketThreadError } from "./src/board";
import { Conductor } from "./src/conductor";
import {
  prStateSchema,
  reportedStageSchema,
  roleSchema,
  rpcContract,
  STAGES,
  type Decision,
  type PullRequest,
  type Ticket,
} from "./src/contract";
import { askedNotice } from "./src/decisions";
import { planPrefix } from "./src/plans";
import { agentInstructions, RULE_IDS, type BoardOptionsPatch } from "./src/options";
import { MIGRATIONS, Store } from "./src/store";

export { rpcContract };

export const ASK_TOOL = "conductor_ask_decision";
export const REPORT_TOOL = "conductor_report_stage";
export const SUBMIT_PLAN_TOOL = "conductor_submit_plan";
/** Phase Board's tool names, kept so agents started before the rename keep working until they restart. */
export const LEGACY_TOOLS = { ask: "pb_ask_decision", report: "pb_report_stage" } as const;
export const SKILL = "conductor";
export const SETUP_SKILL = "conductor-setup";

const askParameters = z.object({
  question: z.string().trim().min(1).max(2000),
  options: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(120),
        detail: z.string().trim().max(1000).optional(),
      }),
    )
    .min(2)
    .max(5)
    .refine((options) => new Set(options.map((o) => o.label)).size === options.length, "Option labels must be unique"),
  recommendation: z.string().trim().max(120).optional(),
  reasoning: z.string().trim().min(1).max(4000),
  blocking: z.boolean(),
  ticket: z.string().trim().max(40).optional(),
});

const prInput = z
  .object({
    repo: z.string().trim().min(1).max(200),
    number: z.number().int().positive().optional(),
    url: z.string().url().max(500).optional(),
    label: z.string().trim().max(80).optional(),
    base: z.string().trim().max(200).optional(),
    state: prStateSchema.default("draft"),
  })
  .refine((pr) => pr.number !== undefined || pr.state === "local", "A pushed PR needs its number")
  .refine((pr) => pr.state !== "local" || pr.label, 'Give work that is not pushed a label, e.g. "route PR"');

const reportParameters = z.object({
  ticket: z.string().trim().max(40).optional(),
  stage: reportedStageSchema.optional(),
  note: z.string().trim().max(500).optional(),
  milestone: z.string().trim().max(40).optional(),
  prs: z.array(prInput).max(12).optional(),
});

const submitPlanParameters = z.object({
  path: z.string().trim().min(1).max(1000),
  ticket: z.string().trim().max(40).optional(),
  summary: z.string().trim().max(500).optional(),
});

const metadataSchema = z.object({ boardId: z.number().int(), ticketKey: z.string(), role: roleSchema });

/** CLI flag → board option, for `bb conductor board set`. */
const OPTION_FLAGS = {
  "ticket-pattern": "ticketPattern",
  "milestone-pattern": "milestonePattern",
  "milestone-label": "milestoneLabel",
  "plans-dir": "plansDir",
  "github-owner": "githubOwner",
  "user-name": "userName",
  "extra-rules": "extraRules",
} as const;

/** Fills in a PR's URL from the board's GitHub owner when only a number is known. */
function toPullRequest(pr: z.infer<typeof prInput>, githubOwner: string): PullRequest {
  const repo = pr.repo.includes("/") || !githubOwner ? pr.repo : `${githubOwner}/${pr.repo}`;
  const url =
    pr.url ?? (pr.number !== undefined && repo.includes("/") ? `https://github.com/${repo}/pull/${pr.number}` : null);
  return {
    repo: pr.repo.replace(/^[^/]+\//, ""),
    number: pr.number ?? null,
    url,
    label: pr.label ?? null,
    base: pr.base ?? null,
    state: pr.state,
  };
}

/** `api#50:open`, `owner/web#125`, `api:local:route PR`. */
function parsePrSpec(spec: string) {
  const local = spec.match(/^([^#:]+):local:(.+)$/);
  if (local) return prInput.parse({ repo: local[1], state: "local", label: local[2] });
  const pushed = spec.match(/^([^#:]+)#(\d+)(?::([a-z]+))?$/);
  if (!pushed) {
    throw new PluginCliError(`"${spec}" is not a PR spec`, {
      code: "invalid_value",
      hint: "Use <repo>#<number>[:draft|open|merged|closed|held] or <repo>:local:<label>.",
    });
  }
  return prInput.parse({ repo: pushed[1], number: Number(pushed[2]), state: pushed[3] ?? "draft" });
}

function toolError(error: unknown) {
  return { content: [{ type: "text" as const, text: (error as Error).message }], isError: true };
}

function parseDecisionId(raw: string): number {
  const match = raw.trim().match(/^(?:D-)?(\d+)$/i);
  if (!match) {
    throw new PluginCliError(`"${raw}" is not a decision id`, {
      code: "invalid_value",
      hint: "Use the id from `bb conductor decisions`, e.g. D-7.",
    });
  }
  return Number(match[1]);
}

function formatTicket(t: Ticket): string {
  const waiting = t.openDecisions > 0 ? `  [${t.openDecisions} decision${t.openDecisions > 1 ? "s" : ""}]` : "";
  return `${t.key.padEnd(9)} ${t.stage.padEnd(12)} ${(t.repo ?? "-").padEnd(32)} ${t.title}${waiting}`;
}

function formatDecision(d: Decision): string {
  const head = `${d.ref}  ${d.ticketKey}  ${d.status}${d.blocking ? " (blocking)" : ""}  ${d.question}`;
  const options = d.options.map((o) => `    - ${o.label}${o.detail ? `: ${o.detail}` : ""}`);
  const answer = d.answer
    ? [`    answer: ${d.answer.choice ?? "(withdrawn)"}${d.answer.note ? ` — ${d.answer.note}` : ""}`]
    : [];
  return [head, ...options, ...answer].join("\n");
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new Store(db);
  const conductor = new Conductor(bb, store);

  /** The board a CLI call means: the one given, or the only one there is. */
  const boardOf = (boardId: number | undefined) => {
    const boards = store.listBoards();
    if (boardId !== undefined) {
      if (!store.getBoard(boardId)) {
        throw new PluginCliError(`No board ${boardId}`, { code: "not_found", hint: "Run `bb conductor board list`." });
      }
      return boardId;
    }
    if (boards.length === 1) return boards[0]!.id;
    throw new PluginCliError(boards.length === 0 ? "No boards yet" : "Several boards exist", {
      code: boards.length === 0 ? "no_boards" : "board_required",
      hint:
        boards.length === 0
          ? "Run `bb conductor board create --thread <orchestrator thread id>`."
          : "Pass --board <id>; `bb conductor board list` shows them.",
    });
  };
  const ownerFor = (threadId: string | null, boardId?: number) => {
    const id = threadId ? store.threadLinks(threadId)[0]?.boardId : boardId;
    return (id !== undefined ? store.getBoard(id)?.options.githubOwner : undefined) ?? "";
  };

  bb.rpc.register(rpcContract, {
    "boards.list": () => ({ boards: conductor.boards(), integrations: conductor.integrationsNow() }),
    "boards.create": ({ threadId, name }) => conductor.createBoard({ threadId, name }),
    "boards.start": ({ projectId, name }) => conductor.startBoard({ projectId, name }),
    "boards.update": ({ boardId, ...patch }) => conductor.updateBoard(boardId, patch),
    "boards.remove": ({ boardId }) => ({ removed: conductor.removeBoard(boardId) }),
    "board.list": async ({ boardId }) => {
      const engine = conductor.engine(boardId);
      await engine.refreshReviewsIfStale();
      return engine.board();
    },
    "board.ticket": async ({ boardId, key }) => ({ detail: await conductor.engine(boardId).detail(key) }),
    "board.refresh": async ({ boardId }) => {
      await conductor.refreshIntegrations();
      await conductor.engine(boardId).sweep();
      return conductor.engine(boardId).board();
    },
    "decisions.list": ({ status, boardId }) => ({ decisions: conductor.decisions(status, boardId) }),
    "decisions.answer": ({ id, choice, note }) => conductor.answer(id, choice, note || null),
    "decisions.withdraw": ({ id, note }) => conductor.withdraw(id, note || null),
    "decisions.retryDelivery": ({ id }) => conductor.retryDelivery(id),
    "reviews.poll": async () => ({ changed: await conductor.pollReviews() }),
    "reviews.start": ({ boardId, key }) => conductor.engine(boardId).startReview(key),
    "thread.ticket": ({ threadId }) => conductor.threadView(threadId),
    "orchestrators.list": () => ({ boards: conductor.orchestrators() }),
    "plans.waiting": () => ({ rounds: conductor.plansWaiting() }),
    "plans.list": ({ boardId, key }) => ({ rounds: conductor.planRounds(boardId, key) }),
    "plans.get": ({ roundId }) => conductor.planRound(roundId),
    "plans.diff": ({ fromRoundId, toRoundId }) => conductor.planDiff(fromRoundId, toRoundId),
    "plans.mark.save": (input) => conductor.saveMark(input),
    "plans.mark.delete": ({ id }) => ({ removed: conductor.deleteMark(id) }),
    "plans.comment": ({ roundId, comment }) => conductor.setPlanComment(roundId, comment),
    "plans.decide": ({ roundId, decision, overallComment }) => conductor.decidePlan(roundId, decision, overallComment),
    "plans.retryDelivery": ({ roundId }) => conductor.retryPlanDelivery(roundId),
    "import.phaseBoard": () => conductor.importPhaseBoard(),
  });

  const askTool = {
    description:
      "Ask the user a product, design or scope decision for your ticket. It appears in their Conductor inbox with your options and reasoning; the answer comes back to this thread as a message.",
    instructions:
      "Give 2-5 concrete options, your recommendation and the reasoning needed to decide without reading your thread. If this thread works on several tickets, pass ticket.",
    presentation: {
      label: { pending: "Sending a decision to the board", completed: "Sent a decision to the board" },
      icon: { glyph: "CircleQuestion" },
    },
    parameters: askParameters,
    async execute(args: z.infer<typeof askParameters>, { threadId }: { threadId: string }) {
      try {
        const { decision, userName } = await conductor.ask(threadId, {
          question: args.question,
          options: args.options.map((o) => ({ label: o.label, detail: o.detail || null })),
          recommendation: args.recommendation || null,
          reasoning: args.reasoning,
          blocking: args.blocking,
          ticket: args.ticket || null,
        });
        return askedNotice(decision, userName);
      } catch (error) {
        return toolError(error);
      }
    },
  };

  const reportTool = {
    description: `Report your ticket's stage (${STAGES.join(", ")}) and its pull requests so the Conductor board stays current. Every field is optional; send what changed.`,
    instructions:
      "Send the full PR list (bottom of the stack first) whenever it changes, each with its state (draft, open, merged, closed, held); unpushed work is state local with a label. If this thread works on several tickets, pass ticket.",
    presentation: {
      label: { pending: "Updating the board", completed: "Updated the board" },
      icon: { glyph: "Layers" },
      suppress: true,
    },
    parameters: reportParameters,
    async execute(args: z.infer<typeof reportParameters>, { threadId }: { threadId: string }) {
      try {
        const owner = ownerFor(threadId);
        const ticket = await conductor.reportStage(threadId, {
          ticket: args.ticket || null,
          stage: args.stage ?? null,
          note: args.note || null,
          milestone: args.milestone || null,
          prs: args.prs?.map((pr) => toPullRequest(pr, owner)) ?? null,
        });
        return `${ticket.key} is now "${ticket.stage}" on the board.`;
      } catch (error) {
        return toolError(error);
      }
    },
  };

  bb.agents.registerTool({
    name: SUBMIT_PLAN_TOOL,
    description:
      "Send your plan file to the user's Conductor board for review. They read it rendered, mark it up and approve it or request changes; the result comes back to this thread as a message.",
    instructions:
      "Pass the plan's absolute path. It must be a Markdown or text file in your workspace, the board's plans folder or your thread's storage folder. After changes are requested, revise the same file and submit it again.",
    presentation: {
      label: { pending: "Sending the plan for review", completed: "Sent the plan for review" },
      icon: { glyph: "FileText" },
    },
    parameters: submitPlanParameters,
    async execute(args, { threadId }) {
      try {
        const { round, userName } = await conductor.submitPlan(threadId, {
          path: args.path,
          ticket: args.ticket || null,
          summary: args.summary || null,
        });
        return `${planPrefix(round)} is with ${userName} on the Conductor board. End your turn now. The review arrives as a message that starts "${planPrefix(round)}".`;
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.registerTool({ name: ASK_TOOL, ...askTool });
  bb.agents.registerTool({ name: REPORT_TOOL, ...reportTool });
  // Never offered to new sessions (configure leaves them out); they only answer calls from older ones.
  bb.agents.registerTool({ name: LEGACY_TOOLS.ask, ...askTool, instructions: undefined });
  bb.agents.registerTool({ name: LEGACY_TOOLS.report, ...reportTool, instructions: undefined });

  bb.agents.configure((context) => {
    if (conductor.isOrchestrator(context.thread.id)) return { tools: [], skills: [SKILL, SETUP_SKILL] };
    const meta = metadataSchema.safeParse(context.pluginMetadata);
    const isSideChat = context.origin.kind === "fork";
    const board = meta.success ? store.getBoard(meta.data.boardId) : null;
    if (!meta.success || isSideChat || !board) return { tools: [], skills: [SETUP_SKILL] };
    return {
      tools: [...(board.options.rules.askDecisions ? [ASK_TOOL] : []), REPORT_TOOL, SUBMIT_PLAN_TOOL],
      skills: [SKILL],
      instructions: agentInstructions(board, { key: meta.data.ticketKey, role: meta.data.role }, { codeReview: conductor.integrationsNow().codeReview }),
    };
  });

  const boardOption = {
    board: { type: "integer" as const, min: 1, max: 1_000_000, description: "Board id (needed when there are several)" },
  };

  bb.cli.register(
    defineCli({
      name: "conductor",
      summary: "Conductor: boards of ticket agents, with a decision inbox",
      commands: {
        tickets: cliCommand({
          summary: "List a board's tickets",
          options: { ...boardOption, json: { type: "boolean", description: "Print JSON" } },
          async run({ options }) {
            const { tickets } = conductor.engine(boardOf(options.board)).board();
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(tickets) };
            return { exitCode: 0, stdout: tickets.length ? tickets.map(formatTicket).join("\n") : "No tickets." };
          },
        }),
        sweep: cliCommand({
          summary: "Find every board's ticket threads now",
          async run() {
            await conductor.sweepAll();
            const lines = conductor.boards().map((b) => `${b.id} ${b.name}: ${b.tickets} tickets`);
            return { exitCode: 0, stdout: lines.length ? lines.join("\n") : "No boards yet." };
          },
        }),
        decisions: cliCommand({
          summary: "List open decisions (or all with --all)",
          options: {
            ...boardOption,
            all: { type: "boolean", description: "Include answered and withdrawn decisions" },
            json: { type: "boolean", description: "Print JSON" },
          },
          async run({ options }) {
            const decisions = conductor.decisions(options.all ? "all" : "open", options.board);
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(decisions) };
            return { exitCode: 0, stdout: decisions.length ? decisions.map(formatDecision).join("\n") : "No decisions." };
          },
        }),
        answer: cliCommand({
          summary: "Answer a decision; the answer is sent to the agent's thread",
          positionals: [
            { name: "id", description: "Decision id, e.g. D-7", required: true },
            { name: "choice", description: "The option label or your own answer", required: true, variadic: true },
          ],
          options: { note: { type: "string", description: "Extra note for the agent (max 4000 chars)" } },
          async run({ positionals, options }) {
            const choice = (positionals.choice as string[]).join(" ");
            const decision = await conductor.answer(parseDecisionId(positionals.id as string), choice, options.note ?? null);
            const sent = decision.deliveryError ? `not delivered: ${decision.deliveryError}` : "sent to the agent";
            return { exitCode: decision.deliveryError ? 1 : 0, stdout: `${decision.ref} answered, ${sent}.` };
          },
        }),
        withdraw: cliCommand({
          summary: "Withdraw an open decision and tell the agent",
          positionals: [{ name: "id", description: "Decision id, e.g. D-7", required: true }],
          options: { note: { type: "string", description: "Why, for the agent" } },
          async run({ positionals, options }) {
            const decision = await conductor.withdraw(parseDecisionId(positionals.id as string), options.note ?? null);
            return { exitCode: 0, stdout: `${decision.ref} withdrawn.` };
          },
        }),
        report: cliCommand({
          summary: "Set a ticket's stage, PRs, milestone or note (as an agent's report would)",
          positionals: [{ name: "ticket", description: "Ticket key, e.g. ABC-123", required: true }],
          options: {
            ...boardOption,
            thread: {
              type: "string",
              description: "Thread the ticket is worked in; links it when the thread has other tickets",
            },
            stage: { type: "enum", values: [...STAGES], description: "Reported stage" },
            pr: {
              type: "string",
              repeatable: true,
              description:
                "PR in stack order: <repo>#<n>[:draft|open|merged|closed|held] or <repo>:local:<label>; replaces the list",
            },
            milestone: { type: "string", description: "Milestone label" },
            note: { type: "string", description: "One line on what changed (max 500 chars)" },
          },
          async run({ positionals, options }) {
            const thread = (options.thread as string | undefined) ?? null;
            const boardId = thread ? undefined : boardOf(options.board);
            const owner = ownerFor(thread, boardId);
            const prs = options.pr as string[] | undefined;
            const ticket = await conductor.reportStage(thread, {
              boardId,
              ticket: positionals.ticket as string,
              stage: (options.stage as (typeof STAGES)[number] | undefined) ?? null,
              note: options.note ?? null,
              milestone: options.milestone ?? null,
              prs: prs && prs.length > 0 ? prs.map((spec) => toPullRequest(parsePrSpec(spec), owner)) : null,
            });
            const prText = ticket.prs.map((pr) => (pr.number ? `#${pr.number}:${pr.state}` : `${pr.label}:local`)).join(" ");
            return {
              exitCode: 0,
              stdout: `${ticket.key} ${ticket.stage} (${ticket.stageSource}) ${ticket.milestone ?? "-"} ${prText}`,
            };
          },
        }),
        ask: cliCommand({
          summary: "Create a decision for a ticket thread (for trying the inbox)",
          options: {
            thread: { type: "string", required: true, description: "A ticket thread id (lead or implementer)" },
            question: { type: "string", required: true, description: "The question (max 2000 chars)" },
            option: { type: "string", repeatable: true, required: true, description: "An option label; give 2-5" },
            recommend: { type: "string", description: "The recommended option label" },
            reasoning: { type: "string", description: "Why (max 4000 chars)", default: "Test decision from the CLI." },
            blocking: { type: "boolean", description: "Mark it blocking" },
          },
          async run({ options }) {
            const parsed = askParameters.safeParse({
              question: options.question,
              options: (options.option as string[]).map((label) => ({ label })),
              recommendation: options.recommend,
              reasoning: options.reasoning,
              blocking: options.blocking,
            });
            if (!parsed.success) {
              throw new PluginCliError(parsed.error.issues.map((i) => i.message).join("; "), { code: "invalid_value" });
            }
            try {
              const { decision } = await conductor.ask(options.thread as string, {
                ...parsed.data,
                options: parsed.data.options.map((o) => ({ label: o.label, detail: o.detail ?? null })),
                recommendation: parsed.data.recommendation ?? null,
              });
              return { exitCode: 0, stdout: `${decision.ref} created for ${decision.ticketKey}.` };
            } catch (error) {
              if (error instanceof NotTicketThreadError) {
                throw new PluginCliError(error.message, { code: "not_ticket_thread", hint: "Run `bb conductor tickets`." });
              }
              throw error;
            }
          },
        }),
        "board list": cliCommand({
          summary: "List boards",
          options: { json: { type: "boolean", description: "Print JSON" } },
          async run({ options }) {
            const boards = conductor.boards();
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(boards) };
            const lines = boards.map(
              (b) =>
                `${b.id}  ${b.name}  orchestrator ${b.orchestratorThreadId}  ${b.tickets} tickets, ${b.openDecisions} open decisions`,
            );
            return { exitCode: 0, stdout: lines.length ? lines.join("\n") : "No boards yet." };
          },
        }),
        "board create": cliCommand({
          summary: "Make a thread the orchestrator of a new board",
          options: {
            thread: { type: "string", required: true, description: "The orchestrator thread id" },
            name: { type: "string", description: "Board name (default: the thread title)" },
          },
          async run({ options }) {
            const board = await conductor.createBoard({ threadId: options.thread as string, name: options.name });
            return { exitCode: 0, stdout: `Board ${board.id} (${board.name}) created with ${board.tickets} tickets.` };
          },
        }),
        "board remove": cliCommand({
          summary: "Remove a board with its decisions and history (threads are untouched)",
          positionals: [{ name: "id", description: "Board id", required: true }],
          async run({ positionals }) {
            const removed = conductor.removeBoard(Number(positionals.id));
            return {
              exitCode: removed ? 0 : 1,
              stdout: removed ? `Board ${positionals.id} removed.` : `No board ${positionals.id}.`,
            };
          },
        }),
        "board set": cliCommand({
          summary: "Change a board's name, options or rule switches",
          positionals: [{ name: "id", description: "Board id", required: true }],
          options: {
            name: { type: "string", description: "New board name" },
            "ticket-pattern": { type: "string", description: "Regex for ticket keys in thread titles" },
            "milestone-pattern": { type: "string", description: "Regex on the base branch; empty turns milestones off" },
            "milestone-label": { type: "string", description: "Label made from the match, e.g. M$1" },
            "plans-dir": {
              type: "string",
              description: "Folder with <date>-<key>-<slug>.md plans; empty turns the plan fallback off",
            },
            "github-owner": { type: "string", description: "Owner for PR links built from repo#n" },
            "user-name": { type: "string", description: "How agents refer to you" },
            "extra-rules": { type: "string", stdin: true, description: "Free-text agent rules (max 3000 chars)" },
            on: { type: "enum", values: [...RULE_IDS], repeatable: true, description: "Turn rule switches on" },
            off: { type: "enum", values: [...RULE_IDS], repeatable: true, description: "Turn rule switches off" },
          },
          async run({ positionals, options }) {
            const patch: BoardOptionsPatch = {
              rules: Object.fromEntries([
                ...((options.on as string[] | undefined) ?? []).map((id) => [id, true]),
                ...((options.off as string[] | undefined) ?? []).map((id) => [id, false]),
              ]),
            };
            for (const [flag, key] of Object.entries(OPTION_FLAGS)) {
              const value = (options as Record<string, unknown>)[flag];
              if (typeof value === "string") Object.assign(patch, { [key]: value });
            }
            const board = await conductor.updateBoard(Number(positionals.id), { name: options.name, options: patch });
            return { exitCode: 0, stdout: JSON.stringify(board, null, 2) };
          },
        }),
        "import-phase-board": cliCommand({
          summary: "Move the board, tickets, decisions and history from the Phase Board plugin (once)",
          async run() {
            const result = await conductor.importPhaseBoard();
            return {
              exitCode: 0,
              stdout: `Imported into board ${result.boardId}: ${result.tickets} tickets, ${result.threads} thread links, ${result.decisions} decisions, ${result.stageEvents} history entries.`,
            };
          },
        }),
      },
    }),
  );

  bb.background.schedule("sweep", "*/5 * * * *", () => conductor.sweepAll());

  bb.events.on("thread.active", ({ thread }) => void conductor.threadStatusChanged(thread.id, thread.status));
  bb.events.on("thread.idle", ({ thread }) => void conductor.threadStatusChanged(thread.id, thread.status));
  bb.events.on("thread.created", ({ thread }) => void conductor.threadCreated(thread.parentThreadId));
  // Code Review Workspace can't signal other plugins; its Sends, approvals and the agents' reports come with this activity.
  for (const event of ["thread.active", "thread.idle", "thread.failed"] as const) {
    bb.events.on(event, ({ thread }) => conductor.threadActivity(thread.id));
  }
  for (const event of ["message.queued", "message.dispatched"] as const) {
    bb.events.on(event, ({ entry }) => conductor.threadActivity(entry.threadId));
  }
  bb.onDispose(() => conductor.dispose());

  const firstSweep = setTimeout(() => void conductor.sweepAll(), 0);
  bb.onDispose(() => clearTimeout(firstSweep));
}
