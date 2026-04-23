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
  | {
      type:
        | "subscriptionItem.active"
        | "subscriptionItem.updated"
        | "subscriptionItem.canceled"
        | "subscriptionItem.ended"
        | "subscriptionItem.freeTrialEnding";
      data: any;
    }
  | { type: string; data: any }; // catch-all for unhandled types

/**
 * Extract (clerkOrgId, planKey) from a Clerk Billing subscriptionItem event.
 *
 * Clerk's Billing Beta doesn't publish a schema for these payloads, so this
 * scans common shapes: payer at the top level, plan as object or id, snake_case
 * keys. If extraction fails we log the raw event and return null — never
 * throw, so Clerk doesn't retry a misshapen event forever.
 */
function extractBillingEvent(data: any): { clerkOrgId: string; planKey: string | null } | null {
  if (!data || typeof data !== "object") return null;

  // Org id candidates — check payer object first, then flat fields.
  const orgId: unknown =
    data?.payer?.organization_id ??
    data?.payer?.organizationId ??
    data?.organization_id ??
    data?.organizationId ??
    data?.org_id ??
    null;

  // Plan key candidates — plan object (slug/key/id), then flat fields.
  const planKey: unknown =
    data?.plan?.slug ??
    data?.plan?.key ??
    data?.plan?.id ??
    data?.plan_slug ??
    data?.plan_key ??
    data?.plan_id ??
    null;

  if (typeof orgId !== "string" || orgId.length === 0) return null;
  // planKey may legitimately be null on cancellation — only bail if the whole payload is unusable.
  return {
    clerkOrgId: orgId,
    planKey: typeof planKey === "string" && planKey.length > 0 ? planKey : null,
  };
}

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
      case "subscriptionItem.active":
      case "subscriptionItem.updated":
      case "subscriptionItem.freeTrialEnding": {
        // Log the full payload until we confirm the exact shape on first real event.
        console.log(
          `Clerk billing event ${event.type} received`,
          JSON.stringify(event.data),
        );
        const extracted = extractBillingEvent(event.data);
        if (!extracted || !extracted.planKey) {
          console.warn(
            `Could not extract clerkOrgId+planKey from ${event.type}; no-op. ` +
              `Payload keys: ${Object.keys(event.data ?? {}).join(",")}`,
          );
          break;
        }
        await ctx.runMutation(internal.clerkSync.setOrgPlan, {
          clerkOrgId: extracted.clerkOrgId,
          planKey: extracted.planKey,
          attempts: 0,
        });
        break;
      }
      case "subscriptionItem.canceled":
      case "subscriptionItem.ended": {
        console.log(
          `Clerk billing event ${event.type} received`,
          JSON.stringify(event.data),
        );
        const extracted = extractBillingEvent(event.data);
        if (!extracted) {
          console.warn(
            `Could not extract clerkOrgId from ${event.type}; no-op.`,
          );
          break;
        }
        await ctx.runMutation(internal.clerkSync.setOrgPlan, {
          clerkOrgId: extracted.clerkOrgId,
          planKey: null,
          attempts: 0,
        });
        break;
      }
      default:
        // Unhandled event type — log and 200 so Clerk doesn't retry forever.
        console.log("Unhandled Clerk event:", event.type);
    }

    return new Response("ok", { status: 200 });
  }),
});

export default http;
