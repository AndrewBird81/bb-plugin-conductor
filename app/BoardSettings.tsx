import { useEffect, useState, type ReactNode } from "react";
import { experimental_useRpcMutation as useRpcMutation } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { rpcContract } from "../src/contract";
import { agentInstructions, INSTRUCTIONS_LIMIT, RULES, type BoardOptions, type RuleId } from "../src/options";
import { errorText, useBoards, useGo } from "./hooks";

type TextField = Exclude<keyof BoardOptions, "rules" | "extraRules">;

const FIELDS: { key: TextField; label: string; hint: string; placeholder?: string }[] = [
  { key: "userName", label: "Your name for agents", hint: "How agents refer to you in questions and messages." },
  {
    key: "ticketPattern",
    label: "Ticket key pattern",
    hint: "Regular expression for ticket keys in thread titles. Threads without a key show under Other work.",
  },
  {
    key: "milestonePattern",
    label: "Milestone pattern",
    hint: "Regular expression on a ticket's base branch. Leave empty to turn milestones off.",
    placeholder: "^m(\\d+)-",
  },
  { key: "milestoneLabel", label: "Milestone label", hint: "Made from the match; $1 is the first group.", placeholder: "M$1" },
  {
    key: "plansDir",
    label: "Plans folder",
    hint: "Folder on the bb server with <date>-<key>-<slug>.md plans. Lets the board spot a plan waiting on you.",
  },
  { key: "githubOwner", label: "GitHub owner", hint: "Builds PR links when agents report repo#123." },
];

export function BoardSettings({ boardId }: { boardId: number }) {
  const go = useGo();
  const { data } = useBoards();
  const board = data?.boards.find((b) => b.id === boardId);
  const update = useRpcMutation({ contract: rpcContract, method: "boards.update" });
  const remove = useRpcMutation({ contract: rpcContract, method: "boards.remove" });
  const [name, setName] = useState("");
  const [options, setOptions] = useState<BoardOptions | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    if (board && options === null) {
      setName(board.name);
      setOptions(board.options);
    }
  }, [board, options]);

  if (!board || !options) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const codeReview = data?.integrations.codeReview ?? false;
  const preview = agentInstructions({ name, options }, { key: "ABC-123", role: "lead" }, { codeReview });
  const set = (patch: Partial<BoardOptions>) => {
    setOptions({ ...options, ...patch });
    setSaved(false);
  };
  const setRule = (id: RuleId, on: boolean) => set({ rules: { ...options.rules, [id]: on } });

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        void update
          .mutate({ boardId, name: name.trim() || board.name, options })
          .then(() => setSaved(true), () => {});
      }}
    >
      <div className="flex items-center gap-3">
        <button type="button" className="text-xs text-muted-foreground hover:underline" onClick={() => go.board(boardId)}>
          Back to the board
        </button>
      </div>
      <h1 className="text-lg font-semibold">Board settings</h1>

      <Field label="Board name" hint="Shown in the sidebar and the title bar.">
        <Input value={name} onChange={(event) => {
            setName(event.target.value);
            setSaved(false);
          }} />
      </Field>
      <Field label="Orchestrator thread" hint="The thread whose children are this board's tickets.">
        <code className="text-xs">{board.orchestratorThreadId}</code>
      </Field>
      {FIELDS.map((field) => (
        <Field key={field.key} label={field.label} hint={field.hint}>
          <Input
            value={options[field.key]}
            placeholder={field.placeholder}
            onChange={(event) => set({ [field.key]: event.target.value } as Partial<BoardOptions>)}
          />
        </Field>
      ))}

      <section className="space-y-3" aria-label="Agent rules">
        <div>
          <h2 className="text-sm font-semibold">Agent rules</h2>
          <p className="text-xs text-muted-foreground">
            What this board's ticket agents are told. Agents pick up changes when their next session starts.
          </p>
        </div>
        {RULES.map((rule) => {
          const unavailable = rule.needs === "code-review-workspace" && !codeReview;
          return (
            <label key={rule.id} className="flex gap-3 text-sm">
              <Checkbox
                checked={options.rules[rule.id]}
                disabled={unavailable}
                onCheckedChange={(checked) => setRule(rule.id, checked === true)}
                aria-label={rule.title}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">{rule.title}</span>
                <span className="block text-muted-foreground">
                  {unavailable ? "Needs the Code Review Workspace plugin, version 1.10 or newer." : rule.summary}
                </span>
              </span>
            </label>
          );
        })}
        <Field label="Your own rules" hint="Added to every ticket agent on this board, after the switches above.">
          <textarea
            value={options.extraRules}
            maxLength={3000}
            rows={6}
            onChange={(event) => set({ extraRules: event.target.value })}
            className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </Field>
        <p className={preview.length > INSTRUCTIONS_LIMIT * 0.9 ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
          {preview.length} of {INSTRUCTIONS_LIMIT} characters bb passes to each agent.
        </p>
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">What an agent sees</summary>
          <pre className="mt-2 whitespace-pre-wrap rounded-md border border-border p-3">{preview}</pre>
        </details>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={update.isPending}>
          Save
        </Button>
        {saved && <span className="text-sm text-muted-foreground">Saved.</span>}
        {(update.error ?? remove.error) && (
          <span role="alert" className="text-sm text-destructive">
            {errorText(update.error ?? remove.error)}
          </span>
        )}
        <span className="ml-auto" />
        {confirmRemove ? (
          <>
            <span className="text-sm">Remove this board, its decisions and history? Threads stay.</span>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void remove.mutate({ boardId }).then(() => go.start(), () => {})}
            >
              Remove board
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirmRemove(false)}>
              Keep it
            </Button>
          </>
        ) : (
          <Button type="button" variant="ghost" onClick={() => setConfirmRemove(true)}>
            Remove board…
          </Button>
        )}
      </div>
    </form>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 text-sm md:grid-cols-[200px_minmax(0,1fr)] md:gap-4">
      <div>
        <div className="font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{hint}</div>
      </div>
      <div>{children}</div>
    </div>
  );
}
