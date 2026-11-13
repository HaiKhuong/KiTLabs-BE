import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { sheets_v4 } from "googleapis";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

export const GOOGLE_SHEETS_AUTH_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export interface GoogleServiceAccountCredentials {
  type?: string;
  project_id?: string;
  private_key_id?: string;
  private_key?: string;
  client_email?: string;
  client_id?: string;
  auth_uri?: string;
  token_uri?: string;
  auth_provider_x509_cert_url?: string;
  client_x509_cert_url?: string;
  universe_domain?: string;
}

export interface AppendRowsOptions {
  spreadsheetId: string;
  sheetName?: string;
  headers?: string[];
  rows: (string | number | boolean)[][];
  userCredentials?: string;
}

export interface AppendRowsResult {
  spreadsheetId: string;
  spreadsheetTitle: string;
  sheetName: string;
  updatedRows: number;
  updatedRange: string;
  spreadsheetUrl: string;
}

export interface VerifyConnectionResult {
  spreadsheetId: string;
  title: string;
  sheetNames: string[];
  clientEmail: string;
}

@Injectable()
export class GoogleSheetsService {
  private readonly logger = new Logger(GoogleSheetsService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Trích xuất ID Spreadsheet từ ID thô hoặc full URL
   * Ví dụ: https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#gid=0
   * -> 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms
   */
  extractSpreadsheetId(input: string): string {
    const trimmed = input.trim();
    if (!trimmed) return "";

    const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (match && match[1]) {
      return match[1];
    }
    // Nếu truyền trực tiếp ID
    if (/^[a-zA-Z0-9-_]{20,}$/.test(trimmed)) {
      return trimmed;
    }
    return trimmed;
  }

  /**
   * Lấy credentials Google Service Account (ưu tiên từ user, sau đó là system config)
   */
  resolveCredentials(userCredentials?: string): GoogleServiceAccountCredentials {
    // 1. Thử từ userCredentials đã cấu hình
    if (userCredentials?.trim()) {
      try {
        const parsed = JSON.parse(userCredentials.trim()) as GoogleServiceAccountCredentials;
        if (parsed.client_email && parsed.private_key) {
          return parsed;
        }
      } catch {
        this.logger.warn("User credentials is not a valid JSON");
      }
    }

    // 2. Thử từ GOOGLE_SERVICE_ACCOUNT_JSON trong env
    const rawJson = this.config.get<string>("GOOGLE_SERVICE_ACCOUNT_JSON") || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (rawJson?.trim()) {
      try {
        const parsed = JSON.parse(rawJson.trim()) as GoogleServiceAccountCredentials;
        if (parsed.client_email && parsed.private_key) {
          return parsed;
        }
      } catch {
        this.logger.warn("GOOGLE_SERVICE_ACCOUNT_JSON in env is not valid JSON");
      }
    }

    // 3. Thử từ file GOOGLE_APPLICATION_CREDENTIALS
    const filePath = this.config.get<string>("GOOGLE_APPLICATION_CREDENTIALS") || process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (filePath && existsSync(filePath)) {
      try {
        const fileContent = readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(fileContent) as GoogleServiceAccountCredentials;
        if (parsed.client_email && parsed.private_key) {
          return parsed;
        }
      } catch (err) {
        this.logger.warn(`Could not read GOOGLE_APPLICATION_CREDENTIALS file: ${err}`);
      }
    }

    // 4. Thử từ GOOGLE_SHEETS_CLIENT_EMAIL và GOOGLE_SHEETS_PRIVATE_KEY
    const clientEmail = this.config.get<string>("GOOGLE_SHEETS_CLIENT_EMAIL") || process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
    const rawPrivateKey = this.config.get<string>("GOOGLE_SHEETS_PRIVATE_KEY") || process.env.GOOGLE_SHEETS_PRIVATE_KEY;
    if (clientEmail?.trim() && rawPrivateKey?.trim()) {
      const privateKey = rawPrivateKey.replace(/\\n/g, "\n");
      return {
        client_email: clientEmail.trim(),
        private_key: privateKey,
        type: "service_account",
      };
    }

    // 5. Thử tìm tệp service account trong thư mục secrets/ trên ổ đĩa
    const candidatePaths = [
      join(process.cwd(), "secrets", "seismic-lexicon-498906-j2-419ade361f1c.json"),
      join(__dirname, "..", "..", "..", "secrets", "seismic-lexicon-498906-j2-419ade361f1c.json"),
      join(__dirname, "..", "..", "secrets", "seismic-lexicon-498906-j2-419ade361f1c.json"),
    ];
    for (const p of candidatePaths) {
      if (existsSync(p)) {
        try {
          const parsed = JSON.parse(readFileSync(p, "utf-8")) as GoogleServiceAccountCredentials;
          if (parsed.client_email && parsed.private_key) return parsed;
        } catch {}
      }
    }

    throw new BadRequestException(
      "Chưa cấu hình Google Service Account JSON. Vui lòng gửi tệp .json credentials vào Bot hoặc dùng lệnh /credentials.",
    );
  }

  /**
   * Lấy client email hiện tại để hướng dẫn người dùng share file
   */
  getClientEmail(userCredentials?: string): string | null {
    try {
      const creds = this.resolveCredentials(userCredentials);
      return creds.client_email || null;
    } catch {
      return null;
    }
  }

  /**
   * Khởi tạo Google Sheets Client với Scope https://www.googleapis.com/auth/spreadsheets
   */
  private getSheetsClient(userCredentials?: string): {
    sheets: sheets_v4.Sheets;
    clientEmail: string;
  } {
    const creds = this.resolveCredentials(userCredentials);

    const { sheets: createSheets, auth: googleAuth } = require("googleapis/build/src/apis/sheets");

    const auth = new googleAuth.GoogleAuth({
      credentials: {
        client_email: creds.client_email,
        private_key: (creds.private_key || "").includes("\\n") ? (creds.private_key || "").replace(/\\n/g, "\n") : creds.private_key,
        project_id: creds.project_id,
      },
      scopes: [GOOGLE_SHEETS_AUTH_SCOPE],
    });

    const sheets = createSheets({ version: "v4", auth });
    return { sheets, clientEmail: creds.client_email || "N/A" };
  }

  /**
   * Kiểm tra kết nối tới file Spreadsheet
   */
  async verifyConnection(
    spreadsheetInput: string,
    userCredentials?: string,
  ): Promise<VerifyConnectionResult> {
    const spreadsheetId = this.extractSpreadsheetId(spreadsheetInput);
    if (!spreadsheetId) {
      throw new BadRequestException("ID hoặc URL Google Sheet không hợp lệ.");
    }

    const { sheets, clientEmail } = this.getSheetsClient(userCredentials);

    try {
      const res = await sheets.spreadsheets.get({ spreadsheetId });
      const title = res.data.properties?.title || "Không có tiêu đề";
      const sheetNames = (res.data.sheets ?? [])
        .map((s) => s.properties?.title)
        .filter((t): t is string => Boolean(t));

      return {
        spreadsheetId,
        title,
        sheetNames,
        clientEmail,
      };
    } catch (err: unknown) {
      this.handleGoogleError(err, clientEmail, spreadsheetId);
    }
  }

  /**
   * Thêm (append) các dòng dữ liệu vào Google Sheet
   */
  async appendRows(options: AppendRowsOptions): Promise<AppendRowsResult> {
    const spreadsheetId = this.extractSpreadsheetId(options.spreadsheetId);
    if (!spreadsheetId) {
      throw new BadRequestException("ID hoặc URL Google Sheet không hợp lệ.");
    }

    if (!options.rows || options.rows.length === 0) {
      throw new BadRequestException("Không có dữ liệu dòng nào để ghi vào Google Sheet.");
    }

    const { sheets, clientEmail } = this.getSheetsClient(options.userCredentials);

    try {
      // 1. Lấy thông tin sheet để xác định tab mục tiêu
      const metaRes = await sheets.spreadsheets.get({ spreadsheetId });
      const spreadsheetTitle = metaRes.data.properties?.title || "Bảng tính";
      const availableSheets = (metaRes.data.sheets ?? [])
        .map((s) => s.properties?.title)
        .filter((t): t is string => Boolean(t));

      let targetSheet = options.sheetName?.trim() || "";
      if (!targetSheet) {
        targetSheet = availableSheets[0] || "Sheet1";
      } else if (!availableSheets.includes(targetSheet) && availableSheets.length > 0) {
        // Nếu tên tab user đặt không tồn tại, kiểm tra xem có thể tự động tạo hoặc fallback tab đầu tiên
        targetSheet = availableSheets[0];
      }

      // 2. Kiểm tra xem sheet hiện tại đã có dòng nào chưa (kiểm tra dòng A1:Z1)
      let shouldAddHeaders = false;
      if (options.headers && options.headers.length > 0) {
        try {
          const checkHeaderRes = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `'${targetSheet}'!A1:Z1`,
          });
          const existingValues = checkHeaderRes.data.values;
          if (!existingValues || existingValues.length === 0) {
            shouldAddHeaders = true;
          }
        } catch {
          // Bỏ qua lỗi kiểm tra header
        }
      }

      const rowsToInsert: (string | number | boolean)[][] = [];
      if (shouldAddHeaders && options.headers) {
        rowsToInsert.push(options.headers);
      }
      rowsToInsert.push(...options.rows);

      // 3. Thực hiện thao tác Edit/Append vào Google Sheet
      const appendRes = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `'${targetSheet}'!A1`,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: {
          values: rowsToInsert,
        },
      });

      const updatedRows = appendRes.data.updates?.updatedRows ?? options.rows.length;
      const updatedRange = appendRes.data.updates?.updatedRange ?? `'${targetSheet}'!A1`;
      const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;

      return {
        spreadsheetId,
        spreadsheetTitle,
        sheetName: targetSheet,
        updatedRows,
        updatedRange,
        spreadsheetUrl,
      };
    } catch (err: unknown) {
      this.handleGoogleError(err, clientEmail, spreadsheetId);
    }
  }

  private handleGoogleError(err: unknown, clientEmail: string, spreadsheetId: string): never {
    const errorMsg = (err as Error)?.message || String(err);

    if (errorMsg.includes("caller does not have permission") || errorMsg.includes("403")) {
      throw new BadRequestException(
        `❌ Quyền truy cập bị từ chối (403 Forbidden)!\n\n` +
          `👉 Bạn cần mở file Google Sheet sau:\n` +
          `https://docs.google.com/spreadsheets/d/${spreadsheetId}\n\n` +
          `Bấm nút **Chia sẻ (Share)** và thêm email Service Account sau với quyền **Người chỉnh sửa (Editor)**:\n` +
          `\`${clientEmail}\``,
      );
    }

    if (errorMsg.includes("Requested entity was not found") || errorMsg.includes("404")) {
      throw new BadRequestException(
        `❌ Không tìm thấy Google Sheet với ID: \`${spreadsheetId}\`.\n` +
          `Vui lòng kiểm tra lại đường link hoặc Sheet ID của bạn.`,
      );
    }

    this.logger.error(`Google Sheets API error: ${errorMsg}`, (err as Error)?.stack);
    throw new BadRequestException(`Lỗi thao tác Google Sheets: ${errorMsg}`);
  }
}

