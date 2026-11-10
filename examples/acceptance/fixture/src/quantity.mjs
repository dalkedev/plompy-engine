export function parseQuantity(input) {
  if (typeof input !== "string" || !/^-?[0-9]+$/.test(input.trim())) {
    throw new TypeError("Quantity must be a decimal integer string.");
  }
  const quantity = Number(input.trim());
  if (!Number.isSafeInteger(quantity)) {
    throw new RangeError("Quantity must be a safe integer.");
  }
  // The fixture deliberately omits negative validation. Follow SPEC.md.
  return quantity === 0 ? 0 : quantity;
}
