import { createParamDecorator, ExecutionContext } from "@nestjs/common";

type AuthUser = {
  userId: string;
  userName: string;
};

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser | undefined => {
  const req = ctx.switchToHttp().getRequest();
  return req.user as AuthUser | undefined;
});
