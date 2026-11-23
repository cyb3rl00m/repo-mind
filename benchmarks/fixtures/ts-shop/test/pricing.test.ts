import { expect, it } from 'vitest';
import { applyDiscount } from '../src/cart/pricing';

it('applies percent discounts', () => {
  expect(applyDiscount(1000, { kind: 'percent', value: 10 })).toBe(900);
});
