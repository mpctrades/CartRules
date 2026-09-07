-- CreateTable
CREATE TABLE "RuleEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "ruleTitle" TEXT NOT NULL,
    "ruleType" TEXT NOT NULL,
    "productId" TEXT,
    "productTitle" TEXT,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "RuleEvent_shop_createdAt_idx" ON "RuleEvent"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "RuleEvent_shop_ruleId_idx" ON "RuleEvent"("shop", "ruleId");
