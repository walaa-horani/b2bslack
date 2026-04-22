import Link from "next/link";
import { SignedIn, SignedOut, SignInButton, SignUpButton } from "@clerk/nextjs";

export default function Home() {
  return (
    <main className="flex flex-col flex-1 items-center justify-center gap-6 p-8">
      <h1 className="text-4xl font-bold">Slack B2B</h1>
      <p className="text-zinc-500">A multi-tenant team chat app.</p>
      <SignedOut>
        <div className="flex gap-3">
          <SignInButton mode="modal">
            <button className="rounded-md bg-foreground px-4 py-2 text-background">
              Sign in
            </button>
          </SignInButton>
          <SignUpButton mode="modal">
            <button className="rounded-md border px-4 py-2">Sign up</button>
          </SignUpButton>
        </div>
      </SignedOut>
      <SignedIn>
        <Link href="/create-workspace" className="underline">
          Go to your workspace
        </Link>
      </SignedIn>
    </main>
  );
}
