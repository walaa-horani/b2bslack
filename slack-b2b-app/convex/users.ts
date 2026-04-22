import { mutation } from "./_generated/server";
import { ensureUser as ensureUserHelper } from "./auth";

/**
 * Called once by the client after sign-in to guarantee a Convex user row
 * exists before any other query or mutation runs. Idempotent.
 */
export const ensureUser = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await ensureUserHelper(ctx);
    return { _id: user._id, email: user.email, name: user.name };
  },
});
