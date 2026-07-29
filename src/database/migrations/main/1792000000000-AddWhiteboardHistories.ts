import { MigrationInterface, QueryRunner, Table } from "typeorm";

export class AddWhiteboardHistories1792000000000 implements MigrationInterface {
  name = "AddWhiteboardHistories1792000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: "whiteboard_histories",
        columns: [
          { name: "id", type: "uuid", isPrimary: true, default: "gen_random_uuid()" },
          { name: "user_id", type: "uuid" },
          { name: "node_id", type: "varchar", length: "255", isNullable: true },
          { name: "display_name", type: "varchar", length: "255" },
          { name: "source_image_file_name", type: "varchar", length: "512", isNullable: true },
          { name: "image_width", type: "integer", isNullable: true },
          { name: "image_height", type: "integer", isNullable: true },
          { name: "scene_json", type: "jsonb", isNullable: true },
          { name: "path_plan", type: "jsonb", isNullable: true },
          { name: "engine_config", type: "jsonb", isNullable: true },
          {
            name: "status",
            type: "enum",
            enum: ["pending", "running", "completed", "failed"],
            default: "'pending'",
          },
          { name: "result_path", type: "varchar", isNullable: true },
          { name: "result_file_name", type: "varchar", isNullable: true },
          { name: "error_message", type: "text", isNullable: true },
          { name: "queue_job_id", type: "varchar", isNullable: true },
          { name: "render_started_at", type: "timestamp", isNullable: true },
          { name: "render_finished_at", type: "timestamp", isNullable: true },
          { name: "render_duration_ms", type: "integer", isNullable: true },
          { name: "created_at", type: "timestamp", default: "now()" },
          { name: "updated_at", type: "timestamp", default: "now()" },
        ],
        foreignKeys: [
          {
            columnNames: ["user_id"],
            referencedTableName: "users",
            referencedColumnNames: ["id"],
            onDelete: "CASCADE",
          },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("whiteboard_histories");
  }
}
