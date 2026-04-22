import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isPublic = createRouteMatcher(["/", "/sign-in(.*)", "/sign-up(.*)"]);
const isCreateWorkspace = createRouteMatcher(["/create-workspace"]);

export default clerkMiddleware(async (auth, req) => {
  if (isPublic(req)) return;

  const { orgSlug } = await auth.protect();

  // Signed in, visiting /create-workspace with an active org → go to workspace.
  if (isCreateWorkspace(req) && orgSlug) {
    return NextResponse.redirect(new URL(`/${orgSlug}`, req.url));
  }

  // Signed in, visiting a workspace-scoped route with no active org → force creation.
  if (!isCreateWorkspace(req) && !orgSlug) {
    return NextResponse.redirect(new URL("/create-workspace", req.url));
  }

  // URL slug must match active org. If not, redirect to their active org.
  const urlSlug = req.nextUrl.pathname.split("/")[1];
  if (urlSlug && orgSlug && urlSlug !== orgSlug && !isCreateWorkspace(req)) {
    return NextResponse.redirect(new URL(`/${orgSlug}`, req.url));
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
