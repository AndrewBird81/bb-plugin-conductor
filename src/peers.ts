// Reads from other installed plugins over their RPC. Neither contract is
// published, so parse only the fields we use and treat any failure as
// "no data" rather than failing the board.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { LinearIssue, Review, ReviewState } from "./contract";

export interface LinearBinding {
  issueId: string;
  identifier: string;
  title: string;
  stateName: string | null;
  url: string | null;
}

const bindingsSchema = z.object({
  threads: z.record(
    z.string(),
    z.object({
      binding: z
        .object({
          issueId: z.string(),
          identifier: z.string(),
          title: z.string(),
          stateName: z.string().nullable().catch(null),
          url: z.string().nullable().catch(null),
        })
        .nullable()
        .catch(null),
    }),
  ),
});

// The linear plugin caps one call; it leaves out ids past its cap.
const LINEAR_BATCH = 100;

export async function linearBindings(
  bb: BbPluginApi,
  threadIds: string[],
): Promise<Map<string, LinearBinding>> {
  const out = new Map<string, LinearBinding>();
  for (let i = 0; i < threadIds.length; i += LINEAR_BATCH) {
    const batch = threadIds.slice(i, i + LINEAR_BATCH);
    const result = await bb.sdk.plugins.callRpc({
      pluginId: "linear",
      method: "threadIssues",
      input: { threadIds: batch },
      outputSchema: bindingsSchema,
    });
    for (const [threadId, row] of Object.entries(result.threads)) {
      if (row.binding) out.set(threadId, row.binding);
    }
  }
  return out;
}

const relationSchema = z
  .array(z.object({ identifier: z.string(), title: z.string() }))
  .catch([]);

const issueSchema = z.object({
  result: z.object({
    detail: z
      .object({
        identifier: z.string(),
        title: z.string(),
        url: z.string().nullable().catch(null),
        stateName: z.string().nullable().catch(null),
        description: z.string().nullable().catch(null),
        relations: z
          .object({ blocks: relationSchema, related: relationSchema })
          .catch({ blocks: [], related: [] }),
      })
      .nullable()
      .catch(null),
  }),
});

export async function linearIssue(
  bb: BbPluginApi,
  issueId: string,
): Promise<LinearIssue | null> {
  try {
    const { result } = await bb.sdk.plugins.callRpc({
      pluginId: "linear",
      method: "issue",
      input: { id: issueId },
      outputSchema: issueSchema,
    });
    const detail = result.detail;
    if (!detail) return null;
    return {
      identifier: detail.identifier,
      title: detail.title,
      url: detail.url,
      stateName: detail.stateName,
      description: detail.description,
      blocks: detail.relations.blocks.map(({ identifier, title }) => ({ identifier, title })),
      related: detail.relations.related.map(({ identifier, title }) => ({ identifier, title })),
    };
  } catch (error) {
    bb.log.warn(`linear issue ${issueId}: ${String(error)}`);
    return null;
  }
}

const atSchema = z.object({ at: z.number() }).nullable().optional().catch(null);
const threadRefs = z
  .array(z.object({ threadId: z.string().nullable().catch(null) }).nullable().catch(null))
  .optional()
  .catch([]);
/** Sends, with whether each came back ready or its thread stopped before that. */
const sendRefs = z
  .array(
    z
      .object({
        threadId: z.string().nullable().catch(null),
        at: z.number().nullable().catch(null),
        readyAt: z.number().nullable().optional().catch(null),
        stopped: z.object({ why: z.string().nullable().catch(null) }).nullable().optional().catch(null),
      })
      .nullable()
      .catch(null),
  )
  .optional()
  .catch([]);

/** A Code Review Workspace (1.8+) `listReviews` row, as far as the board reads it. */
const reviewSchema = z.object({
  targetKey: z.string(),
  kind: z.string().nullable().optional().catch(null),
  gitRef: z.string().nullable().optional().catch(null),
  createdAt: z.number().nullable().optional().catch(null),
  status: z.string().nullable().optional().catch(null),
  archivedAt: z.number().nullable().optional().catch(null),
  userArchivedAt: z.number().nullable().optional().catch(null),
  mergedInto: z.string().nullable().optional().catch(null),
  ownPr: z.boolean().nullable().optional().catch(null),
  sourceThreadId: z.string().nullable().optional().catch(null),
  mainThread: z.object({ threadId: z.string() }).nullable().optional().catch(null),
  implementers: threadRefs,
  sends: sendRefs,
  fixes: z.object({ sent: z.number(), reported: z.number() }).nullable().optional().catch(null),
  feature: z
    .object({
      environmentId: z.string().nullable().catch(null),
      branch: z.string().nullable().catch(null),
      changedFiles: z.number().nullable().optional().catch(null),
    })
    .nullable()
    .optional()
    .catch(null),
  push: z.object({ state: z.string(), at: z.number().nullable().catch(null) }).nullable().optional().catch(null),
  approvalSent: atSchema,
  sent: atSchema,
  turn: z
    .object({
      group: z.string().nullable().catch(null),
      reason: z.string().nullable().catch(null),
      label: z.string().nullable().catch(null),
      at: z.number().nullable().optional().catch(null),
    })
    .nullable()
    .optional()
    .catch(null),
});
type ReviewRow = z.infer<typeof reviewSchema>;

/** When the user last sent comments to the review's thread. */
const lastSendAt = (review: ReviewRow) =>
  Math.max(review.sent?.at ?? 0, ...(review.sends ?? []).map((send) => send?.at ?? 0));

/**
 * A local review or own PR the user approved in its thread, after the last
 * Send, until its folder moves past it or a later turn needs them again;
 * GitHub never records that, so the turn doesn't show it.
 */
const approvedInThread = (review: ReviewRow) =>
  (review.kind === "ref" || review.ownPr === true) &&
  review.approvalSent != null &&
  review.approvalSent.at >= lastSendAt(review) &&
  !(review.turn?.group === "needs" && (review.turn.at ?? 0) > review.approvalSent.at) &&
  // Rows carry no revision, so a later round on the same folder otherwise shows once the agent reports its stage.
  !((review.feature?.changedFiles ?? 0) > 0) &&
  review.status !== "generating";

/**
 * Comments a PR review's last Send has out unreported, its thread neither done
 * nor archived or deleted, as Code Review Workspace's `fixesState` reads them,
 * with no turn for the user since; its turn says so only for local reviews.
 */
function fixesOut(review: ReviewRow): boolean {
  const send = review.sends?.at(-1);
  const gone = send?.stopped?.why === "archived" || send?.stopped?.why === "deleted";
  const yoursSince = review.turn?.group === "needs" && (review.turn.at ?? 0) > (send?.at ?? 0);
  return (
    review.kind === "pr" &&
    !!send &&
    send.readyAt == null &&
    !gone &&
    !yoursSince &&
    !!review.fixes &&
    review.fixes.reported < review.fixes.sent
  );
}

/** A PR the user reviewed on GitHub that isn't their own, waiting on its author: the ticket agent. */
const waitingOnAuthor = (review: ReviewRow) => review.turn?.reason === "waiting" && review.ownPr !== true;

/** A Push the main thread is committing or pushing. */
const pushing = (review: ReviewRow) => review.push?.state === "committing" || review.push?.state === "pushing";

/** What the review shows: a Push under way, an approval in its thread or comments out, else its turn's label. */
function reviewLabel(review: ReviewRow): string | null {
  if (review.push?.state === "committing") return "Committing for Push";
  if (review.push?.state === "pushing") return "Pushing";
  if (approvedInThread(review)) return "Approved";
  // An own PR's turn doesn't count comments out; this is Code Review Workspace's wording when a local one does.
  const fixes = review.fixes;
  if (fixes && fixesOut(review) && review.turn?.reason !== "fixes-sent") return `${fixes.reported} of ${fixes.sent} reported`;
  return review.turn?.label ?? null;
}

/** Where a review stands for the user, from Code Review Workspace's live turn. */
export function reviewState(review: ReviewRow): ReviewState {
  const turn = review.turn;
  if (turn?.group === "archive" || review.archivedAt != null || review.userArchivedAt != null) return "archived";
  // Its folder removed, nothing on it is left to do, so the ticket moves on.
  if (turn?.reason === "folder-gone") return "idle";
  if (pushing(review)) return "with-agent";
  if (turn?.reason === "approved" || approvedInThread(review)) return "approved";
  if (turn?.reason === "fixes-sent" || fixesOut(review) || waitingOnAuthor(review)) return "with-agent";
  if (turn?.group === "needs") return "needs-review";
  return "idle";
}

/** A review with what ties it to tickets: its threads and its folder. */
export type LinkedReview = Review & { threadIds: string[]; environmentId: string | null; branch: string | null };

/** The review's main thread, the ones before it, its Sends' threads and the thread that opened it. */
function linkedThreads(review: ReviewRow): string[] {
  const ids = [
    review.mainThread?.threadId,
    ...(review.implementers ?? []).map((thread) => thread?.threadId),
    ...(review.sends ?? []).map((send) => send?.threadId),
    review.sourceThreadId,
  ];
  return [...new Set(ids.filter((id): id is string => !!id))];
}

// Rows are parsed one by one so one odd review cannot hide the rest.
const reviewsSchema = z.object({ reviews: z.array(z.unknown()) });

const resolvedSchema = z.object({
  issues: z.array(
    z.object({
      id: z.string().catch(""),
      identifier: z.string(),
      title: z.string(),
      stateName: z.string().nullable().catch(null),
      url: z.string().nullable().optional().catch(null),
    }),
  ),
});

/** Looks up ticket keys the thread's Linear team can see; unknown keys are left out. */
export async function linearResolve(
  bb: BbPluginApi,
  identifiers: string[],
  threadId: string,
): Promise<Map<string, LinearBinding>> {
  const out = new Map<string, LinearBinding>();
  if (identifiers.length === 0) return out;
  try {
    const { issues } = await bb.sdk.plugins.callRpc({
      pluginId: "linear",
      method: "resolveIdentifiers",
      input: { identifiers, threadId },
      outputSchema: resolvedSchema,
    });
    for (const issue of issues) {
      out.set(issue.identifier, {
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        stateName: issue.stateName,
        url: issue.url ?? null,
      });
    }
  } catch (error) {
    bb.log.warn(`linear resolveIdentifiers: ${String(error)}`);
  }
  return out;
}

/**
 * Every Code Review Workspace review, newest first. A review merged into
 * another is left out: its key leads to the one that goes on.
 */
export async function codeReviews(bb: BbPluginApi): Promise<LinkedReview[]> {
  try {
    const { reviews } = await bb.sdk.plugins.callRpc({
      pluginId: "code-review-workspace",
      method: "listReviews",
      input: null,
      outputSchema: reviewsSchema,
    });
    return reviews
      .flatMap((raw) => {
        const parsed = reviewSchema.safeParse(raw);
        return parsed.success && !parsed.data.mergedInto ? [parsed.data] : [];
      })
      .map((review) => ({
        targetKey: review.targetKey,
        gitRef: review.gitRef ?? null,
        label: reviewLabel(review),
        state: reviewState(review),
        threadId: review.mainThread?.threadId ?? review.sourceThreadId ?? null,
        createdAt: review.createdAt ?? null,
        // A review on GitHub went to the agent at the turn's time, so a stage it reports afterwards still wins.
        sentAt:
          Math.max(
            lastSendAt(review),
            review.approvalSent?.at ?? 0,
            pushing(review) ? (review.push?.at ?? 0) : 0,
            waitingOnAuthor(review) ? (review.turn?.at ?? 0) : 0,
          ) || null,
        threadIds: linkedThreads(review),
        environmentId: review.feature?.environmentId ?? null,
        branch: review.feature?.branch ?? null,
      }))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  } catch (error) {
    bb.log.warn(`code-review-workspace listReviews: ${String(error)}`);
    return [];
  }
}

const startedSchema = z.object({ ok: z.boolean(), error: z.string().optional(), targetKey: z.string().optional() });

/**
 * Starts or opens the review of a thread's folder, as `bb review` with no
 * arguments does there; returns its key, or throws with Code Review Workspace's reason.
 */
export async function startCodeReview(bb: BbPluginApi, threadId: string): Promise<string> {
  let started: z.infer<typeof startedSchema>;
  try {
    started = await bb.sdk.plugins.callRpc({
      pluginId: "code-review-workspace",
      method: "reviewThreadChanges",
      input: { threadId },
      outputSchema: startedSchema,
    });
  } catch (error) {
    bb.log.warn(`code-review-workspace reviewThreadChanges: ${String(error)}`);
    throw new Error(`Couldn't reach Code Review Workspace: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (started.ok && started.targetKey) return started.targetKey;
  throw new Error(started.error || "Code Review Workspace didn't start the review. Try again.");
}
