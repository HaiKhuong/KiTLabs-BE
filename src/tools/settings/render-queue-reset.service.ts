import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectDataSource } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { DataSource } from "typeorm";

import { RenderProcessRegistry } from "../../common/process/render-process-registry";
import { AUDIO_QUEUE_NAME } from "../audio/audio.service";
import { IMAGE_EDIT_QUEUE_NAME } from "../image-edit/image-edit.constants";
import { NARRATO_QUEUE_NAME } from "../narrato/narrato.service";
import { RECAP_QUEUE_NAME } from "../recap/recap.service";
import { SHORTVIDEO_QUEUE_NAME } from "../shortvideo/shortvideo.service";
import { TRANSLATE_QUEUE_NAME } from "../translate/translate.service";
import { WHITEBOARD_QUEUE_NAME } from "../whiteboard/whiteboard.service";

const RENDER_QUEUE_NAMES = [
  TRANSLATE_QUEUE_NAME,
  RECAP_QUEUE_NAME,
  NARRATO_QUEUE_NAME,
  AUDIO_QUEUE_NAME,
  SHORTVIDEO_QUEUE_NAME,
  WHITEBOARD_QUEUE_NAME,
  IMAGE_EDIT_QUEUE_NAME,
] as const;

const HISTORY_TABLES = [
  "translate_histories",
  "recap_histories",
  "narrato_histories",
  "audio_histories",
  "short_video_histories",
  "whiteboard_histories",
  "image_edit_histories",
  "image_histories",
  "video_histories",
] as const;

const CLEARED_MESSAGE = "Đã xóa hàng chờ khi khởi động lại ứng dụng";

@Injectable()
export class RenderQueueResetService {
  private readonly logger = new Logger(RenderQueueResetService.name);

  constructor(
    @InjectQueue(TRANSLATE_QUEUE_NAME) private readonly translateQueue: Queue,
    @InjectQueue(RECAP_QUEUE_NAME) private readonly recapQueue: Queue,
    @InjectQueue(NARRATO_QUEUE_NAME) private readonly narratoQueue: Queue,
    @InjectQueue(AUDIO_QUEUE_NAME) private readonly audioQueue: Queue,
    @InjectQueue(SHORTVIDEO_QUEUE_NAME) private readonly shortVideoQueue: Queue,
    @InjectQueue(WHITEBOARD_QUEUE_NAME) private readonly whiteboardQueue: Queue,
    @InjectQueue(IMAGE_EDIT_QUEUE_NAME) private readonly imageEditQueue: Queue,
    @InjectDataSource("tool") private readonly dataSource: DataSource,
    private readonly renderProcessRegistry: RenderProcessRegistry,
  ) {}

  async clearForRelaunch(): Promise<{ queues: string[]; histories: number }> {
    const queues = this.queues();
    for (const queue of queues) {
      await queue.pause();
    }
    await this.obliterate(queues);
    this.renderProcessRegistry.killAll();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await this.obliterate(queues);
    for (const queue of queues) {
      try {
        await queue.resume();
      } catch {
        /* pause flag is removed with the queue keys */
      }
    }
    const histories = await this.failOpenHistories();
    this.logger.warn(`Cleared render queues before relaunch (${histories} open histories)`);
    return { queues: [...RENDER_QUEUE_NAMES], histories };
  }

  private queues(): Queue[] {
    return [
      this.translateQueue,
      this.recapQueue,
      this.narratoQueue,
      this.audioQueue,
      this.shortVideoQueue,
      this.whiteboardQueue,
      this.imageEditQueue,
    ];
  }

  private async obliterate(queues: Queue[]): Promise<void> {
    for (const queue of queues) {
      try {
        await queue.obliterate({ force: true });
      } catch (error) {
        this.logger.warn(`Queue ${queue.name} obliterate failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async failOpenHistories(): Promise<number> {
    let updated = 0;
    for (const table of HISTORY_TABLES) {
      try {
        const rows = (await this.dataSource.query(
          `UPDATE "${table}"
           SET status = 'failed', error_message = $1, updated_at = NOW()
           WHERE status::text IN ('pending', 'running')
           RETURNING id`,
          [CLEARED_MESSAGE],
        )) as unknown;
        updated += Array.isArray(rows) ? rows.length : 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/does not exist|undefined_table/i.test(message)) {
          this.logger.warn(`Could not clear ${table}: ${message}`);
        }
      }
    }
    return updated;
  }
}
