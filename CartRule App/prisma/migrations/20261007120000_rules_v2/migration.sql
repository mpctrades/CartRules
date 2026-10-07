-- CreateTable
CREATE TABLE "ShopState" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "nextScheduleAt" DATETIME,
    "lastWeeklySummary" DATETIME,
    "lastHealthCheck" DATETIME,
    "lastIssueKey" TEXT,
    "remindedRuleIds" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_RuleEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL DEFAULT '',
    "ruleId" TEXT NOT NULL,
    "ruleTitle" TEXT NOT NULL,
    "ruleType" TEXT NOT NULL,
    "eventType" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'order',
    "productId" TEXT,
    "productTitle" TEXT,
    "attempted" REAL,
    "allowed" REAL,
    "cartKey" TEXT,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_RuleEvent" ("createdAt", "detail", "id", "orderId", "productId", "productTitle", "ruleId", "ruleTitle", "ruleType", "shop") SELECT "createdAt", "detail", "id", "orderId", "productId", "productTitle", "ruleId", "ruleTitle", "ruleType", "shop" FROM "RuleEvent";
DROP TABLE "RuleEvent";
ALTER TABLE "new_RuleEvent" RENAME TO "RuleEvent";
CREATE INDEX "RuleEvent_shop_createdAt_idx" ON "RuleEvent"("shop", "createdAt");
CREATE INDEX "RuleEvent_shop_ruleId_idx" ON "RuleEvent"("shop", "ruleId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

