type DisplayAccount = { alias?: string; email?: string | null; accountId: string }

/** Local presentation only. Never use this label as an account or routing identity. */
export function accountDisplayName(account: DisplayAccount): string {
  return account.alias?.trim() || account.email || account.accountId
}
