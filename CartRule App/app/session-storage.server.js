import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";

// With future.expiringOfflineAccessTokens (shopify.server.js), offline access
// tokens expire after about an hour and are renewed with the refresh token
// Shopify issues alongside them. The installed PrismaSessionStorage (6.x)
// doesn't persist refreshToken/refreshTokenExpires, so a stored offline
// session could never be renewed: everything that runs outside the embedded
// admin — the products/* and collections/* webhooks that keep tag and
// collection rules in sync — got a 401 from the Admin API once the merchant
// hadn't opened the app for an hour. (Admin pages were unaffected: each one
// does a fresh token exchange.) The storage versions that do persist these
// fields require a newer @shopify/shopify-api, so add just the two columns.
export class RefreshingPrismaSessionStorage extends PrismaSessionStorage {
  sessionToRow(session) {
    return {
      ...super.sessionToRow(session),
      refreshToken: session.refreshToken || null,
      refreshTokenExpires: session.refreshTokenExpires || null,
    };
  }

  rowToSession(row) {
    const session = super.rowToSession(row);
    if (row.refreshToken) session.refreshToken = row.refreshToken;
    if (row.refreshTokenExpires) session.refreshTokenExpires = row.refreshTokenExpires;
    return session;
  }
}
