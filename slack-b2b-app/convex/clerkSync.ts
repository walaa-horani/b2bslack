import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

// Clerk webhook payloads contain ~40 fields each; we only read a few. We use
// v.any() for the `data` arg (these mutations are only called from http.ts
// *after* Svix signature verification, so trusted input) and apply narrow
// local TS types inside each handler.

// ---------- user ----------

type ClerkUserData = {
  id: string;
  email_addresses: Array<{ email_address: string }>;
  first_name?: string | null;
  last_name?: string | null;
  image_url?: string | null;
};

function fullName(first?: string | null, last?: string | null): string | undefined {
  const joined = [first, last].filter(Boolean).join(" ").trim();
  return joined || undefined;
}

export const upsertUser = internalMutation({
  args: { data: v.any(), issuerDomain: v.string() },
  handler: async (ctx, { data, issuerDomain }) => {
    const u = data as ClerkUserData;
    const tokenIdentifier = `${issuerDomain}|${u.id}`;
    const email = u.email_addresses[0]?.email_address ?? "";
    const name = fullName(u.first_name, u.last_name);
    const imageUrl = u.image_url ?? undefined;

    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", u.id))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { email, name, imageUrl, tokenIdentifier });
      return existing._id;
    }
    return await ctx.db.insert("users", {
      clerkUserId: u.id,
      tokenIdentifier,
      email,
      name,
      imageUrl,
    });
  },
});

export const deleteUser = internalMutation({
  args: { clerkUserId: v.string() },
  handler: async (ctx, { clerkUserId }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();
    if (!user) return;

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(256);
    for (const m of memberships) await ctx.db.delete(m._id);

    await ctx.db.delete(user._id);
  },
});

// ---------- organization ----------

type ClerkOrgData = {
  id: string;
  slug: string;
  name: string;
  image_url?: string | null;
};

export const upsertOrganization = internalMutation({
  args: { data: v.any() },
  handler: async (ctx, { data }) => {
    const o = data as ClerkOrgData;
    const imageUrl = o.image_url ?? undefined;

    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", o.id))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        slug: o.slug,
        name: o.name,
        imageUrl,
      });
      return existing._id;
    }
    return await ctx.db.insert("organizations", {
      clerkOrgId: o.id,
      slug: o.slug,
      name: o.name,
      imageUrl,
    });
  },
});

export const deleteOrganization = internalMutation({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, { clerkOrgId }) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", clerkOrgId))
      .unique();
    if (!org) return;

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .take(256);
    for (const m of memberships) await ctx.db.delete(m._id);

    await ctx.db.delete(org._id);
  },
});

// ---------- membership ----------

type ClerkMembershipData = {
  id: string;
  organization: { id: string };
  public_user_data: { user_id: string };
  role: string;
};

const MAX_MEMBERSHIP_RETRIES = 5;

export const upsertMembership = internalMutation({
  args: { data: v.any(), attempts: v.number() },
  handler: async (ctx, { data, attempts }) => {
    const m = data as ClerkMembershipData;
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_user_id", (q) =>
        q.eq("clerkUserId", m.public_user_data.user_id),
      )
      .unique();
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", m.organization.id))
      .unique();

    if (!user || !org) {
      if (attempts >= MAX_MEMBERSHIP_RETRIES) {
        console.error(
          `upsertMembership giving up on ${m.id} after ${attempts} attempts: user=${!!user} org=${!!org}`,
        );
        return;
      }
      await ctx.scheduler.runAfter(
        5000,
        internal.clerkSync.upsertMembership,
        { data, attempts: attempts + 1 },
      );
      return;
    }

    // 1. Workspace membership row (existing behavior).
    const existing = await ctx.db
      .query("memberships")
      .withIndex("by_clerk_membership_id", (q) =>
        q.eq("clerkMembershipId", m.id),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { role: m.role });
    } else {
      await ctx.db.insert("memberships", {
        userId: user._id,
        organizationId: org._id,
        clerkMembershipId: m.id,
        role: m.role,
      });
    }

    // 2. Ensure #general exists (idempotent).
    let general = await ctx.db
      .query("channels")
      .withIndex("by_organization_and_slug", (q) =>
        q.eq("organizationId", org._id).eq("slug", "general"),
      )
      .unique();
    if (!general) {
      const generalId = await ctx.db.insert("channels", {
        organizationId: org._id,
        slug: "general",
        name: "General",
        createdBy: user._id,
        isProtected: true,
      });
      general = await ctx.db.get(generalId);
    }

    // 3. Add this user to every protected channel in the workspace.
    const protectedChannels = await ctx.db
      .query("channels")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .collect();
    for (const ch of protectedChannels) {
      if (!ch.isProtected) continue;
      const already = await ctx.db
        .query("channelMembers")
        .withIndex("by_user_and_channel", (q) =>
          q.eq("userId", user._id).eq("channelId", ch._id),
        )
        .unique();
      if (!already) {
        await ctx.db.insert("channelMembers", {
          userId: user._id,
          channelId: ch._id,
          organizationId: org._id,
        });
      }
    }
  },
});

export const deleteMembership = internalMutation({
  args: { clerkMembershipId: v.string() },
  handler: async (ctx, { clerkMembershipId }) => {
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_clerk_membership_id", (q) =>
        q.eq("clerkMembershipId", clerkMembershipId),
      )
      .unique();
    if (!membership) return;

    // Remove this user from every channel in this workspace.
    const channelMemberships = await ctx.db
      .query("channelMembers")
      .withIndex("by_user_and_organization", (q) =>
        q
          .eq("userId", membership.userId)
          .eq("organizationId", membership.organizationId),
      )
      .take(256);
    for (const cm of channelMemberships) await ctx.db.delete(cm._id);

    await ctx.db.delete(membership._id);
  },
});
