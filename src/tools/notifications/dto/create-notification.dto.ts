import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

import { NotificationType } from "../../../common/enums/domain.enums";

export class CreateNotificationDto {
  @ApiProperty()
  @IsUUID()
  userId!: string;

  @ApiProperty({ maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title!: string;

  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  message!: string;

  @ApiPropertyOptional({ enum: NotificationType })
  @IsOptional()
  @IsIn([
    NotificationType.INFO,
    NotificationType.SUCCESS,
    NotificationType.WARNING,
    NotificationType.ERROR,
  ])
  type?: NotificationType;
}
