"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useHasFeature } from "@/hooks/useHasFeature";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function CreateChannelModal({
  open,
  workspaceSlug,
  onClose,
}: {
  open: boolean;
  workspaceSlug: string;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const create = useMutation(api.channels.create);
  const router = useRouter();
  const canPrivate = useHasFeature(workspaceSlug, "private_channels");

  const slug = slugify(name);

  if (!open) return null;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!slug) {
      setError("Channel name must contain alphanumeric characters.");
      return;
    }
    setSubmitting(true);
    try {
      await create({ workspaceSlug, name, slug, isPrivate });
      onClose();
      setName("");
      setIsPrivate(false);
      router.push(`/${workspaceSlug}/channels/${slug}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create channel");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-20 bg-black/40 flex items-center justify-center">
      <form
        onSubmit={onSubmit}
        className="bg-white dark:bg-zinc-950 rounded-lg shadow-xl p-6 w-full max-w-md flex flex-col gap-3"
      >
        <h2 className="text-lg font-semibold">Create a channel</h2>
        <label className="flex flex-col gap-1 text-sm">
          <span>Name</span>
          <input
            autoFocus
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="project-alpha"
            maxLength={80}
            className="rounded border px-3 py-2 text-sm dark:bg-zinc-900"
          />
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            disabled={!canPrivate}
            checked={isPrivate && !!canPrivate}
            onChange={(e) => setIsPrivate(e.target.checked)}
            className="mt-0.5"
          />
          <span className={canPrivate ? "" : "text-zinc-400"}>
            Make private
            {canPrivate === false && (
              <span className="ml-2 text-xs rounded bg-purple-100 text-purple-700 px-1.5 py-0.5">
                Pro
              </span>
            )}
            <span className="block text-xs text-zinc-500 mt-0.5">
              Only invited people can see and send messages.
              {canPrivate === false && (
                <>
                  {" "}
                  <a
                    href={`/${workspaceSlug}/settings/billing`}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    Upgrade to Pro
                  </a>
                </>
              )}
            </span>
          </span>
        </label>
        {name && (
          <div className="text-xs text-zinc-500">
            URL: <code>/{workspaceSlug}/channels/{slug || "—"}</code>
          </div>
        )}
        {error && <div className="text-xs text-red-600">{error}</div>}
        <div className="flex justify-end gap-2 mt-2">
          <button
            type="button"
            className="px-3 py-1 rounded text-sm"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !slug}
            className="px-3 py-1 rounded bg-foreground text-background text-sm disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
