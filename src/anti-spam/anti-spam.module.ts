import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { DatabaseModule } from "../database/database.module";
import { AntiSpamService } from "./anti-spam.service";
import { SpamLog } from "./spam-log.entity";

@Module({
  imports: [DatabaseModule, TypeOrmModule.forFeature([SpamLog], "audit")],
  providers: [AntiSpamService],
  exports: [AntiSpamService],
})
export class AntiSpamModule {}
