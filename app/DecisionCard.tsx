import { useId, useState } from "react";
import {
  Markdown,
  experimental_useRpcMutation as useRpcMutation,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { rpcContract, type Decision } from "../src/contract";
import { useOpenAgentThread } from "./AgentTabs";
import { errorText, formatTime } from "./hooks";
import { TEXT_LINK, TicketLink } from "./TicketLink";

const OTHER = "__other__";

// RPC input is strict JSON, so an empty note is left out rather than sent as undefined.
const withNote = (note: string) => (note.trim() ? { note: note.trim() } : {});

/**
 * One decision. Open ones carry the answer form; settled ones show the answer
 * and whether it reached the agent.
 */
export function DecisionCard({
  decision,
  showTicket = true,
  compact = false,
}: {
  decision: Decision;
  showTicket?: boolean;
  compact?: boolean;
}) {
  const openAgent = useOpenAgentThread();
  return (
    <article
      aria-label={`${decision.ref}: ${decision.question}`}
      className={cn(
        "space-y-3 rounded-lg border bg-card p-4 text-sm",
        decision.status === "open" && decision.blocking ? "border-amber-500/60" : "border-border",
      )}
    >
      {/* Open thread keeps the top right; the rest wraps beside it in a narrow column. */}
      <header className="flex items-start gap-x-3 text-xs text-muted-foreground">
        <div className="flex min-h-6 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono">{decision.ref}</span>
          {showTicket && (
            <TicketLink boardId={decision.boardId} ticketKey={decision.ticketKey} className="text-foreground" />
          )}
          {decision.status === "open" && decision.blocking && (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-300">blocking</span>
          )}
          {decision.status !== "open" && <span className="rounded bg-muted px-1.5 py-0.5">{decision.status}</span>}
          <span>{formatTime(decision.createdAt)}</span>
        </div>
        <button
          type="button"
          aria-label={`Open thread that asked ${decision.ref}`}
          className={cn(TEXT_LINK, "text-foreground")}
          onClick={() => openAgent(decision.threadId, `${decision.ticketKey} ${decision.ref}`)}
        >
          Open thread
        </button>
      </header>
      <p className="font-medium text-foreground">{decision.question}</p>
      {!compact && decision.reasoning && (
        <div className="text-muted-foreground">
          <Markdown content={decision.reasoning} />
        </div>
      )}
      {decision.status === "open" ? <AnswerForm decision={decision} /> : <Settled decision={decision} />}
    </article>
  );
}

function AnswerForm({ decision }: { decision: Decision }) {
  const name = useId();
  const [choice, setChoice] = useState<string>(decision.recommendation ?? "");
  const [other, setOther] = useState("");
  const [note, setNote] = useState("");
  const answer = useRpcMutation({ contract: rpcContract, method: "decisions.answer" });
  const withdraw = useRpcMutation({ contract: rpcContract, method: "decisions.withdraw" });
  const value = choice === OTHER ? other.trim() : choice;
  const busy = answer.isPending || withdraw.isPending;
  const error = answer.error ?? withdraw.error;

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (value === "" || busy) return;
        void answer.mutate({ id: decision.id, choice: value, ...withNote(note) }).catch(() => {});
      }}
    >
      <fieldset className="space-y-1.5">
        <legend className="sr-only">Options</legend>
        {decision.options.map((option) => (
          <label key={option.label} className="flex cursor-pointer gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60">
            <input
              type="radio"
              name={name}
              value={option.label}
              checked={choice === option.label}
              onChange={() => setChoice(option.label)}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="font-medium">{option.label}</span>
              {option.label === decision.recommendation && (
                <span className="ml-2 text-xs text-muted-foreground">recommended</span>
              )}
              {option.detail && <span className="block text-muted-foreground">{option.detail}</span>}
            </span>
          </label>
        ))}
        <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60">
          <input type="radio" name={name} value={OTHER} checked={choice === OTHER} onChange={() => setChoice(OTHER)} />
          <span className="shrink-0">Other:</span>
          <Input
            aria-label="Your own answer"
            value={other}
            onFocus={() => setChoice(OTHER)}
            onChange={(event) => {
              setOther(event.target.value);
              setChoice(OTHER);
            }}
            className="h-8"
          />
        </label>
      </fieldset>
      <textarea
        aria-label="Note for the agent"
        placeholder="Note for the agent (optional)"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={value === "" || busy}>
          Answer
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void withdraw.mutate({ id: decision.id, ...withNote(note) }).catch(() => {})}
        >
          Withdraw
        </Button>
        {error && <span role="alert" className="text-xs text-destructive">{errorText(error)}</span>}
      </div>
    </form>
  );
}

function Settled({ decision }: { decision: Decision }) {
  const retry = useRpcMutation({ contract: rpcContract, method: "decisions.retryDelivery" });
  return (
    <div className="space-y-1">
      {decision.answer?.choice && (
        <p>
          <span className="text-muted-foreground">Answer: </span>
          <span className="font-medium">{decision.answer.choice}</span>
        </p>
      )}
      {decision.answer?.note && <p className="text-muted-foreground">{decision.answer.note}</p>}
      <p className="text-xs text-muted-foreground">
        {decision.deliveredAt !== null
          ? `Sent to the agent ${formatTime(decision.deliveredAt)}`
          : decision.deliveryError
            ? `Not delivered: ${decision.deliveryError}`
            : "Sending…"}
      </p>
      {decision.deliveryError && decision.deliveredAt === null && (
        <Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => void retry.mutate({ id: decision.id }).catch(() => {})}>
          Retry
        </Button>
      )}
    </div>
  );
}
