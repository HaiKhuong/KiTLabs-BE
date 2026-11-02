import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPlatformAdminUsersAndRoles1800000000001 implements MigrationInterface {
  name = "AddPlatformAdminUsersAndRoles1800000000001";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // 1. Table platform_admin_roles
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "platform_admin_roles" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "code" character varying(50) NOT NULL,
        "name" character varying(100) NOT NULL,
        "description" text,
        "is_system" boolean NOT NULL DEFAULT false,
        "permissions" jsonb NOT NULL DEFAULT '{}'::jsonb,
        CONSTRAINT "PK_platform_admin_roles" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_platform_admin_roles_code" UNIQUE ("code")
      )
    `);

    // 2. Table platform_admin_users
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "platform_admin_users" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "user_name" character varying(100) NOT NULL,
        "email" character varying(150) NOT NULL,
        "password_hash" character varying(255) NOT NULL,
        "full_name" character varying(150),
        "phone" character varying(30),
        "avatar_url" character varying(255),
        "role_id" uuid,
        "is_super_admin" boolean NOT NULL DEFAULT false,
        "is_active" boolean NOT NULL DEFAULT true,
        "last_login_at" TIMESTAMP WITH TIME ZONE,
        "refresh_token_hash" character varying(255),
        CONSTRAINT "PK_platform_admin_users" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_platform_admin_users_user_name" UNIQUE ("user_name"),
        CONSTRAINT "UQ_platform_admin_users_email" UNIQUE ("email"),
        CONSTRAINT "FK_platform_admin_users_role" FOREIGN KEY ("role_id") REFERENCES "platform_admin_roles"("id") ON DELETE SET NULL
      )
    `);

    // 3. Seed default SUPER_ADMIN role
    const fullPermissions = JSON.stringify({
      movies: { create: true, read: true, update: true, delete: true },
      genres: { create: true, read: true, update: true, delete: true },
      banners: { create: true, read: true, update: true, delete: true },
      missions: { create: true, read: true, update: true, delete: true },
      comments: { create: true, read: true, update: true, delete: true },
      reports: { create: true, read: true, update: true, delete: true },
      users: { create: true, read: true, update: true, delete: true },
      admin_users: { create: true, read: true, update: true, delete: true },
      roles: { create: true, read: true, update: true, delete: true },
      settings: { create: true, read: true, update: true, delete: true },
    });

    const roleResult = await queryRunner.query(`
      INSERT INTO "platform_admin_roles" ("code", "name", "description", "is_system", "permissions")
      VALUES ('SUPER_ADMIN', 'Quản trị viên tối cao', 'Toàn quyền quản trị hệ thống', true, '${fullPermissions}')
      ON CONFLICT ("code") DO UPDATE SET "permissions" = EXCLUDED."permissions"
      RETURNING "id"
    `);

    const roleId = roleResult?.[0]?.id;

    // 4. Seed default super admin user (admin / admin@kitlabs.io / Admin@123456)
    const defaultPasswordHash = "$2b$10$McisxI1X9G/174IIQ1mq9uSGUFC7QE5rulN2I9i.FSfZ8OrbkH9ZW";

    if (roleId) {
      await queryRunner.query(`
        INSERT INTO "platform_admin_users" ("user_name", "email", "password_hash", "full_name", "role_id", "is_super_admin", "is_active")
        VALUES ('admin', 'admin@kitlabs.io', '${defaultPasswordHash}', 'Platform Super Admin', '${roleId}', true, true)
        ON CONFLICT ("user_name") DO UPDATE SET
          "email" = EXCLUDED."email",
          "role_id" = EXCLUDED."role_id",
          "is_super_admin" = true,
          "is_active" = true
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "platform_admin_users" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "platform_admin_roles" CASCADE`);
  }
}

