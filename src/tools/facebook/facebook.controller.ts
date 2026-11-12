import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { isAppPlatform } from "../../common/desktop/request-platform";
import {
  AssignVideoPlaylistDto,
  CommentOnVideoDto,
  CreateFacebookPostDto,
  CreatePlaylistDto,
  FacebookPlaylistQueryDto,
  FacebookPostQueryDto,
  FacebookTaskQueryDto,
  FacebookVideoQueryDto,
  SaveCommentSettingsDto,
  SavePageCommentSettingsDto,
  SyncFacebookVideosDto,
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

  @Post("posts/:id/sync-film")
  syncFilm(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    this.desktopOnly();
    return this.service.retryFilmSync(user.userId, id);
  }

  @Get("film/movies")
  filmMovies(@Query("q") q = "") {
    this.desktopOnly();
    return this.service.searchFilmMovies(q);
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

  @Post("sync-videos")
  syncVideos(@CurrentUser() user: AuthUser, @Body() dto: SyncFacebookVideosDto) {
    this.desktopOnly();
    return this.service.syncVideos(user.userId, dto.pageId);
  }

  @Get("videos")
  videos(@CurrentUser() user: AuthUser, @Query() query: FacebookVideoQueryDto) {
    this.desktopOnly();
    return this.service.listVideos(user.userId, query);
  }

  @Get("playlists")
  playlists(@CurrentUser() user: AuthUser, @Query() query: FacebookPlaylistQueryDto) {
    this.desktopOnly();
    return this.service.listPlaylists(user.userId, query);
  }

  @Post("playlists")
  createPlaylist(@CurrentUser() user: AuthUser, @Body() dto: CreatePlaylistDto) {
    this.desktopOnly();
    return this.service.createPlaylist(user.userId, dto);
  }

  @Post("videos/:id/playlist")
  assignPlaylist(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() dto: AssignVideoPlaylistDto,
  ) {
    this.desktopOnly();
    return this.service.assignVideoToPlaylist(user.userId, id, dto);
  }

  @Get("page-comment-settings")
  pageCommentSettings(@CurrentUser() user: AuthUser, @Query("pageId") pageId: string) {
    this.desktopOnly();
    return this.service.getPageCommentSettings(user.userId, pageId);
  }

  @Put("page-comment-settings")
  savePageCommentSettings(@CurrentUser() user: AuthUser, @Body() dto: SavePageCommentSettingsDto) {
    this.desktopOnly();
    return this.service.savePageCommentSettings(user.userId, dto);
  }

  @Post("videos/:id/comment")
  commentVideo(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() dto: CommentOnVideoDto,
  ) {
    this.desktopOnly();
    return this.service.commentOnVideo(user.userId, id, dto);
  }

  private desktopOnly(): void {
    if (!isAppPlatform()) throw new ForbiddenException("Facebook Publisher chỉ có trên KiTLabs Desktop");
  }
}
