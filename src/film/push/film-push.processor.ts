import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";
import { FILM_PUSH_QUEUE, FilmPushJobData, FilmPushService } from "./film-push.service";

@Processor(FILM_PUSH_QUEUE)
export class FilmPushProcessor extends WorkerHost {
  private readonly logger = new Logger(FilmPushProcessor.name);

  constructor(private readonly pushService: FilmPushService) {
    super();
  }

  async process(job: Job<FilmPushJobData>) {
    const result = await this.pushService.dispatchJob(job.data);
    this.logger.log(
      `Processed film-push job ${job.id} (${job.data.kind}): sent=${result.sent}, failed=${result.failed}, total=${result.totalTokens}`,
    );
    return result;
  }
}
