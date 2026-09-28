/** Client-safe types for the News admin (shared by the API and /admin/news). */
export const ADMIN_NEWS_STATUSES = ["draft", "published", "archived"] as const;
export type AdminNewsStatus = (typeof ADMIN_NEWS_STATUSES)[number];

export type AdminNewsRow = {
  id: string;
  slug: string;
  title: string;
  summary_tldr: string;
  status: AdminNewsStatus;
  category_slug: string;
  created_at: string;
  published_at: string;
  ai_model_name: string | null;
  source_name: string | null;
  source_url: string | null;
};
