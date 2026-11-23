import { describe, expect, it } from 'vitest';
import { Cart } from '../src/cart/cart';

describe('Cart', () => {
  it('sums lines', () => {
    const c = new Cart();
    c.add({ id: 'a', name: 'A', priceCents: 250 }, 2);
    expect(c.total()).toBe(500);
  });
});
