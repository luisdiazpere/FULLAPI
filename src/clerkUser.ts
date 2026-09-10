export type ClerkUser = {
  primary_email_address_id: string | null;
  email_addresses: { id: string; email_address: string }[];
};

/** Falls back to the first address if Clerk hasn't picked a primary one yet. */
export function primaryEmail(user: ClerkUser): string | null {
  const byId = user.email_addresses.find((a) => a.id === user.primary_email_address_id);
  return (byId ?? user.email_addresses[0])?.email_address ?? null;
}
