import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString } from "class-validator";

export class SendTestMessageDto {
  @ApiPropertyOptional({ description: "Bot Token tạm thời nếu chưa lưu vào DB" })
  @IsOptional()
  @IsString()
  botToken?: string;

  @ApiProperty({ description: "Chat ID người nhận" })
  @IsNotEmpty({ message: "Chat ID không được để trống" })
  @IsString()
  chatId!: string;

  @ApiPropertyOptional({ description: "Nội dung tin nhắn thử nghiệm" })
  @IsOptional()
  @IsString()
  message?: string;
}

