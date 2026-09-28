/** Un „post” din feed-ul social de pe home: o ofertă cu poză mare. */
export type OfferPost = {
    id: string;
    title: string;
    image: string;
    price: number;
    oldPrice: number;
    discountPercent: number;
    currency: string;
    rating: number;
    orders: number;
    brand: string;
    category: string;
    categoryId?: number;
    shipFree: boolean;
    likeCount: number;
    shareCount: number;
    viewerLiked: boolean;
    /** Bifa albastră — seller verificat (firmă validată manual). */
    sellerVerified?: boolean;
    sellerId?: string | null;
};

export type OffersFeedResponse = {
    items: OfferPost[];
    nextOffset: number;
    hasMore: boolean;
};

export type OffersSort = "popular" | "new" | "discount";
