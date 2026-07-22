import { FormEvent, useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { ChatMessage } from "@/types/meeting";
import { formatTime } from "@/utils/meeting";

type Props = {
  messages: ChatMessage[];
  onSend: (message: string) => void;
};

export function ChatPanel({ messages, onSend }: Props) {
  const [message, setMessage] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = message.trim();
    if (!value) return;
    onSend(value);
    setMessage("");
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-white/10 p-4">
        <h2 className="font-semibold">Chat</h2>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {messages.map((item) => (
          <div key={item.id} className="rounded-md bg-white/6 p-3">
            <div className="mb-1 flex items-center justify-between gap-2 text-xs text-slate-400">
              <span className="truncate font-medium text-slate-200">{item.senderName}</span>
              <span>{formatTime(new Date(item.timestamp))}</span>
            </div>
            <p className="break-words text-sm text-slate-100">{item.message}</p>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <form onSubmit={submit} className="flex gap-2 border-t border-white/10 p-3">
        <input
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Message everyone"
          className="min-w-0 flex-1 rounded-md border border-white/10 bg-[#0b0d12] px-3 py-2 text-sm outline-none ring-call/40 placeholder:text-slate-500 focus:ring-2"
        />
        <button className="grid h-10 w-10 place-items-center rounded-md bg-call text-white" aria-label="Send message">
          <Send size={18} />
        </button>
      </form>
    </div>
  );
}
