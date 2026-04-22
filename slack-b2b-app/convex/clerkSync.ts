import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

// ---------- user ----------

const userData = v.object({
  id: v.string(),
  email_addresses: v.array(v.object({ email_address: v.string() })),
  first_name: v.optional(v.union(v.string(), v.null())),
  last_name: v.optional(v.union(v.string(), v.null())),
  image_url: v.optional(v.union(v.string(), v.null())),
});

function fullName(first?: string | null, last?: string | null): string | undefined {
  const joined = [first, last].filter(Boolean).join(" ").trim();
  return joined || undefined;
}

export const upsertUser = internalMutation({
  args: { data: userData, issuerDomain: v.string() },
  handler: async (ctx, { data, issuerDomain }) => {
    const tokenIdentifier = `${issuerDomain}|${data.id}`;
    const email = data.email_addresses[0]?.email_address ?? "";
    const name = fullName(data.first_name, data.last_name);
    const imageUrl = data.image_url ?? undefined;

    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", data.id))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { email, name, imageUrl, tokenIdentifier });
      return existing._id;
    }
    return await ctx.db.insert("users", {
      clerkUserId: data.id,
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

const organizationData = v.object({
  id: v.string(),
  slug: v.string(),
  name: v.string(),
  image_url: v.optional(v.union(v.string(), v.null())),
});

export const upsertOrganization = internalMutation({
  args: { data: organizationData },
  handler: async (ctx, { data }) => {
    const imageUrl = data.image_url ?? undefined;

    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", data.id))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        slug: data.slug,
        name: data.name,
        imageUrl,
      });
      return existing._id;
    }
    return await ctx.db.insert("organizations", {
      clerkOrgId: data.id,
      slug: data.slug,
      name: data.name,
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

const membershipData = v.object({
  id: v.string(),
  organization: v.object({ id: v.string() }),
  public_user_data: v.object({ user_id: v.string() }),
  role: v.string(),
});

const MAX_MEMBERSHIP_RETRIES = 5;

export const upsertMembership = internalMutation({
  args: { data: membershipData, attempts: v.number() },
  handler: async (ctx, { data, attempts }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_user_id", (q) =>
        q.eq("clerkUserId", data.public_user_data.user_id),
      )
      .unique();
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org_id", (q) =>
        q.eq("clerkOrgId", data.organization.id),
      )
      .unique();

    // Out-of-order webhook: parent rows not yet present. Re-schedule up to 5 times.
    if (!user || !org) {
      if (attempts >= MAX_MEMBERSHIP_RETRIES) {
        console.error(
          `upsertMembership giving up on ${data.id} after ${attempts} attempts: user=${!!user} org=${!!org}`,
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

    const existing = await ctx.db
      .query("memberships")
      .withIndex("by_clerk_membership_id", (q) =>
        q.eq("clerkMembershipId", data.id),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { role: data.role });
      return existing._id;
    }
    return await ctx.db.insert("memberships", {
      userId: user._id,
      organizationId: org._id,
      clerkMembershipId: data.id,
      role: data.role,
    });
  },
});

export const deleteMembership = internalMutation({
  args: { clerkMembershipId: v.string() },
  handler: async (ctx, { clerkMembershipId }) => {
    const m = await ctx.db
      .query("memberships")
      .withIndex("by_clerk_membership_id", (q) =>
        q.eq("clerkMembershipId", clerkMembershipId),
      )
      .unique();
    if (m) await ctx.db.delete(m._id);
  },
});
