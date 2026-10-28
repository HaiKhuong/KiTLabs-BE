import { PlatformCredential } from "../../platform/entities/platform-credential.entity";
import { PlatformAccount } from "../../platform/entities/platform-account.entity";
import { PlatformFacebookPage } from "../../platform/entities/platform-facebook-page.entity";
import { PlatformUser } from "../../platform/entities/platform-user.entity";

export const MAIN_DB_ENTITIES = [
  PlatformUser,
  PlatformCredential,
  PlatformAccount,
  PlatformFacebookPage,
];
