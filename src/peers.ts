// Reads from other installed plugins over their RPC: Linear's, which isn't
// published, and Code Review Workspace's published one. Parse only the
// fields we use and treat any failure as "no data" rather than failing the
// board.
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

/** A review as Code Review Workspace (1.10+) publishes it in `reviews.v1.status`, as far as the board reads it. */
const reviewStatusSchema = z.object({
  targetKey: z.string(),
  id: z.string(),
  createdAt: z.number(),
  branch: z.string().nullable(),
  folder: z.object({ environmentId: z.string() }).nullable(),
  mainThreadId: z.string().nullable(),
  threadIds: z.array(z.string()),
  waitsOn: z.enum(["user", "agent", "author", "nobody"]),
  approved: z.boolean(),
  since: z.number(),
  label: z.string(),
  archived: z.boolean(),
  mergedInto: z.string().nullable(),
});
type ReviewStatus = z.infer<typeof reviewStatusSchema>;

/**
 * Where a review stands for the board, from who it waits on. On a PR not
 * under the user's login, its author is the ticket's agent.
 */
export function reviewState(review: ReviewStatus): ReviewState {
  if (review.archived) return "archived";
  if (review.waitsOn === "user") return "needs-review";
  if (review.waitsOn === "agent" || review.waitsOn === "author") return "with-agent";
  return review.approved ? "approved" : "idle";
}

/** A review with what ties it to tickets: its threads, its folder and its branch. */
export type LinkedReview = Review & { threadIds: string[]; environmentId: string | null; branch: string | null };

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
 * Every Code Review Workspace review, newest first, from `reviews.v1.status`;
 * null without a valid answer: Code Review Workspace missing, disabled, older
 * than 1.10, failing or answering junk. A review merged into another is left
 * out: its key leads to the one that goes on.
 */
export async function codeReviews(bb: BbPluginApi): Promise<LinkedReview[] | null> {
  try {
    const { reviews } = await bb.sdk.plugins.callRpc({
      pluginId: "code-review-workspace",
      method: "reviews.v1.status",
      input: null,
      outputSchema: z.object({ reviews: z.array(reviewStatusSchema) }),
    });
    return reviews
      .filter((review) => review.mergedInto === null)
      .map((review) => ({
        targetKey: review.targetKey,
        id: review.id,
        label: review.label,
        state: reviewState(review),
        threadId: review.mainThreadId,
        createdAt: review.createdAt,
        since: review.since,
        threadIds: review.threadIds,
        environmentId: review.folder?.environmentId ?? null,
        branch: review.branch,
      }));
  } catch (error) {
    // BB's call error carries the HTTP status. Missing, older than 1.10 or still starting answers 404, and not
    // running 503: expected, so not logged.
    const status = (error as { status?: unknown } | null)?.status;
    if (status !== 404 && status !== 503) bb.log.warn(`code-review-workspace reviews.v1.status: ${String(error)}`);
    return null;
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
