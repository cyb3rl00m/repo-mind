import { Cart } from '../cart/cart';
import { formatPrice } from '../cart/pricing';

export function CartView({ cart }: { cart: Cart }) {
  return (
    <ul>
      {cart.items.map((l) => (
        <li key={l.product.id}>
          {l.product.name} × {l.quantity} — {formatPrice(l.product.priceCents * l.quantity)}
        </li>
      ))}
      <li>Total: {formatPrice(cart.total())}</li>
    </ul>
  );
}
