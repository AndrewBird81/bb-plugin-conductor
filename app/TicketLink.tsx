import { CONTROL_HOVER_TRANSITION } from "@/components/ui/motion";
import { cn } from "@/lib/utils";
import { useOpenTicket } from "./hooks";

/** The board's one look for text that goes somewhere: a quiet underline that firms up on hover. */
export const LINK_UNDERLINE = "underline decoration-muted-foreground underline-offset-[3px]";

/** Text links and the ticket link: at least 24px tall to hit, with a ring for the keyboard. */
export const TEXT_LINK = cn(
  "inline-flex min-h-6 shrink-0 cursor-pointer items-center rounded-sm hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
  LINK_UNDERLINE,
  CONTROL_HOVER_TRANSITION,
);

/** A ticket's key that opens its page on the board, looking like the key on its board card. */
export function TicketLink({ boardId, ticketKey, className }: { boardId: number; ticketKey: string; className?: string }) {
  const openTicket = useOpenTicket();
  return (
    <button
      type="button"
      data-slot="ticket-link"
      aria-label={`${ticketKey}, ticket page`}
      className={cn(TEXT_LINK, "font-semibold", className)}
      onClick={() => openTicket(boardId, ticketKey)}
    >
      {ticketKey}
    </button>
  );
}
