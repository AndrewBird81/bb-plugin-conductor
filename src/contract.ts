// Shared wire types. app.tsx imports this module for types only, so the
// zod schemas stay in the server bundle.
import { defineRpcContract } from "./rpc";
import { z } from "zod";
import { boardOptionsPatchSchema, boardOptionsSchema } from "./options";

/** In pipeline order; paused sits outside it. */
export const STAGES = [
  "planning",
  "plan-review",
  "building",
  "code-review",
  "draft-pr",
  "in-review",
  "in-milestone",
  "done",
  "paused",
] as const;
export const stageSchema = z.enum(STAGES);

const STAGE_ALIASES: Record<string, Stage> = { merged: "in-milestone", "in-milestone-branch": "in-milestone" };

/** Accepts `plan_review` and older names from agents, stores the canonical stage. */
export const reportedStageSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normal = value.trim().toLowerCase().replace(/[_\s]+/g, "-");
  return STAGE_ALIASES[normal] ?? normal;
}, stageSchema);
export type Stage = z.infer<typeof stageSchema>;

export const roleSchema = z.enum(["lead", "implementer"]);
export const RUNNING_STATUSES = ["active", "starting", "pending"] as const;
export type Role = z.infer<typeof roleSchema>;

export const prStateSchema = z.enum(["draft", "open", "merged", "closed", "held", "local"]);
export type PrState = z.infer<typeof prStateSchema>;

/** A PR in a ticket's stack; `local` is work not pushed yet (no number). */
export const prSchema = z.object({
  repo: z.string().min(1).max(200),
  number: z.number().int().positive().nullable(),
  url: z.string().url().max(500).nullable(),
  label: z.string().max(80).nullable(),
  base: z.string().max(200).nullable(),
  state: prStateSchema,
});
export type PullRequest = z.infer<typeof prSchema>;

export const planRoundStatusSchema = z.enum(["open", "approved", "changes_requested", "superseded", "withdrawn"]);
export type PlanRoundStatus = z.infer<typeof planRoundStatusSchema>;

/** One submitted revision of a ticket's plan, with its outcome. */
export const planRoundSchema = z.object({
  id: z.number().int(),
  boardId: z.number().int(),
  ticketKey: z.string(),
  threadId: z.string(),
  n: z.number().int(),
  path: z.string(),
  sha256: z.string(),
  source: z.enum(["submitted", "inferred"]),
  status: planRoundStatusSchema,
  summary: z.string().nullable(),
  overallComment: z.string().nullable(),
  marks: z.number().int(),
  submittedAt: z.number(),
  decidedAt: z.number().nullable(),
  deliveredAt: z.number().nullable(),
  deliveryError: z.string().nullable(),
});
export type PlanRound = z.infer<typeof planRoundSchema>;

export const planMarkKindSchema = z.enum(["comment", "remove", "replace"]);

/** A mark on a passage of the plan: a comment, a removal or a replacement. */
export const planMarkSchema = z.object({
  id: z.number().int(),
  roundId: z.number().int(),
  kind: planMarkKindSchema,
  quote: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  comment: z.string().nullable(),
  replacement: z.string().nullable(),
  createdAt: z.number(),
});
export type PlanMark = z.infer<typeof planMarkSchema>;

export const ticketSchema = z.object({
  boardId: z.number().int(),
  key: z.string(),
  title: z.string(),
  repo: z.string().nullable(),
  projectId: z.string().nullable(),
  linearUrl: z.string().nullable(),
  linearState: z.string().nullable(),
  leadThreadId: z.string(),
  implementerThreadIds: z.array(z.string()),
  environmentId: z.string().nullable(),
  branch: z.string().nullable(),
  base: z.string().nullable(),
  milestone: z.string().nullable(),
  stage: stageSchema,
  stageSource: z.enum(["reported", "inferred"]),
  reportedStage: stageSchema.nullable(),
  stageNote: z.string().nullable(),
  /** Other tickets worked in the same lead thread. */
  sharedWith: z.array(z.string()),
  prs: z.array(prSchema),
  /** The ticket's latest plan round, if any. */
  planRound: planRoundSchema.nullable(),
  reportedAt: z.number().nullable(),
  openReview: z
    .object({
      targetKey: z.string(),
      id: z.string(),
      label: z.string().nullable(),
      state: z.enum(["needs-review", "with-agent"]),
    })
    .nullable(),
  openDecisions: z.number().int(),
  blockingDecisions: z.number().int(),
  updatedAt: z.number(),
});
export type Ticket = z.infer<typeof ticketSchema>;

export const decisionSchema = z.object({
  id: z.number().int(),
  ref: z.string(),
  boardId: z.number().int(),
  ticketKey: z.string(),
  threadId: z.string(),
  question: z.string(),
  options: z.array(
    z.object({ label: z.string(), detail: z.string().nullable() }),
  ),
  recommendation: z.string().nullable(),
  reasoning: z.string(),
  blocking: z.boolean(),
  status: z.enum(["open", "answered", "withdrawn"]),
  answer: z
    .object({ choice: z.string().nullable(), note: z.string().nullable(), at: z.number() })
    .nullable(),
  deliveredAt: z.number().nullable(),
  deliveryError: z.string().nullable(),
  createdAt: z.number(),
});
export type Decision = z.infer<typeof decisionSchema>;

export const stageEventSchema = z.object({
  /** Null for a report that only changed PRs, milestone or the note. */
  stage: stageSchema.nullable(),
  note: z.string().nullable(),
  threadId: z.string().nullable(),
  at: z.number(),
});
export type StageEvent = z.infer<typeof stageEventSchema>;

/**
 * needs-review waits on the user; with-agent waits on the agent, fixing the
 * comments they sent or pushing, or on a PR not under their login, its author;
 * idle waits on nobody (a draft, a snooze, a folder on another branch or
 * removed); approved and archived rounds are finished.
 */
export const reviewStateSchema = z.enum(["needs-review", "with-agent", "idle", "approved", "archived"]);
export type ReviewState = z.infer<typeof reviewStateSchema>;

export const reviewSchema = z.object({
  targetKey: z.string(),
  /** Its short id, as Code Review Workspace shows it: api#4512, or api:feat/x for local work. */
  id: z.string(),
  /** Code Review Workspace's own status, such as "Ready to re-review" or "2 of 6 reported". */
  label: z.string().nullable(),
  state: reviewStateSchema,
  /** Its main thread, which its comments go to; null when it has none. */
  threadId: z.string().nullable(),
  createdAt: z.number().nullable(),
  /** When it came to stand as it does: for a review with the agent, when it went to the agent. */
  since: z.number(),
});
export type Review = z.infer<typeof reviewSchema>;

export const linearIssueSchema = z.object({
  identifier: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  stateName: z.string().nullable(),
  description: z.string().nullable(),
  blocks: z.array(z.object({ identifier: z.string(), title: z.string() })),
  related: z.array(z.object({ identifier: z.string(), title: z.string() })),
});
export type LinearIssue = z.infer<typeof linearIssueSchema>;

export const ticketDetailSchema = z.object({
  ticket: ticketSchema,
  decisions: z.array(decisionSchema),
  stageEvents: z.array(stageEventSchema),
  reviews: z.array(reviewSchema),
  linear: linearIssueSchema.nullable(),
});
export type TicketDetail = z.infer<typeof ticketDetailSchema>;

export const nextPrSchema = z.object({
  ticketKey: z.string(),
  repo: z.string(),
  number: z.number().int(),
  url: z.string().nullable(),
  /** The PR in the same stack that is open for review now, if any. */
  after: z.object({ number: z.number().int(), url: z.string().nullable() }).nullable(),
});
export type NextPr = z.infer<typeof nextPrSchema>;

/** Which optional plugins this bb has; the board hides what needs a missing one. */
export const integrationsSchema = z.object({ linear: z.boolean(), codeReview: z.boolean() });
export type Integrations = z.infer<typeof integrationsSchema>;

export const boardSummarySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  orchestratorThreadId: z.string(),
  options: boardOptionsSchema,
  openDecisions: z.number().int(),
  tickets: z.number().int(),
});
export type BoardSummary = z.infer<typeof boardSummarySchema>;

export const boardSchema = z.object({
  board: boardSummarySchema,
  integrations: integrationsSchema,
  tickets: z.array(ticketSchema),
  reviewsWaiting: z.array(reviewSchema.extend({ ticketKey: z.string() })),
  plansWaiting: z.array(planRoundSchema),
  nextPr: nextPrSchema.nullable(),
  lastSweepAt: z.number().nullable(),
  sweepError: z.string().nullable(),
});
export type Board = z.infer<typeof boardSchema>;

const decisionIdInput = z.object({ id: z.number().int().positive() }).strict();
const boardIdInput = z.object({ boardId: z.number().int().positive() }).strict();

export const importSummarySchema = z.object({
  boardId: z.number().int(),
  tickets: z.number().int(),
  threads: z.number().int(),
  decisions: z.number().int(),
  stageEvents: z.number().int(),
});

export const rpcContract = defineRpcContract({
  "boards.list": {
    input: z.null(),
    output: z.object({ boards: z.array(boardSummarySchema), integrations: integrationsSchema }),
  },
  "boards.create": {
    input: z.object({ threadId: z.string().min(1), name: z.string().trim().min(1).max(80).optional() }).strict(),
    output: boardSummarySchema,
  },
  /** Spawns a new orchestrator thread in a project and makes it a board. */
  "boards.start": {
    input: z.object({ projectId: z.string().min(1), name: z.string().trim().min(1).max(80) }).strict(),
    output: boardSummarySchema,
  },
  "boards.update": {
    input: z
      .object({
        boardId: z.number().int().positive(),
        name: z.string().trim().min(1).max(80).optional(),
        orchestratorThreadId: z.string().min(1).optional(),
        options: boardOptionsPatchSchema.optional(),
      })
      .strict(),
    output: boardSummarySchema,
  },
  "boards.remove": { input: boardIdInput, output: z.object({ removed: z.boolean() }) },
  "board.list": { input: boardIdInput, output: boardSchema },
  "board.ticket": {
    input: z.object({ boardId: z.number().int().positive(), key: z.string().min(1).max(40) }).strict(),
    output: z.object({ detail: ticketDetailSchema.nullable() }),
  },
  "board.refresh": { input: boardIdInput, output: boardSchema },
  "decisions.list": {
    input: z.object({ status: z.enum(["open", "all"]), boardId: z.number().int().positive().optional() }).strict(),
    output: z.object({ decisions: z.array(decisionSchema) }),
  },
  "decisions.answer": {
    input: z
      .object({
        id: z.number().int().positive(),
        choice: z.string().trim().min(1).max(500),
        note: z.string().trim().max(4000).optional(),
      })
      .strict(),
    output: decisionSchema,
  },
  "decisions.withdraw": {
    input: z
      .object({
        id: z.number().int().positive(),
        note: z.string().trim().max(4000).optional(),
      })
      .strict(),
    output: decisionSchema,
  },
  "decisions.retryDelivery": { input: decisionIdInput, output: decisionSchema },
  /** Re-reads review rounds; the page calls it every few seconds while visible. */
  "reviews.poll": { input: z.null(), output: z.object({ changed: z.boolean() }) },
  /** Starts or opens the ticket's folder review in Code Review Workspace, from its lead thread. */
  "reviews.start": {
    input: z.object({ boardId: z.number().int().positive(), key: z.string().min(1).max(40) }).strict(),
    output: z.object({ targetKey: z.string() }),
  },
  /** Open plan rounds on every board, for the inbox and the badge. */
  "plans.waiting": { input: z.null(), output: z.object({ rounds: z.array(planRoundSchema) }) },
  "plans.list": {
    input: z.object({ boardId: z.number().int().positive(), key: z.string().min(1).max(40) }).strict(),
    output: z.object({ rounds: z.array(planRoundSchema) }),
  },
  "plans.get": {
    input: z.object({ roundId: z.number().int().positive() }).strict(),
    output: z.object({ round: planRoundSchema, content: z.string(), marks: z.array(planMarkSchema) }),
  },
  "plans.diff": {
    input: z.object({ fromRoundId: z.number().int().positive(), toRoundId: z.number().int().positive() }).strict(),
    output: z.object({ patch: z.string(), path: z.string() }),
  },
  "plans.mark.save": {
    input: z
      .object({
        roundId: z.number().int().positive(),
        id: z.number().int().positive().optional(),
        kind: planMarkKindSchema,
        quote: z.string().trim().min(1).max(4000),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
        comment: z.string().trim().max(4000).optional(),
        replacement: z.string().max(8000).optional(),
      })
      .strict(),
    output: planMarkSchema,
  },
  "plans.mark.delete": {
    input: z.object({ id: z.number().int().positive() }).strict(),
    output: z.object({ removed: z.boolean() }),
  },
  "plans.comment": {
    input: z.object({ roundId: z.number().int().positive(), comment: z.string().max(8000) }).strict(),
    output: planRoundSchema,
  },
  "plans.decide": {
    input: z
      .object({
        roundId: z.number().int().positive(),
        decision: z.enum(["approved", "changes_requested"]),
        overallComment: z.string().max(8000).optional(),
      })
      .strict(),
    output: planRoundSchema,
  },
  "plans.retryDelivery": { input: z.object({ roundId: z.number().int().positive() }).strict(), output: planRoundSchema },
  "thread.ticket": {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({
      ticket: ticketSchema.nullable(),
      role: roleSchema.nullable(),
      decisions: z.array(decisionSchema),
    }),
  },
  /** Thread ids that are boards' orchestrators, for the thread menu action. */
  "orchestrators.list": { input: z.null(), output: z.object({ boards: z.record(z.string(), z.number().int()) }) },
  /** One-time move from the Phase Board plugin this one replaces. */
  "import.phaseBoard": { input: z.null(), output: importSummarySchema },
});

/** Realtime channel; the payload is ignored and clients refetch over RPC. */
export const CHANGED = "changed";
