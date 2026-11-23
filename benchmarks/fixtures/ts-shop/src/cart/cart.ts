import { applyDiscount, type Discount } from './pricing';
import type { Product } from '../api/client';

export interface CartLine {
  product: Product;
  quantity: number;
}

export class Cart {
  private lines: CartLine[] = [];

  add(product: Product, quantity = 1): void {
    const existing = this.lines.find((l) => l.product.id === product.id);
    if (existing) existing.quantity += quantity;
    else this.lines.push({ product, quantity });
  }

  remove(productId: string): void {
    this.lines = this.lines.filter((l) => l.product.id !== productId);
  }

  total(discount?: Discount): number {
    const sum = this.lines.reduce((acc, l) => acc + l.product.priceCents * l.quantity, 0);
    return discount ? applyDiscount(sum, discount) : sum;
  }

  get items(): readonly CartLine[] {
    return this.lines;
  }
}
