import { SyncActiveOrg } from "@/components/SyncActiveOrg";
import { WorkspaceSidebar } from "@/components/messaging/WorkspaceSidebar";

export default async function SlugLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <>
      <SyncActiveOrg slug={slug} />
      <div className="flex flex-1 min-h-0">
        <WorkspaceSidebar slug={slug} />
        <div className="flex flex-col flex-1 min-w-0">{children}</div>
      </div>
    </>
  );
}
