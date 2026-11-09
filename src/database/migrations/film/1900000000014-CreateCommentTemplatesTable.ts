import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateCommentTemplatesTable1900000000014 implements MigrationInterface {
  name = "CreateCommentTemplatesTable1900000000014";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "comment_templates" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "type" character varying(100) NOT NULL,
        "message" text NOT NULL,
        "display_order" integer NOT NULL DEFAULT 0,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_comment_templates_id" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_comment_templates_type" ON "comment_templates" ("type");
    `);

    const templates = [
      { type: "Khen phim", message: "Có mắt nhìn đấy, bổn tọa thích!" },
      { type: "Khen phim", message: "Đạo hữu cũng nghiện rồi à?" },
      { type: "Hóng tập mới", message: "Gấp gì? Tu tiên cần kiên nhẫn!" },
      { type: "Giục phim", message: "Giục nữa bổn tọa tẩu hỏa đấy!" },
      { type: "Giục phim", message: "Ngươi định ép bổn tọa phi thăng à?" },
      { type: "Phim quá cuốn", message: "Coi chừng nghiện, bổn tọa không cứu!" },
      { type: "Phim hài", message: "Cười ít thôi, rớt Kim Đan giờ!" },
      { type: "Chê phim", message: "Khẩu vị ngươi khó chiều thật!" },
      { type: "Báo lỗi", message: "Kẻ nào dám phá trận pháp của ta!" },
      { type: "Cảm ơn", message: "Miễn lễ, lui xuống cày phim tiếp!" },
      { type: "Xin thêm phim", message: "Tham lam! Nhưng bổn tọa thích!" },
      { type: "Bình luận vui", message: "Ngươi đến tu tiên hay tấu hài?" },
      { type: "Bình luận vui", message: "Lá gan không nhỏ đấy!" },
      { type: "Đòi phần tiếp", message: "Bổn tọa còn đang hóng hơn ngươi!" },
      { type: "Xem xuyên đêm", message: "Tu vi chưa tăng, thâm mắt đã tăng!" },
      { type: "Chào thành viên", message: "Vào Ma Vực rồi thì khó thoát lắm!" },
    ];

    for (let i = 0; i < templates.length; i++) {
      const t = templates[i];
      await queryRunner.query(
        `INSERT INTO "comment_templates" ("type", "message", "display_order")
         SELECT $1, $2, $3
         WHERE NOT EXISTS (SELECT 1 FROM "comment_templates" WHERE "message" = $2);`,
        [t.type, t.message, i + 1],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "comment_templates";`);
  }
}

