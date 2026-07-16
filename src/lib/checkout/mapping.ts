// The checkout identity seam.
//
// Identity comes from POSITION, never a value lookup. Two cart items can
// share (templateSlug, variantSku) AND quantity — the same mug with two
// different photos. The original bug matched cart items to priced lines with
//   lines.find(x => x.variantSku === i.variantSku && x.quantity === i.quantity)
// Both mugs matched the first line, both order_items got the same design_id,
// and the customer paid for two and received the same photo twice. It
// typechecked, built, and passed every other test.
//
// The fix is index alignment: everywhere the checkout route derives one array
// from another (priced lines from items, design ids from items, Stripe
// line_items thumbnails from items), the arrays are built by .map over the
// SAME source, so position already IS identity. This helper is the only way
// those arrays are allowed to meet. The same bug existed three times —
// order_items, Stripe thumbnails, and the client's designBy map — which is
// why the zip lives in one place.

export function zipByPosition<A, B, T>(
  items: readonly A[],
  lines: readonly B[],
  zip: (item: A, line: B, index: number) => T,
): T[] {
  if (items.length !== lines.length) {
    // A length mismatch means somebody filtered or reordered one side.
    // Zipping anyway would pair item N with the wrong line — charge one
    // customer for another's design. Refuse loudly.
    throw new Error(
      `Positional identity broken: ${items.length} items but ${lines.length} lines. ` +
        `Derived arrays must be built by .map over the same source, never filtered.`,
    );
  }
  return items.map((item, i) => zip(item, lines[i] as B, i));
}
