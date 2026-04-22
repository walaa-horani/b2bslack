import { SignIn } from "@clerk/nextjs";

export default function Page() {
  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <SignIn signUpUrl="/sign-up" forceRedirectUrl="/create-workspace" />
    </main>
  );
}
