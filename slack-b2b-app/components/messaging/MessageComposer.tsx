"use client";

import { useState, KeyboardEvent } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useTypingHeartbeat } from "@/hooks/useTypingHeartbeat";

const MAX = 4000;

export function MessageComposer({
  channelId,
}: {
  channelId: Id<"channels">;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const send = useMutation(api.messages.send);
  const typing = useTypingHeartbeat(channelId);

  const disabled = pending || !text.trim() || text.length > MAX;

  const submit = async () => {
    if (disabled) return;
    setPending(true);
    try {
      await send({ channelId, text });
      setText("");
      typing.onSend();
    } finally {
      setPending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="border-t p-3 bg-white dark:bg-zinc-950">
      <div className="flex gap-2">
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            typing.onKey();
          }}
          onKeyDown={onKeyDown}
          onBlur={typing.onBlur}
          onFocus={typing.onFocus}
          placeholder="Message #channel"
          rows={2}
          maxLength={MAX + 100}
          className="flex-1 resize-none rounded border px-3 py-2 text-sm dark:bg-zinc-900"
        />
        <button
          disabled={disabled}
          onClick={() => void submit()}
          className="px-4 rounded bg-foreground text-background text-sm font-medium disabled:opacity-50"
        >
          Send
        </button>
      </div>
      {text.length > 3800 && (
        <div className="text-xs text-right mt-1 text-zinc-500">
          {text.length} / {MAX}
        </div>
      )}
    </div>
  );
}
