import { BadRequestException, Injectable } from "@nestjs/common";

import { ExecuteImageDto } from "./dto/execute-image.dto";

@Injectable()
export class VideosImageService {
  /** Placeholder — socket flow sẵn sàng khi có provider ảnh. */
  async executeImage(_dto: ExecuteImageDto): Promise<{ images: unknown[] }> {
    throw new BadRequestException("Image generation chưa hỗ trợ — đang phát triển");
  }
}
