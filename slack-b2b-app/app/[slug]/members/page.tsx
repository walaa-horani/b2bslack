import { OrganizationProfile } from "@clerk/nextjs";

export default function MembersPage() {
  return (
    <main className="flex flex-1 items-start justify-center p-8">
      <OrganizationProfile routing="hash" />
    </main>
  );
}
