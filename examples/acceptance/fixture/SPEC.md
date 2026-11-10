# Quantity parser contract

`parseQuantity(input)` is a named export from `src/quantity.mjs`.

- Accept strings only. Trim surrounding whitespace.
- The trimmed string must match `^-?[0-9]+$`: decimal whole integers only.
  Leading zeros are allowed; a leading plus sign is not.
- Return a JavaScript safe integer greater than or equal to zero.
- Zero, including `"0"`, `"000"`, and `"-0"`, is allowed and returns positive zero.
- Reject every negative integer with `RangeError`.
- Reject integers outside JavaScript's safe integer range with `RangeError`.
- Reject nonstrings, empty strings, fractional numbers, exponent notation,
  and trailing junk with `TypeError`.
- Keep the existing specification, test file, and package script unchanged.

The initial implementation intentionally accepts negative integers. A failing
negative regression in the initial checkout is expected; it is the task to fix.
