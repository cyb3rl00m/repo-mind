export interface Discount {
  kind: 'percent' | 'fixed';
  value: number;
}

export function applyDiscount(totalCents: number, discount: Discount): number {
  if (discount.kind === 'percent') return Math.round(totalCents * (1 - discount.value / 100));
  return Math.max(0, totalCents - discount.value);
}

export function formatPrice(cents: number, currency = 'EUR'): string {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).format(cents / 100);
}
