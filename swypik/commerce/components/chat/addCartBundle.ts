/** Each request must finish before the next so a new anonymous cart cookie is reused. */
export async function addCartBundle<T>(products: readonly T[], add: (product: T) => Promise<boolean>): Promise<boolean> {
  if (products.length === 0) return false;
  for (const product of products) {
    if (!await add(product)) return false;
  }
  return true;
}
