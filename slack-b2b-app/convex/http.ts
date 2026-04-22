import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { Webhook } from "svix";
import { internal } from "./_generated/api";

type ClerkEvent =
  | { type: "user.created" | "user.updated"; data: any }
  | { type: "user.deleted"; data: { id: string } }
  | { type: "organization.created" | "organization.updated"; data: any }
  | { type: "organization.deleted"; data: { id: string } }
  | {
      type:
        | "organizationMembership.created"
        | "organizationMembership.updated";
      data: any;
    }
  | { type: "organizationMembership.deleted"; data: { id: string } }
  | { type: string; data: any }; // catch-all for unhandled types

const http = httpRouter();

http.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.CLERK_WEBHOOK_SECRET;
    const issuerDomain = process.env.CLERK_JWT_ISSUER_DOMAIN;
    if (!secret || !issuerDomain) {
      console.error("Missing CLERK_WEBHOOK_SECRET or CLERK_JWT_ISSUER_DOMAIN");
      return new Response("Server misconfigured", { status: 500 });
    }

    const svixId = req.headers.get("svix-id");
    const svixTimestamp = req.headers.get("svix-timestamp");
    const svixSignature = req.headers.get("svix-signature");
    if (!svixId || !svixTimestamp || !svixSignature) {
      return new Response("Missing Svix headers", { status: 400 });
    }
    const body = await req.text();

    let event: ClerkEvent;
    try {
      event = new Webhook(secret).verify(body, {
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": svixSignature,
      }) as ClerkEvent;
    } catch (err) {
      console.error("Svix verification failed:", err);
      return new Response("Invalid signature", { status: 400 });
    }

    switch (event.type) {
      case "user.created":
      case "user.updated":
        await ctx.runMutation(internal.clerkSync.upsertUser, {
          data: event.data,
          issuerDomain,
        });
        break;
      case "user.deleted":
        await ctx.runMutation(internal.clerkSync.deleteUser, {
          clerkUserId: event.data.id,
        });
        break;
      case "organization.created":
      case "organization.updated":
        await ctx.runMutation(internal.clerkSync.upsertOrganization, {
          data: event.data,
        });
        break;
      case "organization.deleted":
        await ctx.runMutation(internal.clerkSync.deleteOrganization, {
          clerkOrgId: event.data.id,
        });
        break;
      case "organizationMembership.created":
      case "organizationMembership.updated":
        await ctx.runMutation(internal.clerkSync.upsertMembership, {
          data: event.data,
          attempts: 0,
        });
        break;
      case "organizationMembership.deleted":
        await ctx.runMutation(internal.clerkSync.deleteMembership, {
          clerkMembershipId: event.data.id,
        });
        break;
      default:
        // Unhandled event type — log and 200 so Clerk doesn't retry forever.
        console.log("Unhandled Clerk event:", event.type);
    }

    return new Response("ok", { status: 200 });
  }),
});

export default http;
