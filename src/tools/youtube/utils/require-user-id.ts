import { BadRequestException } from "@nestjs/common";

export function requireUserId(userId?: string): string {
  if (!userId) {
    throw new BadRequestException("userId is required");
  }
  return userId;
}
