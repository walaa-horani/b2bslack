import { SyncActiveOrg } from "@/components/SyncActiveOrg";

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
      {children}
    </>
  );
}
