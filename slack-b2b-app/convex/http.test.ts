/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { Webhook } from "svix";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const SECRET = "whsec_testsecretvalue00000000000000000000000000";
const ISSUER = "https://awaited-boxer-54.clerk.accounts.dev";

function signHeaders(body: string) {
  const wh = new Webhook(SECRET);
  const msgId = "msg_" + Math.random().toString(36).slice(2);
  const signature = wh.sign(msgId, new Date(), body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return {
    "svix-id": msgId,
    "svix-timestamp": timestamp,
    "svix-signature": signature,
  };
}

function setEnv(t: ReturnType<typeof convexTest>) {
  // convex-test exposes env via ctx.runWithEnv or by setting process.env.
  // convex-test reads from process.env at function time, so set there.
  process.env.CLERK_WEBHOOK_SECRET = SECRET;
  process.env.CLERK_JWT_ISSUER_DOMAIN = ISSUER;
}

async function postWebhook(
  t: ReturnType<typeof convexTest>,
  body: string,
  headers: Record<string, string>,
) {
  return await t.fetch("/clerk-webhook", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("rejects missing Svix headers with 400", async () => {
  const t = convexTest(schema, modules);
  setEnv(t);
  const res = await postWebhook(t, "{}", {});
  expect(res.status).toBe(400);
});

test("rejects tampered body with 400", async () => {
  const t = convexTest(schema, modules);
  setEnv(t);
  const body = JSON.stringify({
    type: "user.created",
    data: {
      id: "user_abc",
      email_addresses: [{ email_address: "jane@example.com" }],
    },
  });
  const headers = signHeaders(body);
  const res = await postWebhook(t, body + "tampered", headers);
  expect(res.status).toBe(400);
});

test("accepts a valid user.created event and creates a user row", async () => {
  const t = convexTest(schema, modules);
  setEnv(t);
  const body = JSON.stringify({
    type: "user.created",
    data: {
      id: "user_abc",
      email_addresses: [{ email_address: "jane@example.com" }],
      first_name: "Jane",
      last_name: "Doe",
    },
  });
  const res = await postWebhook(t, body, signHeaders(body));
  expect(res.status).toBe(200);

  const users = await t.run(
    async (ctx) => await ctx.db.query("users").collect(),
  );
  expect(users).toHaveLength(1);
  expect(users[0].email).toBe("jane@example.com");
  expect(users[0].tokenIdentifier).toBe(`${ISSUER}|user_abc`);
});
