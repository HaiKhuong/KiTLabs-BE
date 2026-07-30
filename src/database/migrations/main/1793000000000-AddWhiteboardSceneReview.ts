import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

export class AddWhiteboardSceneReview1793000000000 implements MigrationInterface {
  name = "AddWhiteboardSceneReview1793000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns("whiteboard_histories", [
      new TableColumn({ name: "assets_dir", type: "varchar", length: "1024", isNullable: true }),
      new TableColumn({ name: "analyzed_at", type: "timestamp", isNullable: true }),
    ]);

    // Earlier rows kept the upload directory inside scene_json; lift it into the column.
    await queryRunner.query(`
      UPDATE "whiteboard_histories"
      SET "assets_dir" = "scene_json"->>'assetsDir'
      WHERE "scene_json" ? 'assetsDir'
    `);
    await queryRunner.query(`
      UPDATE "whiteboard_histories"
      SET "scene_json" = "scene_json" - 'assetsDir'
      WHERE "scene_json" ? 'assetsDir'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumns("whiteboard_histories", ["assets_dir", "analyzed_at"]);
  }
}
