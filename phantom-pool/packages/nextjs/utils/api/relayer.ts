const RELAY_API_URL = process.env.NEXT_PUBLIC_RELAY_API_URL || 'http://localhost:3001';

export interface OrderPayload {
  commitment: string;
  direction: number;
  price: string;
  amount: string;
  nonce: string;
  traderAddress: string;
  tongoPublicKey: string;
}

export async function submitOrderToRelay(payload: OrderPayload) {
  const res = await fetch(`${RELAY_API_URL}/order`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const error = await res.json();
    throw new Error(`Failed to submit order to relayer: ${JSON.stringify(error)}`);
  }

  return await res.json();
}

export async function getActiveOrders() {
  const res = await fetch(`${RELAY_API_URL}/orders`);
  if (!res.ok) throw new Error("Failed to fetch active orders");
  return await res.json();
}

export async function submitSettlementPayloadToRelay(matchId: string, role: "buyer" | "seller", calldata: string[]) {
  const res = await fetch(`${RELAY_API_URL}/matches/${matchId}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role, calldata }),
  });

  if (!res.ok) {
    const error = await res.json();
    throw new Error(`Failed to submit settlement payload: ${JSON.stringify(error)}`);
  }

  return await res.json();
}
