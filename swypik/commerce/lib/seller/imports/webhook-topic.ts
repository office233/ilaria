import type { CatalogProvider } from "./types";

export type WebhookResource = "product" | "customer" | "order";
export type WebhookAction = "create" | "update" | "delete";

export type ParsedWebhookTopic = {
  resource: WebhookResource;
  action: WebhookAction;
};

export function parseWebhookTopic(
  provider: CatalogProvider,
  rawTopic: string,
): ParsedWebhookTopic | null {
  const topic = rawTopic.trim().toLowerCase();
  if (provider === "shopify") {
    if (topic === "refunds/create") return { resource: "order", action: "update" };
    const [plural, event] = topic.split("/");
    const resource =
      plural === "products" ? "product" :
      plural === "customers" ? "customer" :
      plural === "orders" ? "order" :
      null;
    if (!resource) return null;
    const action =
      event === "create" ? "create" :
      event === "delete" ? "delete" :
      ["update", "updated", "cancelled", "paid", "fulfilled"].includes(event)
        ? "update"
        : null;
    return action ? { resource, action } : null;
  }

  const [resourceRaw, event] = topic.split(".");
  const resource =
    resourceRaw === "product" ? "product" :
    resourceRaw === "customer" ? "customer" :
    resourceRaw === "order" ? "order" :
    null;
  if (!resource) return null;
  const action =
    event === "created" ? "create" :
    event === "updated" ? "update" :
    event === "deleted" ? "delete" :
    null;
  return action ? { resource, action } : null;
}

export function externalIdFromWebhookPayload(
  provider: CatalogProvider,
  topic: ParsedWebhookTopic,
  payload: unknown,
  rawTopic: string,
): string | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  const source =
    obj[topic.resource] && typeof obj[topic.resource] === "object"
      ? obj[topic.resource] as Record<string, unknown>
      : obj;

  let rawId: unknown = source.id;
  if (provider === "shopify" && rawTopic.trim().toLowerCase() === "refunds/create") {
    rawId = source.order_id ?? obj.order_id;
  }
  if ((typeof rawId !== "string" && typeof rawId !== "number") || String(rawId).trim() === "") {
    return null;
  }
  const value = String(rawId).trim();
  if (provider !== "shopify" || value.startsWith("gid://shopify/")) return value;
  const kind =
    topic.resource === "product" ? "Product" :
    topic.resource === "customer" ? "Customer" :
    "Order";
  return `gid://shopify/${kind}/${value}`;
}
