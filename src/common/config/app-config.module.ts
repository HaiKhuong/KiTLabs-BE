import { Global, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { Setting } from "../../tools/settings/setting.entity";
import { AppConfigService } from "./app-config.service";

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Setting], "tool")],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
