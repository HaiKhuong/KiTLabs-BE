import { PlatformCredential } from "../../platform/entities/platform-credential.entity";
import { PlatformAccount } from "../../platform/entities/platform-account.entity";
import { PlatformFacebookPage } from "../../platform/entities/platform-facebook-page.entity";
import { PlatformUser } from "../../platform/entities/platform-user.entity";
import { PlatformAdminRole } from "../../platform/entities/platform-admin-role.entity";
import { PlatformAdminUser } from "../../platform/entities/platform-admin-user.entity";
import { PlatformDesktopDevice } from "../../platform/entities/desktop-device.entity";

export const MAIN_DB_ENTITIES = [
  PlatformUser,
  PlatformCredential,
  PlatformAccount,
  PlatformFacebookPage,
  PlatformAdminRole,
  PlatformAdminUser,
  PlatformDesktopDevice,
];
