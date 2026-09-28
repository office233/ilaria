/** Tipurile și căile fișierelor sellerului — fără dependențe de server (importabil și în client). */
export const SELLER_FILE_KINDS = ["invoice_pdf", "invoice_xml", "pos_receipt", "awb_label"] as const;
export type SellerFileKind = (typeof SELLER_FILE_KINDS)[number];

/** Calea API a fișierului (fără token). */
export function sellerFilePath(kind: SellerFileKind, id: string): string {
  const enc = encodeURIComponent(id);
  switch (kind) {
    case "invoice_pdf":
      return `/api/seller/invoices/${enc}/pdf`;
    case "invoice_xml":
      return `/api/seller/invoices/${enc}/efactura`;
    case "pos_receipt":
      return `/api/seller/pos/sales/${enc}/receipt`;
    case "awb_label":
      return `/api/seller/orders/${enc}/awb/pdf`;
  }
}
