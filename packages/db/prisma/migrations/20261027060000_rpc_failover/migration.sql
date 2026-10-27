-- AlterTable
ALTER TABLE "NetworkConfig" ADD COLUMN     "fallbackRpcUrls" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "NetworkState" ADD COLUMN     "activeRpcUrl" TEXT;

