import { CreateOrganization } from "@clerk/nextjs";

export default function Page() {
  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <div className="flex flex-col gap-4 items-center">
        <h1 className="text-2xl font-semibold">Create your workspace</h1>
        <p className="text-zinc-500 text-sm max-w-sm text-center">
          This will be the home for your team. You can invite teammates by email
          once the workspace is created.
        </p>
        <CreateOrganization
          afterCreateOrganizationUrl="/:slug"
          skipInvitationScreen={false}
        />
      </div>
    </main>
  );
}
