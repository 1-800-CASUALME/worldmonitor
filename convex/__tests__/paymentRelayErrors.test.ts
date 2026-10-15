import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PRODUCT_CATALOG } from "../config/productCatalog";
import { createDodoCheckoutSession } from "../lib/dodo";
import { signDunningPortalToken } from "../lib/identitySigning";
import schema from "../schema";

vi.mock("../lib/dodo", () => ({
  CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS: 3_500,
  createDodoCheckoutSession: vi.fn(),
}));

const { portalCreate } = vi.hoisted(() => ({ portalCreate: vi.fn() }));
vi.mock("dodopayments", async (importOriginal) => ({
  ...await importOriginal<typeof import("dodopayments")>(),
  DodoPayments: class {
    customers = { customerPortal: { create: portalCreate } };
  },
}));

const modules = import.meta.glob("../**/*.ts");
const userId = "user_relay_errors";

beforeEach(() => {
  vi.stubEnv("CONVEX_TENANT_RELAY_SECRET", "synthetic-relay-secret");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(createDodoCheckoutSession).mockReset();
  portalCreate.mockReset();
  vi.unstubAllEnvs();
});

function post(t: ReturnType<typeof convexTest>, path: string) {
  return t.fetch(path, {
    method: "POST",
    headers: { Authorization: "Bearer synthetic-relay-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ userId, productId: PRODUCT_CATALOG.pro_monthly.dodoProductId! }),
  });
}

test.each([
  new Error("provider payload: customer cus_private; internal stack"),
  "provider payload: customer cus_private",
])("checkout hides unexpected failures and logs them server-side: %s", async (error) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(createDodoCheckoutSession).mockRejectedValue(error);
  const response = await post(convexTest(schema, modules), "/relay/create-checkout");
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "Operation failed" });
  expect(log).toHaveBeenCalledWith("[create-checkout] Operation failed", expect.anything());
});

test("portal hides unexpected configuration failures and logs them server-side", async () => {
  vi.stubEnv("DODO_API_KEY", "");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const t = convexTest(schema, modules);
  await t.run((ctx) => ctx.db.insert("customers", {
    userId, dodoCustomerId: "cus_private", email: "buyer@example.test", createdAt: 1, updatedAt: 1,
  }));
  const response = await post(t, "/relay/customer-portal");
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "Operation failed" });
  expect(log).toHaveBeenCalledWith("[customer-portal] Operation failed", expect.anything());
});

test("portal maps missing customers to a stable 404", async () => {
  const response = await post(convexTest(schema, modules), "/relay/customer-portal");
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "NO_CUSTOMER" });
});

test("portal token mints a session for the signed user", async () => {
  vi.stubEnv("DODO_API_KEY", "synthetic-api-key");
  vi.stubEnv("DODO_IDENTITY_SIGNING_SECRET", "synthetic-dunning-portal-secret");
  const t = convexTest(schema, modules);
  await t.run((ctx) => ctx.db.insert("customers", {
    userId, dodoCustomerId: "cus_token", email: "buyer@example.test", createdAt: 1, updatedAt: 1,
  }));
  portalCreate.mockResolvedValue({ link: "https://customer.dodopayments.com/session/token" });
  const portalToken = await signDunningPortalToken(userId, Date.now());
  const response = await t.fetch("/relay/customer-portal", {
    method: "POST",
    headers: { Authorization: "Bearer synthetic-relay-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ portalToken }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ portal_url: "https://customer.dodopayments.com/session/token" });
  expect(portalCreate).toHaveBeenCalledWith("cus_token", { send_email: false });
});

test("portal token that fails verification is 401", async () => {
  const t = convexTest(schema, modules);
  const response = await t.fetch("/relay/customer-portal", {
    method: "POST",
    headers: { Authorization: "Bearer synthetic-relay-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ portalToken: "v1.user_x.1.not-a-signature" }),
  });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "INVALID_PORTAL_TOKEN" });
});

test("portal provider failures stay server-side and a later request can recover", async () => {
  vi.stubEnv("DODO_API_KEY", "synthetic-api-key");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const t = convexTest(schema, modules);
  await t.run((ctx) => ctx.db.insert("customers", {
    userId, dodoCustomerId: "cus_private", email: "buyer@example.test", createdAt: 1, updatedAt: 1,
  }));
  portalCreate.mockRejectedValueOnce(new Error("private provider payload"))
    .mockResolvedValueOnce({ link: "https://billing.example.test/session" });
  const failure = await post(t, "/relay/customer-portal");
  expect(failure.status).toBe(500);
  expect(await failure.json()).toEqual({ error: "Operation failed" });
  expect(log).toHaveBeenCalledWith(expect.stringContaining("cus_private"), "private provider payload");
  expect(log).toHaveBeenCalledWith("[customer-portal] Operation failed", expect.anything());
  const recovery = await post(t, "/relay/customer-portal");
  expect(recovery.status).toBe(200);
  expect(await recovery.json()).toEqual({ portal_url: "https://billing.example.test/session" });
});
