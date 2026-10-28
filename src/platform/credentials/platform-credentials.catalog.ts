export type PlatformCredentialDef = {
  provider: "facebook" | "tiktok";
  code: string;
  isSecret: boolean;
  label: string;
  defaultValue?: string;
};

export const PLATFORM_CREDENTIAL_CATALOG: PlatformCredentialDef[] = [
  { provider: "facebook", code: "META_APP_ID", isSecret: false, label: "Meta App ID" },
  { provider: "facebook", code: "META_APP_SECRET", isSecret: true, label: "Meta App Secret" },
  { provider: "facebook", code: "META_REDIRECT_URI", isSecret: false, label: "Facebook Redirect URI" },
  { provider: "facebook", code: "META_SCOPES", isSecret: false, label: "Facebook Scopes", defaultValue: "pages_show_list,pages_read_engagement,pages_manage_posts,publish_video" },
  { provider: "facebook", code: "META_GRAPH_VERSION", isSecret: false, label: "Facebook Graph Version", defaultValue: "v21.0" },
  
  { provider: "tiktok", code: "TIKTOK_CLIENT_KEY", isSecret: false, label: "TikTok Client Key" },
  { provider: "tiktok", code: "TIKTOK_CLIENT_SECRET", isSecret: true, label: "TikTok Client Secret" },
  { provider: "tiktok", code: "TIKTOK_REDIRECT_URI", isSecret: false, label: "TikTok Redirect URI" },
  { provider: "tiktok", code: "TIKTOK_SCOPES", isSecret: false, label: "TikTok Scopes", defaultValue: "user.info.basic,video.publish,video.list" },
];

