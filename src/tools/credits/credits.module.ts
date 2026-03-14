import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { LogsModule } from "../logs/logs.module";
import { User } from "../users/user.entity";
import { CreditHistory } from "./credit-history.entity";
import { CreditsController } from "./credits.controller";
import { CreditsService } from "./credits.service";

@Module({
  imports: [TypeOrmModule.forFeature([User, CreditHistory], "tool"), LogsModule],
  controllers: [CreditsController],
  providers: [CreditsService],
  exports: [CreditsService, TypeOrmModule],
})
export class CreditsModule {}
