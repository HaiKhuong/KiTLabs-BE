import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsArray, IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { FilmPushPlatform } from "../../entities/film.entities";

export class RegisterPushTokenDto {
  @ApiProperty({ description: "FCM registration token from client" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  token!: string;

  @ApiPropertyOptional({ enum: FilmPushPlatform, default: FilmPushPlatform.WEB })
  @IsOptional()
  @IsEnum(FilmPushPlatform)
  platform?: FilmPushPlatform;
}

export class UnregisterPushTokenDto {
  @ApiProperty({ description: "FCM registration token to deactivate" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  token!: string;
}

export class SendFilmPushNotificationDto {
  @ApiProperty({ description: "Notification title" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @ApiProperty({ description: "Notification body content" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  content!: string;

  @ApiPropertyOptional({ default: "SYSTEM" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  type?: string;

  @ApiPropertyOptional({ description: "Relative or absolute URL opened when clicking notification" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  actionUrl?: string;

  @ApiPropertyOptional({ description: "Target user IDs; omit or empty to broadcast to all active tokens", type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  userIds?: string[];

  @ApiPropertyOptional({ description: "Whether to also dispatch FCM push notification", default: true })
  @IsOptional()
  @IsBoolean()
  sendPush?: boolean;
}
