import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    clerkUserId: v.string(),
    tokenIdentifier: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
  })
    .index("by_clerk_user_id", ["clerkUserId"])
    .index("by_token_identifier", ["tokenIdentifier"]),

  organizations: defineTable({
    clerkOrgId: v.string(),
    slug: v.string(),
    name: v.string(),
    imageUrl: v.optional(v.string()),
  })
    .index("by_clerk_org_id", ["clerkOrgId"])
    .index("by_slug", ["slug"]),

  memberships: defineTable({
    userId: v.id("users"),
    organizationId: v.id("organizations"),
    clerkMembershipId: v.string(),
    role: v.string(),
  })
    .index("by_user", ["userId"])
    .index("by_organization", ["organizationId"])
    .index("by_user_and_organization", ["userId", "organizationId"])
    .index("by_clerk_membership_id", ["clerkMembershipId"]),

  channels: defineTable({
    organizationId: v.id("organizations"),
    slug: v.string(),
    name: v.string(),
    createdBy: v.id("users"),
    isProtected: v.boolean(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_slug", ["organizationId", "slug"]),

  channelMembers: defineTable({
    channelId: v.id("channels"),
    userId: v.id("users"),
    organizationId: v.id("organizations"),
  })
    .index("by_channel", ["channelId"])
    .index("by_user_and_channel", ["userId", "channelId"])
    .index("by_user_and_organization", ["userId", "organizationId"]),

  messages: defineTable({
    channelId: v.id("channels"),
    userId: v.id("users"),
    text: v.string(),
    deletedAt: v.optional(v.number()),
  })
    .index("by_channel", ["channelId"]),
});
