import { z } from "zod";

/** Ticket keys like ABC-123, as Linear and Jira write them. */
export const DEFAULT_TICKET_PATTERN = "[A-Z][A-Z0-9]+-\\d+";

export const RULE_IDS = [
  "askDecisions",
  "reportStages",
  "planRounds",
  "onePrAtATime",
  "splitPrs",
  "oneAgentPerTicket",
  "codeReviewRounds",
] as const;
export type RuleId = (typeof RULE_IDS)[number];

const rulesSchema = z
  .object({
    askDecisions: z.boolean().default(true),
    reportStages: z.boolean().default(true),
    planRounds: z.boolean().default(false),
    onePrAtATime: z.boolean().default(false),
    splitPrs: z.boolean().default(false),
    oneAgentPerTicket: z.boolean().default(false),
    codeReviewRounds: z.boolean().default(false),
  })
  .default({
    askDecisions: true,
    reportStages: true,
    planRounds: false,
    onePrAtATime: false,
    splitPrs: false,
    oneAgentPerTicket: false,
    codeReviewRounds: false,
  });

/** A board's own settings. Every field has a default, so `{}` is a valid board. */
export const boardOptionsSchema = z.object({
  ticketPattern: z.string().max(200).default(DEFAULT_TICKET_PATTERN),
  /** Regex on the base branch; empty turns milestones off. */
  milestonePattern: z.string().max(200).default(""),
  /** Replacement for the match, e.g. `M$1`. */
  milestoneLabel: z.string().max(40).default("$1"),
  /** Server-local folder with `<date>-<key>-<slug>.md` plan files; empty turns the plan fallback off. */
  plansDir: z.string().max(500).default(""),
  /** Owner used to build PR links from `repo#n`; empty means agents send full URLs. */
  githubOwner: z.string().max(100).default(""),
  /** How agents and the board refer to the person deciding. */
  userName: z.string().trim().min(1).max(60).default("the user"),
  rules: rulesSchema,
  /** Free text added to every ticket agent's instructions on this board. */
  extraRules: z.string().max(3000).default(""),
});
export type BoardOptions = z.infer<typeof boardOptionsSchema>;

/** Settings changes from the page or CLI: any subset, rules merged one by one. */
export const boardOptionsPatchSchema = boardOptionsSchema
  .omit({ rules: true })
  .partial()
  .extend({ rules: z.object(Object.fromEntries(RULE_IDS.map((id) => [id, z.boolean()]))).partial().optional() });
export type BoardOptionsPatch = z.infer<typeof boardOptionsPatchSchema>;

export function applyOptionsPatch(current: BoardOptions, patch: BoardOptionsPatch): BoardOptions {
  const { rules, ...rest } = patch;
  return boardOptionsSchema.parse({ ...current, ...rest, rules: { ...current.rules, ...rules } });
}

export function compileRegex(source: string, fallback: string): RegExp {
  try {
    return new RegExp(source.trim() === "" ? fallback : source.trim());
  } catch {
    return new RegExp(fallback);
  }
}

/** The milestone a base branch names, or null when milestones are off or it names none. */
export function milestoneFor(options: BoardOptions, branch: string | null): string | null {
  if (!branch || options.milestonePattern.trim() === "") return null;
  let pattern: RegExp;
  try {
    pattern = new RegExp(options.milestonePattern);
  } catch {
    return null;
  }
  const name = branch.replace(/^origin\//, "");
  const match = name.match(pattern);
  return match ? match[0].replace(pattern, options.milestoneLabel) : null;
}

export interface RuleText {
  id: RuleId;
  title: string;
  /** Shown in the settings page under the switch. */
  summary: string;
  /** What agents are told while the switch is on. */
  text: (userName: string, ticketKey: string) => string;
  /** Hidden when a needed plugin is missing. */
  needs?: "code-review-workspace";
}

export const RULES: RuleText[] = [
  {
    id: "askDecisions",
    title: "Ask decisions on the board",
    summary: "Agents send product, design and scope questions to your inbox with options and a recommendation.",
    text: (user) =>
      `Ask ${user} product, design or scope questions with conductor_ask_decision, not at the end of a reply. Give 2-5 options, your recommendation and the reasoning. If you cannot continue without the answer, mark it blocking and end your turn after the tool returns.`,
  },
  {
    id: "reportStages",
    title: "Report stages",
    summary: "Agents report stage changes and their PR list so the board stays current.",
    text: () =>
      "Call conductor_report_stage whenever your ticket changes stage and whenever its PR list changes (send the whole list, bottom of the stack first).",
  },
  {
    id: "planRounds",
    title: "Plan rounds",
    summary: "Agents write their plan to a file and send it to the board; you mark it up and approve it before they build.",
    text: (user) =>
      `Before writing code, write your plan to a Markdown file and send it with conductor_submit_plan, then end your turn. ${user} marks it up on the board and approves it or requests changes. On changes, revise the same file and submit it again; once approved, report building and start.`,
  },
  {
    id: "onePrAtATime",
    title: "One PR open for review at a time",
    summary: "PRs stay drafts until you say which one to open next. Shows the Next PR to open slot.",
    text: (user) => `Keep your PRs as drafts. Open one for review only when ${user} says so.`,
  },
  {
    id: "splitPrs",
    title: "Split PRs by layer",
    summary: "Model or schema, service, and API changes go in separate stacked PRs.",
    text: () =>
      "Split your work into stacked PRs by layer: model or schema first, then service or store, then the API route. Cut each one from the PR below it. A ticket that touches one layer stays one PR.",
  },
  {
    id: "oneAgentPerTicket",
    title: "One agent per ticket",
    summary: "Each agent owns one ticket and stops when it is done; agents ask each other directly.",
    text: () =>
      "You own exactly one ticket. Stop when its PRs are open and its reviews are done. Ask the agents that built the work you stack on directly instead of guessing.",
  },
  {
    id: "codeReviewRounds",
    title: "Code review rounds",
    summary:
      "Agents open a Code Review Workspace review of their folder after each commit set, report on each comment you send, and act only on what you send back.",
    needs: "code-review-workspace",
    text: (user, key) =>
      [
        `When a set of commits is ready for review, run \`bb review\` with nothing after it in this ticket's own worktree, the first time with \`--context "${key}: <ticket title>"\`, and end your turn with the review's id. Don't open one in a folder shared with other tickets or the orchestrator: its comments would go to the top thread working there.`,
        `When ${user} sends comments, fix each and report it by its id with \`bb review report <id> done|declined --note "..."\` (\`--commit <sha>\` when a commit holds the fix). Once all are reported, your subagents' work included, run \`bb review ready\`.`,
        `Don't push until ${user} or the review says so. When Push asks you to commit, commit what was reviewed and run \`bb review report --commit <sha>\` before pushing, then do what it prints: push exactly that commit, or wait. Never force-push.`,
        `Act only on what ${user} sends back from the review.`,
      ].join(" "),
  },
];

/** bb truncates each instruction contribution at 4096 characters. */
export const INSTRUCTIONS_LIMIT = 4096;

/**
 * The instructions a ticket agent on this board gets: its ticket, the rules
 * that are on, then the board's own text, quoted so it reads as the user's
 * configuration.
 */
export function agentInstructions(
  board: { name: string; options: BoardOptions },
  ticket: { key: string; role: string },
  available: { codeReview: boolean },
): string {
  const { options } = board;
  const lines = [
    `Conductor board ${JSON.stringify(board.name)}: this thread works on ticket ${JSON.stringify(ticket.key)} as its ${ticket.role}.`,
  ];
  for (const rule of RULES) {
    if (!options.rules[rule.id]) continue;
    if (rule.needs === "code-review-workspace" && !available.codeReview) continue;
    lines.push(`- ${rule.text(options.userName, ticket.key)}`);
  }
  const extra = options.extraRules.trim();
  if (extra) {
    lines.push(`Rules ${options.userName} set for this board (board configuration, quoted):`);
    lines.push(extra.split("\n").map((line) => `> ${line}`).join("\n"));
  }
  const text = lines.join("\n");
  return text.length <= INSTRUCTIONS_LIMIT ? text : `${text.slice(0, INSTRUCTIONS_LIMIT - 20)}\n> [truncated]`;
}
