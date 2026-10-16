export enum FacebookAccountStatus {
  CONNECTED = "connected",
  EXPIRED = "expired",
  REVOKED = "revoked",
  MISSING_PERMISSION = "missing_permission",
}

export enum FacebookPageStatus {
  ACTIVE = "active",
  LOST_ACCESS = "lost_access",
}

export enum FacebookContentKind {
  VIDEO = "video",
  REEL = "reel",
  POST = "post",
  PHOTO = "photo",
}

export enum FacebookPostStatus {
  DRAFT = "draft",
  SCHEDULED = "scheduled",
  PUBLISHING = "publishing",
  PUBLISHED = "published",
  FAILED = "failed",
  CANCELLED = "cancelled",
  BLOCKED = "blocked",
  NEEDS_REVIEW = "needs_review",
}

export enum FacebookUploadPhase {
  NONE = "none",
  STARTED = "started",
  UNCERTAIN = "uncertain",
  CONFIRMED = "confirmed",
}

export enum FacebookAffiliateStatus {
  ACTIVE = "active",
  PAUSED = "paused",
}

export enum FacebookSelectionRule {
  RANDOM = "random",
  SEQUENTIAL = "sequential",
  GROUP = "group",
}

export enum FacebookTaskKind {
  PUBLISH = "publish",
  COMMENT = "comment",
  PERMISSION_CHECK = "permission_check",
}

export enum FacebookTaskOutcome {
  SUCCESS = "success",
  FAILED = "failed",
  SKIPPED_DUPLICATE = "skipped_duplicate",
  NEEDS_REVIEW = "needs_review",
}

export const FACEBOOK_REQUIRED_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "pages_manage_engagement",
] as const;

export const FACEBOOK_PUBLISH_QUEUE = "facebook-publish";
