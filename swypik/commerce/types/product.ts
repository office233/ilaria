/**
 * Shared Product types used across ChatInterface, ProductPage, and API routes.
 * Single source of truth — avoid duplicating product shapes.
 */

export type Product = {
  id: string;
  pgId?: number;
  aeProductId?: string;
  title: string;
  titleEn?: string;
  description: string;
  benefits: string[];
  dealLabel: string;
  whyBuy: string;
  warnings: string[];
  price: number;
  oldPrice: number;
  discountPercent: number;
  costUsd?: number;
  rating: number;
  orders: number;
  deliveryDays: number;
  images: string[];
  video?: string;
  hasVideo?: boolean;
  category: string;
  categoryId?: number;
  gradient: string;
  qualityScore: number;
  viewers?: number;
  cartAdds?: number;
  likes?: number;
  commentCount?: number;
  socialProofLabel?: string;
  commerceBadge?: string;
  isEstimatedSocial?: boolean;
  variantId?: string;
  skuId?: string;
  videoId?: string;
  /** UUID-ul clipului sursă — necesar pentru like-uri persistente din feed. */
  video_id?: string;
  /** Viewerul curent a apreciat deja clipul (seed pentru starea inimii). */
  viewerLiked?: boolean;
  selectedColor?: string;
  selectedSize?: string;
  vendor?: string;
  tags?: string;
  shipFree?: boolean;
  shipMethod?: string;
  shipDaysMin?: number;
  shipDaysMax?: number;
  variantsCount?: number;
  hasValidPrice?: boolean;
};
