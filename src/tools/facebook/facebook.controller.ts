import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Put, Query, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Response } from "express";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { isAppPlatform } from "../../common/desktop/request-platform";
import {
  CreateFacebookPostDto,
  FacebookPostQueryDto,
  FacebookTaskQueryDto,
  SaveCommentSettingsDto,
  UpdateFacebookPostDto,
  UpsertAffiliateLinkDto,
} from "./facebook.types";
import { FacebookService } from "./facebook.service";

type AuthUser = { userId: string };

@ApiTags("Facebook")
@ApiBearerAuth("bearer")
@Controller("facebook")
export class FacebookController {
  constructor(private readonly service: FacebookService) {}

  @Get("connection")
  connection(@CurrentUser() user: AuthUser) {
    this.desktopOnly();
    return this.service.connection(user.userId);
  }

  @Post("connect")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  connect(@CurrentUser() user: AuthUser) {
    this.desktopOnly();
    return this.service.connect(user.userId);
  }

  @Public()
  @Get("callback")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async callback(
    @Query("state") state: string | undefined,
    @Query("code") code: string | undefined,
    @Query("error") error: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    try {
      const completed = await this.service.completeOAuth({ state, code, error });
      response.redirect(302, `kitlabs://oauth/facebook?status=success&ticket=${encodeURIComponent(completed.ticket)}`);
    } catch {
      response.redirect(302, "kitlabs://oauth/facebook?status=error");
    }
  }

  @Public()
  @Post("handoff/redeem")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  redeemHandoff(@Body("ticket") ticket: string) {
    return this.service.redeemHandoff(ticket);
  }

  @Post("handoff/import")
  importHandoff(@CurrentUser() user: AuthUser, @Body() body: { apiServerUrl: string; ticket: string }) {
    this.desktopOnly();
    return this.service.importHandoff(user.userId, body.apiServerUrl, body.ticket);
  }

  @Post("disconnect")
  disconnect(@CurrentUser() user: AuthUser) {
    this.desktopOnly();
    return this.service.disconnect(user.userId);
  }

  @Post("connection/check")
  check(@CurrentUser() user: AuthUser) {
    this.desktopOnly();
    return this.service.checkConnection(user.userId);
  }

  @Get("posts")
  posts(@CurrentUser() user: AuthUser, @Query() query: FacebookPostQueryDto) {
    this.desktopOnly();
    return this.service.listPosts(user.userId, query);
  }

  @Post("posts")
  createPost(@CurrentUser() user: AuthUser, @Body() dto: CreateFacebookPostDto) {
    this.desktopOnly();
    return this.service.createPost(user.userId, dto);
  }

  @Patch("posts/:id")
  updatePost(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: UpdateFacebookPostDto) {
    this.desktopOnly();
    return this.service.updatePost(user.userId, id, dto);
  }

  @Post("posts/:id/duplicate")
  duplicate(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    this.desktopOnly();
    return this.service.duplicatePost(user.userId, id);
  }

  @Post("posts/:id/cancel")
  cancel(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    this.desktopOnly();
    return this.service.cancelPost(user.userId, id);
  }

  @Post("posts/:id/republish")
  republish(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    this.desktopOnly();
    return this.service.republishPost(user.userId, id);
  }

  @Get("affiliate-links")
  affiliateLinks(@CurrentUser() user: AuthUser) {
    this.desktopOnly();
    return this.service.listAffiliateLinks(user.userId);
  }

  @Post("affiliate-links")
  createAffiliate(@CurrentUser() user: AuthUser, @Body() dto: UpsertAffiliateLinkDto) {
    this.desktopOnly();
    return this.service.createAffiliateLink(user.userId, dto);
  }

  @Patch("affiliate-links/:id")
  updateAffiliate(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: UpsertAffiliateLinkDto) {
    this.desktopOnly();
    return this.service.updateAffiliateLink(user.userId, id, dto);
  }

  @Delete("affiliate-links/:id")
  deleteAffiliate(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    this.desktopOnly();
    return this.service.deleteAffiliateLink(user.userId, id);
  }

  @Get("comment-settings")
  commentSettings(@CurrentUser() user: AuthUser) {
    this.desktopOnly();
    return this.service.getCommentSettings(user.userId);
  }

  @Put("comment-settings")
  saveCommentSettings(@CurrentUser() user: AuthUser, @Body() dto: SaveCommentSettingsDto) {
    this.desktopOnly();
    return this.service.saveCommentSettings(user.userId, dto);
  }

  @Get("tasks")
  tasks(@CurrentUser() user: AuthUser, @Query() query: FacebookTaskQueryDto) {
    this.desktopOnly();
    return this.service.listTasks(user.userId, query);
  }

  private desktopOnly(): void {
    if (!isAppPlatform()) throw new ForbiddenException("Facebook Publisher chỉ có trên KiTLabs Desktop");
  }
}
