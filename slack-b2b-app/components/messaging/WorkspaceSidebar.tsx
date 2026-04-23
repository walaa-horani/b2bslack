"use client";

export function WorkspaceSidebar({ slug }: { slug: string }) {
  return (
    <aside className="w-64 flex-shrink-0 border-r bg-zinc-100 p-4 text-sm">
      <div className="font-semibold">{slug}</div>
      <div className="mt-4 text-zinc-500">Channels (coming in Task 14)</div>
    </aside>
  );
}
