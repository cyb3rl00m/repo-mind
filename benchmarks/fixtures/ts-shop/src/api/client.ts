export interface Product {
  id: string;
  name: string;
  priceCents: number;
}

const BASE_URL = 'https://shop.example.com/api';

export async function fetchProducts(): Promise<Product[]> {
  const res = await fetch(`${BASE_URL}/products`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Product[];
}
