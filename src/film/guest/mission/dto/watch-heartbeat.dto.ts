import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString } from "class-validator";

export class WatchHeartbeatDto {
  @ApiProperty({ description: "ID phim đang xem" })
  @IsString()
  @IsNotEmpty()
  movieId!: string;

  @ApiProperty({ description: "ID tập phim đang xem" })
  @IsString()
  @IsNotEmpty()
  episodeId!: string;

  @ApiProperty({ description: "Vị trí giây hiện tại của video", required: false })
  @IsNumber()
  @IsOptional()
  currentSeconds?: number;

  @ApiProperty({ description: "Tab trình duyệt có đang active không (document.hidden === false)" })
  @IsBoolean()
  activeTab!: boolean;
}

