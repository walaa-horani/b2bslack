"use client";

import { use, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { ChannelHeader } from "@/components/messaging/ChannelHeader";
import { ChannelErrorBoundary } from "@/components/messaging/ChannelErrorBoundary";
import { MessageList } from "@/components/messaging/MessageList";
import { MessageComposer } from "@/components/messaging/MessageComposer";

export default function ChannelPage({
  params,
}: {
  params: Promise<{ slug: string; channel: string }>;
}) {
  const { slug, channel } = use(params);
  const router = useRouter();
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    if (errored) router.replace(`/${slug}/channels/general`);
  }, [errored, slug, router]);

  if (errored) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
        Redirecting…
      </div>
    );
  }

  return (
    <ChannelErrorBoundary onError={() => setErrored(true)}>
      <ChannelContent slug={slug} channel={channel} />
    </ChannelErrorBoundary>
  );
}

function ChannelContent({
  slug,
  channel,
}: {
  slug: string;
  channel: string;
}) {
  const router = useRouter();
  const data = useQuery(api.channels.getBySlug, {
    workspaceSlug: slug,
    channelSlug: channel,
  });
  const deleteChannel = useMutation(api.channels.deleteChannel);

  if (data === undefined) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-400">
        Loading…
      </div>
    );
  }

  const isAdmin = data.role === "org:admin";

  const onDeleteChannel = async () => {
    if (!confirm(`Delete #${data.channel.slug}?`)) return;
    await deleteChannel({ channelId: data.channel._id });
    router.push(`/${slug}/channels/general`);
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <ChannelHeader
        name={data.channel.name}
        slug={data.channel.slug}
        memberCount={data.memberCount}
        isProtected={data.channel.isProtected}
        isAdmin={isAdmin}
        onDelete={onDeleteChannel}
      />
      <MessageList channelId={data.channel._id} />
      <MessageComposer channelId={data.channel._id} />
    </div>
  );
}
